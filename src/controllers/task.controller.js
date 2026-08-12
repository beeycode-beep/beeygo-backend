const { pool, query } = require('../config/db');
const ApiError = require('../middlewares/ApiError');
const {
  verifyTelegramMembership,
  issueDMChallenge,
  verifyDMChallenge,
  sendRewardNotification,
  logVerification,
  BOT_USERNAME,
} = require('../../taskVerifier');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tasks
// ─────────────────────────────────────────────────────────────────────────────
exports.getTasks = async (req, res) => {
  // Auto-delete expired tasks inline (opportunistic cleanup on every fetch)
  await query(`
    DELETE FROM tasks
    WHERE expires_at IS NOT NULL AND expires_at < NOW()
  `).catch(e => console.warn('[Tasks] Inline expiry cleanup failed:', e.message));

  const result = await query(
    `SELECT t.id, t.title, t.description, t.reward, t.link, t.platform,
            t.active, t.verification_type, t.chat_id, t.expires_at,
            COALESCE(ut.status, 'pending') AS status
     FROM tasks t
     LEFT JOIN user_tasks ut ON t.id = ut.task_id AND ut.user_id = $1
     WHERE t.active = true
       AND (t.expires_at IS NULL OR t.expires_at > NOW())
     ORDER BY t.created_at DESC`,
    [req.user.telegram_id]
  );
  res.json({ success: true, tasks: result.rows });
};

