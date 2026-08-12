/**
 * taskVerifier.js — BeeyGO Task Verification Engine
 *
 * Exports pure async functions for each verification strategy.
 * Designed to be imported by server.js and called inside locked DB transactions.
 *
 * Verification types:
 *   auto          — instant reward, no external check
 *   telegram_join — getChatMember API: confirms user is in a Telegram channel/group
 *   telegram_dm   — one-time 6-char code sent to user via bot DM, user returns it
 *   code_submit   — user submits a proof URL/text, stored for optional admin review
 */

const crypto = require('crypto');

// Bot username shown to users in messages (set BOT_USERNAME env var or default to @BYGObot)
const BOT_USERNAME = process.env.BOT_USERNAME || '@BYGObot';

// DM challenge re-issuance cooldown (seconds). Prevents code spam abuse.
const DM_COOLDOWN_SECONDS = 60;

// ─── Telegram Bot API helper ──────────────────────────────────────────────────

/**
 * Low-level Telegram Bot API call.
 * Uses Node's built-in fetch (Node 18+) or falls back to http.
 */
async function tgApi(botToken, method, params = {}) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await response.json();
  return data;
}

// ─── Strategy 1: telegram_join ────────────────────────────────────────────────

/**
 * Verify that a Telegram user is currently a member of a channel/group.
 *
 * @param {string} botToken
 * @param {string|number} chatId   - channel username (@handle) or numeric chat ID
 * @param {string|number} userId   - user's Telegram ID
 * @returns {{ pass: boolean, status: string, error?: string }}
 */
async function verifyTelegramMembership(botToken, chatId, userId) {
  try {
    const res = await tgApi(botToken, 'getChatMember', {
      chat_id: chatId,
      user_id: parseInt(userId, 10),
    });

    if (!res.ok) {
      // Common errors: bot not in channel, channel not found, user never interacted
      const errCode = res.error_code;
      if (errCode === 400) {
        return { pass: false, status: 'not_found', error: 'Channel not found or bot is not a member of it.' };
      }
      return { pass: false, status: 'api_error', error: res.description || 'Telegram API error.' };
    }

    const { status } = res.result;
    // 'creator' | 'administrator' | 'member' → pass
    // 'restricted' | 'left' | 'kicked'       → fail

    // For 'restricted', check if the user still has access (not banned)
    if (status === 'restricted') {
      const member = res.result;
      const hasMembership = member.is_member !== false;
      return { pass: hasMembership, status };
    }

    const isMember = ['creator', 'administrator', 'member'].includes(status);
    return { pass: isMember, status };
  } catch (err) {
    console.error('[Verifier] Telegram membership check error:', err.message);
    return { pass: false, status: 'network_error', error: 'Failed to reach Telegram API.' };
  }
}

// ─── Strategy 2: telegram_dm — challenge issuance ─────────────────────────────

/**
 * Generate a cryptographically random 6-character alphanumeric challenge code.
 */
function generateChallengeCode() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O, 0, I, 1 for readability
  let code = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += charset[bytes[i] % charset.length];
  }
  return code;
}

/**
 * Issue a DM challenge to the user via the bot.
 * Stores the code in user_tasks.verification_token with a 15-minute expiry.
 *
 * Cooldown guard: if a code was issued within the last DM_COOLDOWN_SECONDS, returns
 * { success: false, cooldown: true, retryAfterMs } without sending a new code.
 *
 * @param {string} botToken
 * @param {string|number} telegramUserId
 * @param {number} taskId
 * @param {string} taskTitle
 * @param {object} pool - pg pool for DB write
 * @returns {{ success: boolean, cooldown?: boolean, retryAfterMs?: number, code?: string, error?: string }}
 */
async function issueDMChallenge(botToken, telegramUserId, taskId, taskTitle, pool) {
  // ── Cooldown guard: check for a recently-issued, unexpired code ──────────────
  try {
    const existing = await pool.query(
      `SELECT verification_token, token_expires_at, created_at
       FROM user_tasks
       WHERE user_id = $1 AND task_id = $2 AND status = 'pending'
         AND verification_token IS NOT NULL
         AND token_expires_at > NOW()`,
      [telegramUserId, taskId]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      // Estimate when the code was created: if token_expires_at is known and TTL is 15 min,
      // issued_at ≈ token_expires_at − 15 min. Use that to enforce cooldown.
      const expiresAt = new Date(row.token_expires_at);
      const issuedAt = new Date(expiresAt.getTime() - 15 * 60 * 1000);
      const elapsedMs = Date.now() - issuedAt.getTime();
      const cooldownMs = DM_COOLDOWN_SECONDS * 1000;

      if (elapsedMs < cooldownMs) {
        const retryAfterMs = cooldownMs - elapsedMs;
        return { success: false, cooldown: true, retryAfterMs };
      }
      // Code exists but cooldown has passed — allow re-issue (falls through)
    }
  } catch (err) {
    console.error('[Verifier] Cooldown check error:', err.message);
    // Non-fatal: allow issuance to proceed
  }

  // ── Generate and store new challenge code ────────────────────────────────────
  const code = generateChallengeCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min TTL

  try {
    await pool.query(`
      INSERT INTO user_tasks (user_id, task_id, status, verification_token, token_expires_at)
      VALUES ($1, $2, 'pending', $3, $4)
      ON CONFLICT (user_id, task_id) DO UPDATE
      SET verification_token = $3, token_expires_at = $4, status = 'pending'
    `, [telegramUserId, taskId, code, expiresAt]);
  } catch (err) {
    console.error('[Verifier] Failed to store DM challenge code:', err.message);
    return { success: false, error: 'Database error storing challenge.' };
  }

  // ── Send the DM ──────────────────────────────────────────────────────────────
  const message =
    `🔐 *BYGO Task Verification*\n\n` +
    `Task: *${taskTitle}*\n\n` +
    `Your one-time verification code:\n\n` +
    `\`${code}\`\n\n` +
    `Enter this code in the BeeyGO app within *15 minutes* to claim your reward.\n` +
    `_Do not share this code with anyone._`;

  const dmRes = await tgApi(botToken, 'sendMessage', {
    chat_id: telegramUserId,
    text: message,
    parse_mode: 'Markdown',
  });

  if (!dmRes.ok) {
    console.error('[Verifier] Failed to send DM challenge:', dmRes.description);
    // Bot can only send DMs to users who have started a conversation with it
    const errMsg = dmRes.error_code === 403
      ? `Please start a conversation with ${BOT_USERNAME} first by sending it /start, then try again.`
      : 'Failed to send verification code. Please try again.';
    return { success: false, error: errMsg };
  }

  return { success: true, code }; // code returned for logging only, not sent to client
}

/**
 * Verify a user-submitted DM challenge code against the stored token.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param {string} submittedCode
 * @param {string} storedCode
 * @param {Date|null} expiresAt
 * @returns {{ pass: boolean, reason?: string }}
 */
function verifyDMChallenge(submittedCode, storedCode, expiresAt) {
  if (!storedCode) {
    return { pass: false, reason: 'No challenge issued. Please request a code first.' };
  }
  if (expiresAt && new Date() > new Date(expiresAt)) {
    return { pass: false, reason: 'Verification code has expired. Please request a new one.' };
  }
  // Constant-time comparison
  const sub    = Buffer.from(submittedCode.trim().toUpperCase().padEnd(20));
  const stored = Buffer.from(storedCode.trim().toUpperCase().padEnd(20));
  const match  = sub.length === stored.length && crypto.timingSafeEqual(sub, stored);
  return match
    ? { pass: true }
    : { pass: false, reason: 'Incorrect code. Please check the code in your Telegram DMs.' };
}

// ─── Bot notification ─────────────────────────────────────────────────────────

/**
 * Send a success notification DM to the user after reward is granted.
 *
 * @param {string} botToken
 * @param {string|number} telegramUserId
 * @param {string} taskTitle
 * @param {number} reward
 */
async function sendRewardNotification(botToken, telegramUserId, taskTitle, reward) {
  const message =
    `✅ *Task Completed!*\n\n` +
    `*${taskTitle}*\n\n` +
    `You've earned *+${reward} $BYGO* 🎉\n` +
    `Your balance has been updated.\n\n` +
    `Keep earning in the BeeyGO app!`;

  tgApi(botToken, 'sendMessage', {
    chat_id: telegramUserId,
    text: message,
    parse_mode: 'Markdown',
  }).catch(e => console.warn('[Verifier] Could not send reward notification DM:', e.message));
}

// ─── Audit logging ────────────────────────────────────────────────────────────

/**
 * Write a verification attempt to the audit log table.
 *
 * @param {object} pool
 * @param {string|number} userId
 * @param {number} taskId
 * @param {string} verificationType
 * @param {'pass'|'fail'|'pending'} result
 * @param {string} detail
 */
async function logVerification(pool, userId, taskId, verificationType, result, detail) {
  try {
    await pool.query(
      `INSERT INTO task_verification_log (user_id, task_id, verification_type, result, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, taskId, verificationType, result, detail]
    );
  } catch (err) {
    // Non-critical — log but don't block
    console.error('[Verifier] Failed to write audit log:', err.message);
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  verifyTelegramMembership,
  issueDMChallenge,
  verifyDMChallenge,
  sendRewardNotification,
  logVerification,
  tgApi,
  BOT_USERNAME,
};