// ─────────────────────────────────────────────────────────────────────────────
// Cron: Hard-delete all expired tasks (called by /api/cron/cleanup-tasks)
// ─────────────────────────────────────────────────────────────────────────────
exports.cleanupExpiredTasks = async (req, res) => {
  const result = await query(`
    DELETE FROM tasks
    WHERE expires_at IS NOT NULL AND expires_at < NOW()
    RETURNING id, title
  `);
  const deleted = result.rows;
  console.log(`[Cron] Cleaned up ${deleted.length} expired task(s):`, deleted.map(t => `#${t.id} ${t.title}`).join(', ') || 'none');
  res.json({ success: true, deleted: deleted.length, tasks: deleted });
};


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tasks/:id/verify
// ─────────────────────────────────────────────────────────────────────────────
exports.verifyTask = async (req, res) => {
  const taskId     = parseInt(req.params.id, 10);
  const telegramId = req.user.telegram_id;

  if (isNaN(taskId)) throw ApiError.badRequest('Invalid task ID.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Fetch task
    const taskRes = await client.query(
      'SELECT id, title, reward, verification_type, chat_id FROM tasks WHERE id = $1 AND active = true',
      [taskId]
    );
    if (taskRes.rows.length === 0) throw ApiError.notFound('Task not found or inactive.');
    const task = taskRes.rows[0];
    const verificationType = task.verification_type || 'auto';

    // 2. Guard: already completed?
    const userTaskRes = await client.query(
      'SELECT status, verification_token, token_expires_at FROM user_tasks WHERE user_id = $1 AND task_id = $2 FOR UPDATE',
      [telegramId, taskId]
    );
    if (userTaskRes.rows.length > 0 && userTaskRes.rows[0].status === 'completed') {
      throw ApiError.conflict('Task already completed.');
    }

    // 3. Fetch reward multiplier from settings
    const settingsRes = await client.query('SELECT config FROM settings WHERE id = 1');
    const config      = settingsRes.rows[0]?.config || {};
    const multiplier  = config.taskRewardMultiplier || 1;
    const finalReward = Math.round(task.reward * multiplier);

    // ── A. telegram_join ─────────────────────────────────────────────────────
    if (verificationType === 'telegram_join') {
      if (!task.chat_id) throw ApiError.internal('Task misconfigured: no channel ID set.');

      const check = await verifyTelegramMembership(TELEGRAM_BOT_TOKEN, task.chat_id, telegramId);
      await logVerification(pool, telegramId, taskId, 'telegram_join',
        check.pass ? 'pass' : 'fail',
        `status=${check.status}${check.error ? ' | ' + check.error : ''}`
      );

      if (!check.pass) {
        await client.query('ROLLBACK');
        const hint =
          check.status === 'not_found' ? 'Channel not found. Please contact support.' :
          (check.status === 'left' || check.status === 'kicked') ? 'You must join the channel first, then verify.' :
          check.error || 'Membership verification failed.';
        throw ApiError.forbidden(hint);
      }

      await client.query(
        `INSERT INTO user_tasks (user_id, task_id, status, completed_at)
         VALUES ($1, $2, 'completed', CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, task_id) DO UPDATE SET status = 'completed', completed_at = CURRENT_TIMESTAMP`,
        [telegramId, taskId]
      );
      await client.query(
        'UPDATE users SET balance = balance + $1, total_claimed = total_claimed + $1 WHERE telegram_id = $2',
        [finalReward, telegramId]
      );
      await client.query('COMMIT');

      // Fire-and-forget notification (non-critical)
      sendRewardNotification(TELEGRAM_BOT_TOKEN, telegramId, task.title, finalReward)
        .catch(e => console.warn('[Tasks] Reward notification failed:', e.message));

      console.log(`[Verify:tg_join] User ${telegramId} verified task #${taskId} (+${finalReward} $BYGO)`);
      return res.json({ success: true, reward: finalReward });
    }

    // ── B. telegram_dm — step 1: issue challenge ──────────────────────────────
    if (verificationType === 'telegram_dm') {
      // Release the DB lock before waiting for Telegram DM (non-atomic step)
      await client.query('ROLLBACK');

      const issue = await issueDMChallenge(TELEGRAM_BOT_TOKEN, telegramId, taskId, task.title, pool);

      if (issue.cooldown) {
        throw Object.assign(ApiError.tooManyRequests('A code was recently sent. Please wait before requesting another.'), {
          retryAfterMs: issue.retryAfterMs,
        });
      }
      if (!issue.success) throw ApiError.internal(issue.error || 'Failed to send verification code via Telegram.');

      console.log(`[Verify:tg_dm] Issued DM challenge to user ${telegramId} for task #${taskId}`);
      return res.json({
        success: false,
        pending: true,
        message: `A verification code has been sent via ${BOT_USERNAME}. Enter it below to claim your reward.`,
      });
    }

    // ── C. code_submit — store proof, pending review ──────────────────────────
    if (verificationType === 'code_submit') {
      const proof = (req.body?.proof || '').trim();
      if (proof.length < 3) {
        await client.query('ROLLBACK');
        throw ApiError.badRequest('Please provide a valid proof URL or code (min 3 characters).');
      }

      await client.query(
        `INSERT INTO user_tasks (user_id, task_id, status, verification_token)
         VALUES ($1, $2, 'pending_review', $3)
         ON CONFLICT (user_id, task_id) DO UPDATE SET status = 'pending_review', verification_token = $3`,
        [telegramId, taskId, proof.substring(0, 300)]
      );
      await logVerification(pool, telegramId, taskId, 'code_submit', 'pending', `proof=${proof.substring(0, 100)}`);
      await client.query('COMMIT');

      console.log(`[Verify:code_submit] User ${telegramId} submitted proof for task #${taskId}`);
      return res.json({
        success: false,
        pending: true,
        message: 'Your proof has been submitted and is pending review. You will be notified when approved.',
      });
    }

    // ── D. auto — instant reward ──────────────────────────────────────────────
    // Small artificial delay to prevent rapid-fire abuse
    await new Promise(r => setTimeout(r, 800));

    await client.query(
      `INSERT INTO user_tasks (user_id, task_id, status, completed_at)
       VALUES ($1, $2, 'completed', CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, task_id) DO UPDATE SET status = 'completed', completed_at = CURRENT_TIMESTAMP`,
      [telegramId, taskId]
    );
    await client.query(
      'UPDATE users SET balance = balance + $1, total_claimed = total_claimed + $1 WHERE telegram_id = $2',
      [finalReward, telegramId]
    );
    await logVerification(pool, telegramId, taskId, 'auto', 'pass', 'instant');
    await client.query('COMMIT');

    console.log(`[Verify:auto] User ${telegramId} completed task #${taskId} (+${finalReward} $BYGO)`);
    return res.json({ success: true, reward: finalReward });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tasks/:id/dm-verify
// ─────────────────────────────────────────────────────────────────────────────
exports.verifyDMChallenge = async (req, res) => {
  const taskId     = parseInt(req.params.id, 10);
  const telegramId = req.user.telegram_id;
  const code       = (req.body?.code || '').trim();

  if (isNaN(taskId)) throw ApiError.badRequest('Invalid task ID.');
  if (!code) throw ApiError.badRequest('Verification code is required.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const taskRes = await client.query(
      'SELECT id, title, reward, verification_type FROM tasks WHERE id = $1 AND active = true',
      [taskId]
    );
    if (taskRes.rows.length === 0) throw ApiError.notFound('Task not found or inactive.');
    const task = taskRes.rows[0];

    if (task.verification_type !== 'telegram_dm') {
      throw ApiError.badRequest('This task does not use DM verification.');
    }

    const utRes = await client.query(
      'SELECT status, verification_token, token_expires_at FROM user_tasks WHERE user_id = $1 AND task_id = $2',
      [telegramId, taskId]
    );
    if (utRes.rows.length === 0 || !utRes.rows[0].verification_token) {
      throw ApiError.badRequest('No pending verification found. Please request a code first.');
    }

    const row = utRes.rows[0];
    if (row.status === 'completed') throw ApiError.conflict('Task already completed.');

    // Validate the submitted code
    const check = verifyDMChallenge(code, row.verification_token, row.token_expires_at);
    await logVerification(pool, telegramId, taskId, 'telegram_dm',
      check.pass ? 'pass' : 'fail', check.reason || 'code_match'
    );

    if (!check.pass) {
      await client.query('ROLLBACK');
      throw ApiError.forbidden(check.reason || 'Invalid or expired code.');
    }

    // Code correct — fetch reward multiplier and award
    const settingsRes = await client.query('SELECT config FROM settings WHERE id = 1');
    const config      = settingsRes.rows[0]?.config || {};
    const finalReward = Math.round(task.reward * (config.taskRewardMultiplier || 1));

    await client.query(
      `UPDATE user_tasks
       SET status = 'completed', verification_token = NULL, token_expires_at = NULL, completed_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND task_id = $2`,
      [telegramId, taskId]
    );
    await client.query(
      'UPDATE users SET balance = balance + $1, total_claimed = total_claimed + $1 WHERE telegram_id = $2',
      [finalReward, telegramId]
    );
    await client.query('COMMIT');

    sendRewardNotification(TELEGRAM_BOT_TOKEN, telegramId, task.title, finalReward)
      .catch(e => console.warn('[Tasks] Reward notification failed:', e.message));

    console.log(`[Verify:tg_dm] User ${telegramId} verified task #${taskId} (+${finalReward} $BYGO)`);
    return res.json({ success: true, reward: finalReward });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};
