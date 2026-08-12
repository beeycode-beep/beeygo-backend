require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { initDB, query, pool } = require('./db');
const {
  verifyTelegramMembership,
  issueDMChallenge,
  verifyDMChallenge,
  sendRewardNotification,
  logVerification,
  tgApi,
  BOT_USERNAME,
} = require('./taskVerifier');

const app = express();

// Middleware
app.use(helmet());
// CORS — allow local dev, Vercel deployments, and Telegram's web view
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5177',
  'https://beeygo-mini-app-coral.vercel.app',
  'https://beeygo-admin-three.vercel.app',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o)) || origin.includes('.vercel.app')) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.use(express.json());

// Rate Limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100, // Adjusted for dev
  message: { message: 'Too many requests, please try again later.' },
});

// Environment Variables
const PORT = process.env.PORT || 3001;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const JWT_SECRET = process.env.JWT_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD_HASH || !JWT_SECRET || !TELEGRAM_BOT_TOKEN) {
  console.error("FATAL ERROR: Missing required environment variables (ADMIN_EMAIL, ADMIN_PASSWORD_HASH, JWT_SECRET, TELEGRAM_BOT_TOKEN).");
  process.exit(1);
}

// ── NOWPayments Configuration ─────────────────────────────────────────────────
const NP_API_KEY        = process.env.NOWPAYMENTS_API_KEY || '';
const NP_IPN_SECRET     = process.env.NOWPAYMENTS_IPN_SECRET_KEY || '';
const WITHDRAWAL_FEE    = parseFloat(process.env.WITHDRAWAL_FEE_USD || '0.50');
const WITHDRAWAL_FEE_CUR = process.env.WITHDRAWAL_FEE_CURRENCY || 'trx';
const BACKEND_URL       = process.env.BACKEND_URL || 'https://beeygo-backend.vercel.app';
const NP_API_BASE       = 'https://api.nowpayments.io/v1';

if (!NP_API_KEY || !NP_IPN_SECRET) {
  console.warn('[NOWPayments] WARNING: NOWPAYMENTS_API_KEY or NOWPAYMENTS_IPN_SECRET_KEY not set — payment routes will be non-functional.');
}

// ── NOWPayments API Helper ────────────────────────────────────────────────────
async function npRequest(method, path, body) {
  const opts = {
    method,
    headers: {
      'x-api-key': NP_API_KEY,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${NP_API_BASE}${path}`, opts);
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.message || 'NOWPayments error'), { status: res.status, npError: json });
  return json;
}

// ----------------------------------------------------
// JWT Middleware
// ----------------------------------------------------
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  if (token == null) return res.status(401).json({ message: 'No token provided.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Token is invalid or expired.' });
    req.user = user;
    next();
  });
};

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin access required.' });
  next();
};

// ----------------------------------------------------
// Admin Auth Routes
// ----------------------------------------------------
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });
  if (email !== ADMIN_EMAIL) return res.status(401).json({ message: 'Invalid credentials.' });

  const isMatch = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  if (!isMatch) return res.status(401).json({ message: 'Invalid credentials.' });

  const token = jwt.sign({ email: ADMIN_EMAIL, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, message: 'Login successful' });
});

app.get('/api/auth/verify', authenticateToken, async (req, res) => {
  if (req.user.role === 'user') {
    try {
      const result = await query('SELECT telegram_id, username, first_name, referral_count FROM users WHERE telegram_id = $1', [req.user.telegram_id]);
      if (result.rows.length > 0) {
        const u = result.rows[0];
        return res.json({
          message: 'Token is valid',
          user: { id: parseInt(u.telegram_id, 10), username: u.username, first_name: u.first_name, referral_count: u.referral_count }
        });
      } else {
        // User has a valid token but was deleted from the DB (e.g. during a reset)
        // Force them to re-authenticate via Telegram to rebuild their DB row.
        return res.status(401).json({ message: 'User record not found. Please re-authenticate.' });
      }
    } catch (err) {
      console.error('[Verify] DB Error:', err);
      return res.status(500).json({ message: 'Database error during verification' });
    }
  }

  // Admin fallback
  res.json({ message: 'Token is valid', user: req.user });
});

// ----------------------------------------------------
// Telegram Mini App Auth
// ----------------------------------------------------
// Verify initData from Telegram Web App using official HMAC-SHA256 method
function verifyTelegramWebAppData(telegramInitData) {
  if (!telegramInitData || typeof telegramInitData !== 'string') return false;

  const urlParams = new URLSearchParams(telegramInitData);
  const hash = urlParams.get('hash');
  const authDate = urlParams.get('auth_date');

  if (!hash || !authDate) return false;

  // Strict expiry enforcement in production
  const now = Math.floor(Date.now() / 1000);
  const isExpired = now - parseInt(authDate, 10) > 600;
  if (isExpired) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[Telegram] initData expired, rejecting in production.');
      return false;
    }
    console.warn('[Telegram] initData expired:', now - parseInt(authDate, 10), 'seconds old (dev mode — allowing)');
  }

  urlParams.delete('hash');

  // Sort params and build check string (key=value\n format, no trailing newline)
  const sortedParams = Array.from(urlParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  // HMAC-SHA256 secret: H("WebAppData", bot_token)
  const secret = crypto.createHmac('sha256', 'WebAppData')
    .update(TELEGRAM_BOT_TOKEN)
    .digest();

  const calculatedHash = crypto.createHmac('sha256', secret)
    .update(sortedParams)
    .digest('hex');

  if (calculatedHash !== hash) {
    console.error('[Telegram] Hash mismatch. Expected:', calculatedHash, 'Got:', hash);
    return false;
  }

  // Return parsed fields
  return Object.fromEntries(urlParams.entries());
}

app.post('/api/auth/telegram', authLimiter, async (req, res) => {
  const { initData } = req.body;
  if (!initData) return res.status(400).json({ message: 'Missing initData' });

  // Real Telegram auth
  const validData = verifyTelegramWebAppData(initData);
  if (!validData) {
    return res.status(401).json({ message: 'Invalid or expired Telegram session. Please reopen the app.' });
  }

  let userData;
  try {
    userData = JSON.parse(validData.user);
  } catch {
    return res.status(400).json({ message: 'Malformed user data in initData.' });
  }

  try {
    const { id, username = null, first_name = 'User', last_name = null } = userData;
    if (!id) return res.status(400).json({ message: 'No user ID in Telegram data.' });

    const startParam = validData?.start_param || null;
    const potentialReferrer = (startParam && startParam !== id.toString()) ? startParam : null;

    let refCount = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lightning-fast upsert: validate referrer and insert/update in a single query
      const upsertQuery = `
        WITH valid_referrer AS (
          SELECT telegram_id FROM users WHERE telegram_id = $4
        )
        INSERT INTO users (telegram_id, username, first_name, referred_by)
        VALUES ($1, $2, $3, (SELECT telegram_id FROM valid_referrer))
        ON CONFLICT (telegram_id) DO UPDATE 
        SET username = EXCLUDED.username, first_name = EXCLUDED.first_name
        RETURNING referral_count, referred_by, (xmax = 0) AS is_new_user
      `;

      const result = await client.query(upsertQuery, [id, username, first_name, potentialReferrer]);
      const row = result.rows[0];
      refCount = row.referral_count || 0;

      // Only increment referrer if this was a brand new user who actually had a valid referrer
      if (row.is_new_user && row.referred_by) {
        await client.query('UPDATE users SET referral_count = referral_count + 1 WHERE telegram_id = $1', [row.referred_by]);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const token = jwt.sign({ telegram_id: id, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id, username, first_name, last_name, referral_count: refCount } });
  } catch (err) {
    console.error('[Telegram] Auth DB error:', err);
    res.status(500).json({ message: 'Server error during authentication' });
  }
});

// ----------------------------------------------------
// Mini App User Endpoints
// ----------------------------------------------------
app.get('/api/me', authenticateToken, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ message: 'User access required.' });
  try {
    const result = await query(
      'SELECT telegram_id, balance, total_claimed, claim_count, wallet_address, last_claim_time, referral_count, daily_streak, last_daily_claim, spins_used_today, last_spin_date FROM users WHERE telegram_id = $1',
      [req.user.telegram_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Database error' });
  }
});

// Daily claim endpoint with perfect UTC calendar-day logic
app.post('/api/me/daily-claim', authenticateToken, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ message: 'User access required.' });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch user and settings
    const userRes = await client.query(
      'SELECT daily_streak, last_daily_claim FROM users WHERE telegram_id = $1 FOR UPDATE',
      [req.user.telegram_id]
    );
    if (userRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'User not found.' });
    }

    const settingsRes = await client.query('SELECT config FROM settings WHERE id = 1');
    const config = settingsRes.rows[0]?.config || {};

    if (config.dailyCheckinEnabled === false) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Daily check-in is currently disabled.' });
    }

    const baseReward = config.dailyCheckinBaseReward || 10;
    const streakBonus = config.dailyCheckinStreakBonus || 5;
    const maxStreak = config.dailyCheckinMaxStreak || 7;

    const user = userRes.rows[0];
    const now = new Date();
    const nowStr = now.toISOString().split('T')[0];
    const lastStr = user.last_daily_claim ? new Date(user.last_daily_claim).toISOString().split('T')[0] : null;

    if (nowStr === lastStr) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Already claimed today.' });
    }

    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    let newStreak = 1;
    if (lastStr === yesterdayStr) {
      newStreak = (user.daily_streak || 0) + 1;
    }

    const effectiveStreak = Math.min(newStreak, maxStreak);
    const reward = baseReward + ((effectiveStreak - 1) * streakBonus);

    const updateRes = await client.query(`
      UPDATE users
      SET balance          = balance + $1,
          total_claimed    = total_claimed + $1,
          daily_streak     = $2,
          last_daily_claim = CURRENT_TIMESTAMP
      WHERE telegram_id = $3
      RETURNING balance, daily_streak, last_daily_claim
    `, [reward, newStreak, req.user.telegram_id]);

    await client.query('COMMIT');
    console.log(`[Daily] User ${req.user.telegram_id} claimed ${reward} $BYGO (streak ${newStreak})`);
    res.json({ success: true, reward, ...updateRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Daily Claim] DB Error:', err);
    res.status(500).json({ message: 'Database error during daily claim' });
  } finally {
    client.release();
  }
});

// Spin endpoint with calendar-day logic + server-weighted rewards
app.post('/api/me/spin', authenticateToken, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ message: 'User access required.' });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock user row to prevent concurrent spin abuse
    const userRes = await client.query(
      'SELECT spins_used_today, last_spin_date FROM users WHERE telegram_id = $1 FOR UPDATE',
      [req.user.telegram_id]
    );
    if (userRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'User not found.' });
    }

    const settingsRes = await client.query('SELECT config FROM settings WHERE id = 1');
    const config = settingsRes.rows[0]?.config || {};

    if (config.spinSystemEnabled === false) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Spin system is currently disabled.' });
    }

    const user = userRes.rows[0];
    const now = new Date();
    const nowStr = now.toISOString().split('T')[0];
    const lastStr = user.last_spin_date ? new Date(user.last_spin_date).toISOString().split('T')[0] : null;

    let spinsUsed = user.spins_used_today || 0;

    // Reset spins if it's a new day
    if (nowStr !== lastStr) {
      spinsUsed = 0;
    }

    if (spinsUsed >= 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'No spins left today.' });
    }

    // Server-side weighted spin:
    //   10  BYGO = 35%   (very common)
    //   20  BYGO = 30%   (common)
    //   50  BYGO = 18%   (uncommon)
    //  100  BYGO = 10%   (rare)
    //  250  BYGO =  5%   (very rare)
    //  500  BYGO =  2%   (legendary)
    const rand = Math.random();
    let reward = 10;
    if (rand > 0.98) reward = 500;   // top 2%
    else if (rand > 0.93) reward = 250;   // top 7%
    else if (rand > 0.83) reward = 100;   // top 17%
    else if (rand > 0.65) reward = 50;    // top 35%
    else if (rand > 0.35) reward = 20;    // top 65%
    // else 10 — bottom 35%

    spinsUsed++;

    const updateRes = await client.query(`
      UPDATE users
      SET balance          = balance + $1,
          total_claimed    = total_claimed + $1,
          spins_used_today = $2,
          last_spin_date   = CURRENT_TIMESTAMP
      WHERE telegram_id = $3
      RETURNING balance, spins_used_today, last_spin_date
    `, [reward, spinsUsed, req.user.telegram_id]);

    await client.query('COMMIT');
    console.log(`[Spin] User ${req.user.telegram_id} won ${reward} $BYGO (spin ${spinsUsed}/2)`);
    res.json({ success: true, reward, ...updateRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Spin] DB Error:', err);
    res.status(500).json({ message: 'Database error during spin' });
  } finally {
    client.release();
  }
});

// Leaderboard endpoint
app.get('/api/leaderboard', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.telegram_id;

    const result = await query(`
      SELECT telegram_id, first_name, username, balance 
      FROM users 
      ORDER BY balance DESC 
      LIMIT 5
    `);

    // Anonymize the telegram_id slightly for privacy, e.g. show first name or masked ID
    const top = result.rows.map((u, index) => ({
      rank: index + 1,
      id: u.first_name || (u.username ? `@${u.username}` : `User ${u.telegram_id.toString().slice(-4)}`),
      balance: u.balance || 0,
      isCurrentUser: String(u.telegram_id) === String(userId)
    }));

    const isInTop5 = top.some(u => u.isCurrentUser);
    let currentUser = null;

    if (!isInTop5 && userId) {
      // Find current user's balance
      const userRes = await query(`SELECT first_name, username, balance FROM users WHERE telegram_id = $1`, [userId]);
      if (userRes.rows.length > 0) {
        const u = userRes.rows[0];
        // Calculate rank: count of users with strictly greater balance + 1
        const rankRes = await query(`SELECT COUNT(*) FROM users WHERE balance > $1`, [u.balance]);
        const rank = parseInt(rankRes.rows[0].count, 10) + 1;

        currentUser = {
          rank: rank,
          id: (u.first_name || (u.username ? `@${u.username}` : `User ${userId.toString().slice(-4)}`)) + ' (You)',
          balance: u.balance || 0,
          isCurrentUser: true
        };
      }
    }

    res.json({ top, currentUser });
  } catch (err) {
    console.error('[Leaderboard] DB Error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

// Hardened server-authoritative claim:
// - Row-level locking (FOR UPDATE) prevents race conditions / double-claims
// - Reward is calculated ENTIRELY server-side from settings — client payload is ignored
// - Cooldown is enforced within the same locked transaction
app.post('/api/me/claim', authenticateToken, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ message: 'User access required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the user row — any concurrent request will wait here, preventing race conditions
    const userRes = await client.query(
      'SELECT balance, total_claimed, claim_count, last_claim_time FROM users WHERE telegram_id = $1 FOR UPDATE',
      [req.user.telegram_id]
    );
    if (userRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'User not found.' });
    }
    const user = userRes.rows[0];
    const now = new Date();

    // Fetch settings within the same transaction for consistency
    const settingsRes = await client.query('SELECT config FROM settings WHERE id = 1');
    const config = settingsRes.rows[0]?.config || {};

    if (config.miningPaused) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Mining is currently paused by admin.' });
    }

    const cycleMinutes = config.miningCycleMinutes || 60;
    const cooldownMs = (cycleMinutes * 60 * 1000) - 5000; // 5 second tolerance for clock skew

    // Enforce cooldown within the locked transaction — immune to race conditions
    if (user.last_claim_time) {
      const elapsed = now.getTime() - new Date(user.last_claim_time).getTime();
      if (elapsed < cooldownMs) {
        await client.query('ROLLBACK');
        return res.status(429).json({
          message: 'Mining cooldown not complete.',
          remainingMs: cooldownMs - elapsed,
        });
      }
    }

    // Server-calculated reward — client-supplied value is completely ignored
    const baseReward = config.baseHourlyReward || 6;
    const multiplier = config.rewardMultiplier || 1;
    const doubleBonus = config.doubleRewardEvent ? 2 : 1;
    const safeReward = Math.round(baseReward * multiplier * doubleBonus);

    // Apply atomically — no separate read-check-update window
    const updated = await client.query(`
      UPDATE users
      SET
        balance       = balance + $1,
        total_claimed = total_claimed + $1,
        claim_count   = claim_count + 1,
        last_claim_time = NOW()
      WHERE telegram_id = $2
      RETURNING balance, total_claimed, claim_count, last_claim_time
    `, [safeReward, req.user.telegram_id]);

    await client.query('COMMIT');
    console.log(`[Claim] User ${req.user.telegram_id} claimed ${safeReward} $BYGO`);
    res.json({ success: true, reward: safeReward, ...updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Claim] Fatal error:', err);
    res.status(500).json({ message: 'Database error during claim.' });
  } finally {
    client.release();
  }
});

// Save wallet address to DB
app.post('/api/me/wallet', authenticateToken, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ message: 'User access required.' });
  const { walletAddress } = req.body;
  if (!walletAddress) return res.status(400).json({ message: 'walletAddress is required.' });
  // Basic BEP-20 validation server-side
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ message: 'Invalid BEP-20 address format.' });
  }
  try {
    await query('UPDATE users SET wallet_address = $1 WHERE telegram_id = $2', [walletAddress, req.user.telegram_id]);
    res.json({ success: true, walletAddress });
  } catch (err) {
    console.error('[Wallet] Save error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

// Remove wallet address from DB
app.delete('/api/me/wallet', authenticateToken, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ message: 'User access required.' });
  try {
    await query('UPDATE users SET wallet_address = NULL WHERE telegram_id = $1', [req.user.telegram_id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[Wallet] Remove error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

// ----------------------------------------------------
// Tasks Routes (Mini App)
// ----------------------------------------------------
app.get('/api/tasks', authenticateToken, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ message: 'User access required.' });
  try {
    const result = await query(`
      SELECT t.id, t.title, t.description, t.reward, t.link, t.platform, t.active,
             t.verification_type, t.chat_id,
             COALESCE(ut.status, 'pending') as status
      FROM tasks t
      LEFT JOIN user_tasks ut ON t.id = ut.task_id AND ut.user_id = $1
      WHERE t.active = true
      ORDER BY t.created_at DESC
    `, [req.user.telegram_id]);
    res.json(result.rows);
  } catch (err) {
    console.error('[Tasks] GET error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

// ── Structured Task Verification Engine ─────────────────────────────────────
// Branches on task.verification_type: auto | telegram_join | telegram_dm | code_submit
app.post('/api/tasks/:id/verify', authenticateToken, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ message: 'User access required.' });
  const taskId = req.params.id;
  const telegramId = req.user.telegram_id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Fetch task with verification fields
    const taskRes = await client.query(
      'SELECT id, title, reward, verification_type, chat_id FROM tasks WHERE id = $1 AND active = true',
      [taskId]
    );
    if (taskRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Task not found or inactive.' });
    }
    const task = taskRes.rows[0];
    const verificationType = task.verification_type || 'auto';

    // 2. Guard: already completed?
    const userTaskRes = await client.query(
      'SELECT status, verification_token, token_expires_at FROM user_tasks WHERE user_id = $1 AND task_id = $2',
      [telegramId, taskId]
    );
    if (userTaskRes.rows.length > 0 && userTaskRes.rows[0].status === 'completed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Task already completed.' });
    }

    // 3. Fetch reward multiplier
    const settingsRes = await client.query('SELECT config FROM settings WHERE id = 1');
    const config = settingsRes.rows[0]?.config || {};
    const multiplier = config.taskRewardMultiplier || 1;
    const finalReward = Math.round(task.reward * multiplier);

    // ── Branch on verification type ──────────────────────────────────────────

    // ── A. telegram_join ─────────────────────────────────────────────────────
    if (verificationType === 'telegram_join') {
      if (!task.chat_id) {
        await client.query('ROLLBACK');
        return res.status(500).json({ message: 'Task misconfigured: no channel ID set.' });
      }

      const check = await verifyTelegramMembership(TELEGRAM_BOT_TOKEN, task.chat_id, telegramId);
      await logVerification(pool, telegramId, taskId, 'telegram_join', check.pass ? 'pass' : 'fail',
        `status=${check.status}${check.error ? ' | ' + check.error : ''}`);

      if (!check.pass) {
        await client.query('ROLLBACK');
        const hint = check.status === 'not_found'
          ? 'Channel not found. Contact support.'
          : check.status === 'left' || check.status === 'kicked'
            ? 'You must join the channel first, then verify.'
            : check.error || 'Verification failed.';
        return res.status(403).json({ message: hint, verification_failed: true });
      }

      // Pass → award reward
      await client.query(`
        INSERT INTO user_tasks (user_id, task_id, status, completed_at)
        VALUES ($1, $2, 'completed', CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, task_id) DO UPDATE SET status = 'completed', completed_at = CURRENT_TIMESTAMP
      `, [telegramId, taskId]);
      await client.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = $2', [finalReward, telegramId]);
      await client.query('COMMIT');

      sendRewardNotification(TELEGRAM_BOT_TOKEN, telegramId, task.title, finalReward);
      console.log(`[Verify:tg_join] User ${telegramId} verified task #${taskId} (+${finalReward} $BYGO)`);
      return res.json({ success: true, reward: finalReward });
    }

    // ── B. telegram_dm — step 1: issue challenge ──────────────────────────────
    if (verificationType === 'telegram_dm') {
      await client.query('ROLLBACK'); // release lock before DM issue (non-transactional)

      const issue = await issueDMChallenge(TELEGRAM_BOT_TOKEN, telegramId, taskId, task.title, pool);

      // Cooldown: a code was issued recently — tell client how long to wait
      if (issue.cooldown) {
        return res.status(429).json({
          message: `A code was recently sent to your Telegram DMs. Please wait before requesting another.`,
          cooldown: true,
          retryAfterMs: issue.retryAfterMs,
        });
      }

      if (!issue.success) {
        return res.status(500).json({ message: issue.error || 'Failed to issue verification code.' });
      }

      console.log(`[Verify:tg_dm] Issued DM challenge to user ${telegramId} for task #${taskId}`);
      return res.json({
        success: false,
        pending: true,
        message: `A verification code has been sent via ${BOT_USERNAME}. Enter it below to claim your reward.`,
      });
    }

    // ── C. code_submit — store proof, mark pending_review ─────────────────────
    if (verificationType === 'code_submit') {
      const { proof } = req.body; // URL or short text
      if (!proof || proof.trim().length < 3) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Please provide a valid proof URL or code.' });
      }

      await client.query(`
        INSERT INTO user_tasks (user_id, task_id, status, verification_token)
        VALUES ($1, $2, 'pending_review', $3)
        ON CONFLICT (user_id, task_id) DO UPDATE SET status = 'pending_review', verification_token = $3
      `, [telegramId, taskId, proof.trim().substring(0, 200)]);

      await logVerification(pool, telegramId, taskId, 'code_submit', 'pending', `proof=${proof.trim().substring(0, 100)}`);
      await client.query('COMMIT');

      console.log(`[Verify:code_submit] User ${telegramId} submitted proof for task #${taskId}`);
      return res.json({
        success: false,
        pending: true,
        message: 'Your proof has been submitted and is pending review. You will be notified when approved.',
      });
    }

    // ── D. auto — instant reward (original behavior) ──────────────────────────
    // Small artificial delay to prevent instant-click farming patterns
    await new Promise(r => setTimeout(r, 800));

    await client.query(`
      INSERT INTO user_tasks (user_id, task_id, status, completed_at)
      VALUES ($1, $2, 'completed', CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, task_id) DO UPDATE SET status = 'completed', completed_at = CURRENT_TIMESTAMP
    `, [telegramId, taskId]);
    await client.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = $2', [finalReward, telegramId]);
    await logVerification(pool, telegramId, taskId, 'auto', 'pass', 'instant');
    await client.query('COMMIT');

    console.log(`[Verify:auto] User ${telegramId} completed task #${taskId} (+${finalReward} $BYGO)`);
    return res.json({ success: true, reward: finalReward });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    console.error('[Tasks] Verify error:', err);
    res.status(500).json({ message: 'Database error during verification' });
  } finally {
    client.release();
  }
});

// ── DM Challenge Submission ──────────────────────────────────────────────────
// Called after user receives bot DM and enters the code in the mini-app
app.post('/api/tasks/:id/dm-verify', authenticateToken, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ message: 'User access required.' });
  const taskId = req.params.id;
  const telegramId = req.user.telegram_id;
  const { code } = req.body;

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ message: 'Verification code is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch task
    const taskRes = await client.query(
      'SELECT id, title, reward, verification_type FROM tasks WHERE id = $1 AND active = true',
      [taskId]
    );
    if (taskRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Task not found or inactive.' });
    }
    const task = taskRes.rows[0];
    if (task.verification_type !== 'telegram_dm') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'This task does not use DM verification.' });
    }

    // Fetch stored challenge
    const utRes = await client.query(
      'SELECT status, verification_token, token_expires_at FROM user_tasks WHERE user_id = $1 AND task_id = $2',
      [telegramId, taskId]
    );
    if (utRes.rows.length === 0 || !utRes.rows[0].verification_token) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'No pending verification found. Please request a code first.' });
    }
    const row = utRes.rows[0];
    if (row.status === 'completed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Task already completed.' });
    }

    // Validate the code
    const check = verifyDMChallenge(code, row.verification_token, row.token_expires_at);
    await logVerification(pool, telegramId, taskId, 'telegram_dm', check.pass ? 'pass' : 'fail',
      check.reason || 'code_match');

    if (!check.pass) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: check.reason, verification_failed: true });
    }

    // Code correct → award reward
    const settingsRes = await client.query('SELECT config FROM settings WHERE id = 1');
    const config = settingsRes.rows[0]?.config || {};
    const finalReward = Math.round(task.reward * (config.taskRewardMultiplier || 1));

    await client.query(`
      UPDATE user_tasks
      SET status = 'completed', verification_token = NULL, token_expires_at = NULL, completed_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND task_id = $2
    `, [telegramId, taskId]);
    await client.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = $2', [finalReward, telegramId]);
    await client.query('COMMIT');

    sendRewardNotification(TELEGRAM_BOT_TOKEN, telegramId, task.title, finalReward);
    console.log(`[Verify:tg_dm] User ${telegramId} verified code for task #${taskId} (+${finalReward} $BYGO)`);
    return res.json({ success: true, reward: finalReward });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    console.error('[Tasks] DM Verify error:', err);
    res.status(500).json({ message: 'Database error during DM verification' });
  } finally {
    client.release();
  }
});

// ── Telegram Bot Webhook ─────────────────────────────────────────────────────
// Telegram sends updates here when the bot receives messages.
// Handles: DM challenge code replies for auto-verification from the bot side.
app.post('/api/bot/webhook', async (req, res) => {
  // Always respond 200 immediately to Telegram
  res.sendStatus(200);

  const update = req.body;
  const message = update?.message;
  if (!message || !message.text || !message.from) return;

  const userId = message.from.id;
  const text = message.text.trim().toUpperCase();

  // Only handle 6-char alphanumeric codes (our challenge format)
  if (!/^[A-Z0-9]{6}$/.test(text)) return;

  try {
    // Find a pending DM challenge for this user matching the code
    const result = await query(`
      SELECT ut.task_id, ut.verification_token, ut.token_expires_at, t.title, t.reward
      FROM user_tasks ut
      JOIN tasks t ON t.id = ut.task_id
      WHERE ut.user_id = $1
        AND ut.status = 'pending'
        AND ut.verification_token IS NOT NULL
        AND ut.token_expires_at > NOW()
    `, [userId]);

    if (result.rows.length === 0) return; // no pending challenge

    const row = result.rows[0];
    const check = verifyDMChallenge(text, row.verification_token, row.token_expires_at);
    if (!check.pass) return; // wrong code, ignore silently

    // Valid — complete the task atomically
    const settingsRes = await query('SELECT config FROM settings WHERE id = 1');
    const config = settingsRes.rows[0]?.config || {};
    const finalReward = Math.round(row.reward * (config.taskRewardMultiplier || 1));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        UPDATE user_tasks
        SET status = 'completed', verification_token = NULL, token_expires_at = NULL, completed_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND task_id = $2
      `, [userId, row.task_id]);
      await client.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = $2', [finalReward, userId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await logVerification(pool, userId, row.task_id, 'telegram_dm_bot', 'pass', 'via_bot_reply');
    sendRewardNotification(TELEGRAM_BOT_TOKEN, userId, row.title, finalReward);
    console.log(`[Webhook] Auto-verified task #${row.task_id} for user ${userId} via bot reply (+${finalReward} $BYGO)`);
  } catch (err) {
    console.error('[Webhook] Error processing DM code:', err.message);
  }
});

// ----------------------------------------------------
// Admin — Task Management
// ----------------------------------------------------
app.get('/api/admin/tasks', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await query('SELECT * FROM tasks ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('[Admin Tasks] GET error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

app.post('/api/admin/tasks', authenticateToken, requireAdmin, async (req, res) => {
  const { title, description, reward, link, platform, active, verification_type, chat_id } = req.body;
  const validVerifTypes = ['auto', 'telegram_join', 'telegram_dm', 'code_submit'];
  const verType = validVerifTypes.includes(verification_type) ? verification_type : 'auto';
  try {
    const result = await query(`
      INSERT INTO tasks (title, description, reward, link, platform, active, verification_type, chat_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [title, description, reward, link, platform, active !== false, verType, chat_id || null]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Admin Tasks] POST error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

app.put('/api/admin/tasks/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { title, description, reward, link, platform, active, verification_type, chat_id } = req.body;
  const validVerifTypes = ['auto', 'telegram_join', 'telegram_dm', 'code_submit'];
  const verType = verification_type && validVerifTypes.includes(verification_type) ? verification_type : undefined;
  try {
    const result = await query(`
      UPDATE tasks 
      SET title             = COALESCE($1, title),
          description       = COALESCE($2, description),
          reward            = COALESCE($3, reward),
          link              = COALESCE($4, link),
          platform          = COALESCE($5, platform),
          active            = COALESCE($6, active),
          verification_type = COALESCE($7, verification_type),
          chat_id           = COALESCE($8, chat_id)
      WHERE id = $9
      RETURNING *
    `, [title, description, reward, link, platform, active, verType ?? null, chat_id ?? null, req.params.id]);

    if (result.rows.length === 0) return res.status(404).json({ message: 'Task not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Admin Tasks] PUT error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

app.delete('/api/admin/tasks/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[Admin Tasks] DELETE error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

// ── Admin — Verification Log ─────────────────────────────────────────────────
app.get('/api/admin/verification-log', authenticateToken, requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  const taskId = req.query.task_id || null;
  const result_ = req.query.result || null; // 'pass' | 'fail'

  try {
    const conditions = [];
    const params = [];
    let idx = 1;
    if (taskId) { conditions.push(`l.task_id = $${idx++}`); params.push(taskId); }
    if (result_) { conditions.push(`l.result = $${idx++}`); params.push(result_); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await query(`
      SELECT l.id, l.user_id, l.task_id, l.verification_type, l.result, l.detail, l.checked_at,
             u.first_name, u.username, t.title as task_title
      FROM task_verification_log l
      LEFT JOIN users u ON u.telegram_id = l.user_id
      LEFT JOIN tasks t ON t.id = l.task_id
      ${where}
      ORDER BY l.checked_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `, [...params, limit, offset]);

    const countRes = await query(`SELECT COUNT(*) FROM task_verification_log l ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    res.json({ log: rows.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[Admin] Verification log error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

// ── Admin — List pending_review submissions for a task ──────────────────────
app.get('/api/admin/tasks/:taskId/submissions', authenticateToken, requireAdmin, async (req, res) => {
  const { taskId } = req.params;
  try {
    const taskRes = await query('SELECT id, title, verification_type FROM tasks WHERE id = $1', [taskId]);
    if (taskRes.rows.length === 0) return res.status(404).json({ message: 'Task not found.' });
    if (taskRes.rows[0].verification_type !== 'code_submit') {
      return res.status(400).json({ message: 'This task does not use code_submit verification.' });
    }

    const result = await query(`
      SELECT ut.user_id, ut.status, ut.verification_token AS proof, ut.completed_at,
             u.first_name, u.username, u.telegram_id
      FROM user_tasks ut
      JOIN users u ON u.telegram_id = ut.user_id
      WHERE ut.task_id = $1
        AND ut.status IN ('pending_review', 'completed')
      ORDER BY ut.completed_at DESC NULLS LAST
    `, [taskId]);

    res.json({ task: taskRes.rows[0], submissions: result.rows });
  } catch (err) {
    console.error('[Admin] Submissions list error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

// ── Admin — List ALL pending_review submissions across all tasks ─────────────
app.get('/api/admin/submissions', authenticateToken, requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 50);
  const offset = (page - 1) * limit;

  try {
    const rows = await query(`
      SELECT ut.user_id, ut.task_id, ut.status, ut.verification_token AS proof,
             u.first_name, u.username,
             t.title AS task_title, t.reward
      FROM user_tasks ut
      JOIN users u ON u.telegram_id = ut.user_id
      JOIN tasks t ON t.id = ut.task_id
      WHERE ut.status = 'pending_review'
        AND t.verification_type = 'code_submit'
      ORDER BY ut.task_id, ut.user_id
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const countRes = await query(`
      SELECT COUNT(*) FROM user_tasks ut
      JOIN tasks t ON t.id = ut.task_id
      WHERE ut.status = 'pending_review' AND t.verification_type = 'code_submit'
    `);
    const total = parseInt(countRes.rows[0].count, 10);

    res.json({ submissions: rows.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[Admin] All submissions error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

// ── Admin — Approve code_submit tasks ────────────────────────────────────────
app.post('/api/admin/tasks/:taskId/users/:userId/approve', authenticateToken, requireAdmin, async (req, res) => {
  const { taskId, userId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const taskRes = await client.query('SELECT reward, title, verification_type FROM tasks WHERE id = $1', [taskId]);
    if (taskRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Task not found.' });
    }
    if (taskRes.rows[0].verification_type !== 'code_submit') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'This task does not use code_submit verification.' });
    }
    const utRes = await client.query(
      "SELECT status FROM user_tasks WHERE user_id = $1 AND task_id = $2",
      [userId, taskId]
    );
    if (utRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'No pending submission found.' });
    }
    if (utRes.rows[0].status === 'completed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Already completed.' });
    }

    const settingsRes = await client.query('SELECT config FROM settings WHERE id = 1');
    const config = settingsRes.rows[0]?.config || {};
    const finalReward = Math.round(taskRes.rows[0].reward * (config.taskRewardMultiplier || 1));

    await client.query(
      "UPDATE user_tasks SET status = 'completed', completed_at = CURRENT_TIMESTAMP, verification_token = NULL WHERE user_id = $1 AND task_id = $2",
      [userId, taskId]
    );
    await client.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = $2', [finalReward, userId]);
    await logVerification(pool, userId, taskId, 'code_submit_approved', 'pass', `admin_approved`);
    await client.query('COMMIT');

    sendRewardNotification(TELEGRAM_BOT_TOKEN, userId, taskRes.rows[0].title, finalReward);
    console.log(`[Admin] Approved code_submit for user ${userId} task #${taskId} (+${finalReward} $BYGO)`);
    res.json({ success: true, reward: finalReward });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    console.error('[Admin] Approve error:', err);
    res.status(500).json({ message: 'Database error' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------
// Settings Routes (Postgres backed)
// ----------------------------------------------------
const FALLBACK_SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

app.get('/api/settings', async (req, res) => {
  try {
    const result = await query('SELECT config FROM settings WHERE id = 1');
    if (result.rows.length > 0) {
      return res.json(result.rows[0].config);
    }
    // Fallback if DB is empty
    if (fs.existsSync(FALLBACK_SETTINGS_FILE)) {
      return res.json(JSON.parse(fs.readFileSync(FALLBACK_SETTINGS_FILE, 'utf8')));
    }
    res.json({});
  } catch (err) {
    console.error('Failed to load settings from DB:', err);
    res.status(500).json({ message: 'Failed to load settings' });
  }
});

app.post('/api/settings', authenticateToken, requireAdmin, async (req, res) => {
  const newSettings = req.body;
  try {
    await query(`
      INSERT INTO settings (id, config)
      VALUES (1, $1)
      ON CONFLICT (id) DO UPDATE 
      SET config = EXCLUDED.config
    `, [newSettings]);

    // Also save to file as backup
    if (fs.existsSync(path.dirname(FALLBACK_SETTINGS_FILE))) {
      fs.writeFileSync(FALLBACK_SETTINGS_FILE, JSON.stringify(newSettings, null, 2));
    }

    res.json({ message: 'Settings saved successfully', settings: newSettings });
  } catch (err) {
    console.error('Failed to save settings to DB:', err);
    res.status(500).json({ message: 'Failed to save settings' });
  }
});

// ----------------------------------------------------
// Admin — User Management
// ----------------------------------------------------

// List all users (paginated)
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 50);
  const search = req.query.search || '';
  const offset = (page - 1) * limit;

  try {
    let queryText, params;
    const sort = req.query.sort || 'created_at';
    const orderBy = sort === 'balance' ? 'balance DESC' : 'created_at DESC';

    if (search) {
      queryText = `
        SELECT telegram_id, username, first_name, balance, total_claimed, claim_count, 
               referral_count, wallet_address, last_claim_time, created_at
        FROM users
        WHERE username ILIKE $1 OR first_name ILIKE $1 OR CAST(telegram_id AS TEXT) LIKE $1
        ORDER BY ${orderBy}
        LIMIT $2 OFFSET $3
      `;
      params = [`%${search}%`, limit, offset];
    } else {
      queryText = `
        SELECT telegram_id, username, first_name, balance, total_claimed, claim_count,
               referral_count, wallet_address, last_claim_time, created_at
        FROM users
        ORDER BY ${orderBy}
        LIMIT $1 OFFSET $2
      `;
      params = [limit, offset];
    }

    const result = await query(queryText, params);
    const countRes = await query('SELECT COUNT(*) FROM users');
    const total = parseInt(countRes.rows[0].count, 10);

    res.json({
      users: result.rows,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('[Admin] Users list error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

// Admin adjust user balance
app.post('/api/admin/users/:id/adjust', authenticateToken, requireAdmin, async (req, res) => {
  const telegramId = req.params.id;
  const { balance, reason } = req.body;
  if (balance === undefined || isNaN(balance)) {
    return res.status(400).json({ message: 'Valid balance required.' });
  }
  try {
    const result = await query(
      'UPDATE users SET balance = $1 WHERE telegram_id = $2 RETURNING telegram_id, balance',
      [balance, telegramId]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found.' });
    console.log(`[Admin] Balance adjusted for user ${telegramId} to ${balance}. Reason: ${reason || 'none'}`);
    res.json({ success: true, ...result.rows[0] });
  } catch (err) {
    console.error('[Admin] Adjust balance error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

// ----------------------------------------------------
// Admin — Dashboard Stats
// ----------------------------------------------------
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [usersRes, appsRes, tokenRes, walletRes] = await Promise.all([
      query('SELECT COUNT(*) as total, COUNT(wallet_address) as with_wallet FROM users'),
      query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'approved') as approved,
          COUNT(*) FILTER (WHERE status = 'rejected') as rejected
        FROM ambassador_applications
      `),
      query('SELECT COALESCE(SUM(total_claimed), 0) as total_mined FROM users'),
      query('SELECT COUNT(*) as count FROM users WHERE wallet_address IS NOT NULL'),
    ]);

    res.json({
      users: {
        total: parseInt(usersRes.rows[0].total, 10),
        withWallet: parseInt(usersRes.rows[0].with_wallet, 10),
      },
      applications: {
        total: parseInt(appsRes.rows[0].total, 10),
        pending: parseInt(appsRes.rows[0].pending, 10),
        approved: parseInt(appsRes.rows[0].approved, 10),
        rejected: parseInt(appsRes.rows[0].rejected, 10),
      },
      tokensMined: parseInt(tokenRes.rows[0].total_mined, 10),
      walletLinked: parseInt(walletRes.rows[0].count, 10),
    });
  } catch (err) {
    console.error('[Admin Stats] Error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

// ----------------------------------------------------
// Admin — Ambassador Applications Management
// ----------------------------------------------------

// List applications with pagination + status filter + search
app.get('/api/admin/applications', authenticateToken, requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const status = req.query.status || 'all'; // all | pending | approved | rejected
  const search = (req.query.search || '').trim();

  try {
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (status !== 'all') {
      conditions.push(`status = $${paramIdx++}`);
      params.push(status);
    }

    if (search) {
      conditions.push(`(
        first_name ILIKE $${paramIdx} OR
        last_name ILIKE $${paramIdx} OR
        email ILIKE $${paramIdx} OR
        telegram ILIKE $${paramIdx} OR
        twitter ILIKE $${paramIdx}
      )`);
      params.push(`%${search}%`);
      paramIdx++;
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const dataQuery = `
      SELECT id, first_name, last_name, email, country, telegram, twitter,
             channel_handle, user_handle, social_url, follower_count, niche,
             motivation, promotion_plan, status, admin_notes, reviewed_at, created_at
      FROM ambassador_applications
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;

    const countQuery = `
      SELECT COUNT(*) FROM ambassador_applications ${whereClause}
    `;

    const [dataRes, countRes] = await Promise.all([
      query(dataQuery, [...params, limit, offset]),
      query(countQuery, params),
    ]);

    const total = parseInt(countRes.rows[0].count, 10);

    res.json({
      applications: dataRes.rows,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('[Admin Applications] GET error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

// Get single application
app.get('/api/admin/applications/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await query('SELECT * FROM ambassador_applications WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Application not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Admin Applications] GET single error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

// Update application status (approve / reject / pending) + optional admin notes
app.put('/api/admin/applications/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { status, admin_notes } = req.body;
  const validStatuses = ['pending', 'approved', 'rejected'];

  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ message: `status must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    const result = await query(`
      UPDATE ambassador_applications
      SET status = $1,
          admin_notes = COALESCE($2, admin_notes),
          reviewed_at = CASE WHEN $1 IN ('approved', 'rejected') THEN CURRENT_TIMESTAMP ELSE reviewed_at END
      WHERE id = $3
      RETURNING *
    `, [status, admin_notes || null, req.params.id]);

    if (result.rows.length === 0) return res.status(404).json({ message: 'Application not found.' });

    const app_row = result.rows[0];
    console.log(`[Admin Applications] Application #${app_row.id} (${app_row.email}) status → ${status}`);

    // Send decision email if approved or rejected and SMTP is configured
    if ((status === 'approved' || status === 'rejected') && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_USER !== 'your@gmail.com') {
      const fromAddress = `"${process.env.FROM_NAME || 'BeeyGO Official'}" <${process.env.SMTP_USER}>`;
      const subject = status === 'approved'
        ? `🎉 Congratulations! Your BeeyGO Ambassador Application is Approved`
        : `BeeyGO Ambassador Application Update — ${app_row.first_name}`;

      const html = status === 'approved'
        ? approvalEmail(app_row)
        : rejectionEmail(app_row);

      transporter.sendMail({
        from: fromAddress,
        to: app_row.email,
        subject,
        html,
      }).catch(e => console.error('[Applications] Failed to send decision email:', e.message));
    }

    res.json({ success: true, application: app_row });
  } catch (err) {
    console.error('[Admin Applications] PUT error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

// Delete an application
app.delete('/api/admin/applications/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await query('DELETE FROM ambassador_applications WHERE id = $1 RETURNING id, email', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Application not found.' });
    console.log(`[Admin Applications] Deleted application #${result.rows[0].id} (${result.rows[0].email})`);
    res.json({ success: true });
  } catch (err) {
    console.error('[Admin Applications] DELETE error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Email System — BeeyGO Company Standard
// All templates: table-based layout, fully inline CSS, Outlook-safe.
// ─────────────────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false, // STARTTLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: { rejectUnauthorized: false },
});

// ── Shared layout primitives ──────────────────────────────────────────────────
const CY = new Date().getFullYear();

// Brand colors (solid — rgba is unreliable in many email clients)
const C = {
  bg: '#04080f',
  card: '#0b1628',
  cardBdr: '#1c3050',
  header: '#061220',
  cyan: '#00e5ff',
  cyanDim: '#0097b2',
  cyanBg: '#061e2a',
  cyanBdr: '#0d4060',
  green: '#22c55e',
  greenBg: '#071a0f',
  greenBdr: '#14532d',
  red: '#f87171',
  redBg: '#1a0707',
  redBdr: '#7f1d1d',
  gold: '#f5b800',
  goldBg: '#1a1200',
  goldBdr: '#78530a',
  text: '#d4e8f0',
  muted: '#7a9ab0',
  dim: '#3d5a72',
  white: '#ffffff',
};

// ── Shared reusable blocks ────────────────────────────────────────────────────

/** Top-level email wrapper with solid background */
const emailWrap = (innerHtml) => `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
  <title>BeeyGO</title>
</head>
<body style="margin:0;padding:0;background-color:${C.bg};font-family:'Segoe UI',Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <!-- Preview text (hidden) -->
  <div style="display:none;font-size:1px;color:${C.bg};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">BeeyGO Ambassador Programme</div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${C.bg};">
    <tr>
      <td align="center" style="padding:40px 16px 60px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">
          ${innerHtml}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

/** Branded header row */
const emailHeader = () => `
<tr>
  <td style="background-color:${C.header};border-radius:16px 16px 0 0;border:1px solid ${C.cardBdr};border-bottom:none;padding:28px 40px;" align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td align="center">
          <!-- Logo wordmark -->
          <div style="display:inline-block;background:linear-gradient(135deg,#4df4ff,#0097b2);border-radius:12px;padding:10px 24px;margin-bottom:10px;">
            <span style="font-size:22px;font-weight:900;color:#04080f;letter-spacing:3px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">BYGO</span>
          </div>
          <br/>
          <span style="font-size:11px;color:${C.muted};letter-spacing:2px;text-transform:uppercase;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">BeeyGO · BEP-20 · Binance Smart Chain</span>
        </td>
      </tr>
    </table>
  </td>
</tr>`;

/** Divider line */
const divider = (color = C.cyanBdr) => `
<tr>
  <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:0 40px;">
    <div style="height:1px;background-color:${color};"></div>
  </td>
</tr>`;

/** Section heading label (e.g. "APPLICATION SUMMARY") */
const sectionLabel = (text, color = C.cyan) => `
<p style="margin:0 0 14px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${color};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">${text}</p>`;

/** Info row inside a table: key → value */
const infoRow = (key, val, valColor = C.white, last = false) => `
<tr>
  <td style="color:${C.muted};font-size:13px;padding:8px 0;border-bottom:${last ? 'none' : `1px solid ${C.dim}`};width:40%;font-family:'Segoe UI',Helvetica,Arial,sans-serif;vertical-align:top;">${key}</td>
  <td style="color:${valColor};font-size:13px;padding:8px 0;border-bottom:${last ? 'none' : `1px solid ${C.dim}`};font-weight:600;font-family:'Segoe UI',Helvetica,Arial,sans-serif;vertical-align:top;">${val}</td>
</tr>`;

/** CTA button */
const ctaButton = (text, url, bg = C.cyan, textColor = C.bg) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
  <tr>
    <td style="border-radius:50px;background-color:${bg};">
      <a href="${url}" target="_blank" style="display:inline-block;padding:14px 36px;font-size:14px;font-weight:700;color:${textColor};text-decoration:none;font-family:'Segoe UI',Helvetica,Arial,sans-serif;letter-spacing:0.5px;border-radius:50px;">${text}</a>
    </td>
  </tr>
</table>`;

/** Banner highlight block (status callout) */
const bannerBlock = (bg, border, icon, title, desc, titleColor = C.white) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr>
    <td style="background-color:${bg};border:1px solid ${border};border-radius:12px;padding:20px 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td width="40" style="vertical-align:top;padding-right:14px;font-size:26px;">${icon}</td>
          <td>
            <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:${titleColor};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">${title}</p>
            <p style="margin:0;font-size:13px;color:${C.text};line-height:1.6;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">${desc}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;

/** Step row (icon + title + desc) */
const stepRow = (icon, title, desc) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:14px;">
  <tr>
    <td width="44" style="vertical-align:top;padding-right:14px;">
      <div style="width:36px;height:36px;background-color:${C.cyanBg};border:1px solid ${C.cyanBdr};border-radius:10px;text-align:center;line-height:36px;font-size:18px;">${icon}</div>
    </td>
    <td style="vertical-align:top;padding-top:4px;">
      <p style="margin:0 0 2px;font-size:14px;font-weight:700;color:${C.white};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">${title}</p>
      <p style="margin:0;font-size:13px;color:${C.muted};line-height:1.5;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">${desc}</p>
    </td>
  </tr>
</table>`;

/** Professional email footer */
const emailFooter = () => `
<tr>
  <td style="background-color:${C.header};border-radius:0 0 16px 16px;border:1px solid ${C.cardBdr};border-top:none;padding:28px 40px;" align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td align="center" style="padding-bottom:16px;">
          <!-- Social links -->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
            <tr>
              <td style="padding:0 8px;">
                <a href="https://t.me/BeeyGOs" target="_blank" style="color:${C.cyan};font-size:12px;text-decoration:none;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Telegram</a>
              </td>
              <td style="color:${C.dim};font-size:12px;">·</td>
              <td style="padding:0 8px;">
                <a href="https://x.com/Official_BeeyGO" target="_blank" style="color:${C.cyan};font-size:12px;text-decoration:none;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Twitter / X</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td align="center">
          <p style="margin:0 0 4px;font-size:12px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">© ${CY} BeeyGO. All rights reserved.</p>
          <p style="margin:0;font-size:11px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">$BYGO Token · BEP-20 · Binance Smart Chain</p>
          <p style="margin:8px 0 0;font-size:11px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">You received this email because you applied to the BeeyGO Ambassador Programme.</p>
        </td>
      </tr>
    </table>
  </td>
</tr>`;

// ─────────────────────────────────────────────────────────────────────────────
// 1. CONFIRMATION EMAIL — sent to applicant immediately on submission
// ─────────────────────────────────────────────────────────────────────────────
const confirmationEmail = (data) => emailWrap(`
  ${emailHeader()}

  <!-- Hero -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:40px 40px 32px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td align="center" style="padding-bottom:24px;">
            <div style="display:inline-block;background-color:${C.cyanBg};border:1px solid ${C.cyanBdr};border-radius:50%;width:64px;height:64px;line-height:64px;text-align:center;font-size:30px;">✅</div>
          </td>
        </tr>
        <tr>
          <td align="center">
            <h1 style="margin:0 0 8px;font-size:26px;font-weight:800;color:${C.cyan};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Application Received!</h1>
            <p style="margin:0 0 24px;font-size:15px;color:${C.text};line-height:1.7;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
              Hey <strong style="color:${C.white};">${data.firstName}</strong>, thank you for applying to become a
              <strong style="color:${C.cyan};">BeeyGO Ambassador</strong>.<br/>
              We've received your application and our team will review it within
              <strong style="color:${C.white};">3–5 business days</strong>.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  ${divider()}

  <!-- Application summary -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px;">
      ${sectionLabel('Application Summary')}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        ${infoRow('Full Name', `${data.firstName} ${data.lastName}`)}
        ${infoRow('Email', data.email, C.cyan)}
        ${infoRow('Country', data.country)}
        ${infoRow('Telegram', `@${data.telegram}`)}
        ${infoRow('Twitter / X', `@${data.twitter}`)}
        ${infoRow('Channel Handle', `@${data.channelHandle}`)}
        ${infoRow('Follower Range', data.followerCount, C.cyan)}
        ${infoRow('Content Niche', data.niche, C.text, true)}
      </table>
    </td>
  </tr>

  ${divider()}

  <!-- What happens next -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px;">
      ${sectionLabel('What Happens Next')}
      ${stepRow('📋', 'Review', 'Our team carefully reviews every application within 3–5 business days.')}
      ${stepRow('📧', 'Decision', 'You will receive an email at <strong>${data.email}</strong> with the outcome.')}
      ${stepRow('🚀', 'Onboarding', 'Approved ambassadors receive a welcome kit, referral link, and their first $BYGO allocation.')}
    </td>
  </tr>

  ${divider()}

  <!-- CTA -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px;" align="center">
      <p style="margin:0 0 20px;font-size:14px;color:${C.muted};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
        While you wait, join our community and stay updated on $BYGO.
      </p>
      ${ctaButton('📣  Join BeeyGO Telegram', 'https://t.me/BeeyGOs')}
      <p style="margin:16px 0 0;font-size:12px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
        Questions? Reply to this email or message us on Telegram.
      </p>
    </td>
  </tr>

  ${emailFooter()}
`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. APPROVAL EMAIL — sent to applicant when their application is approved
// ─────────────────────────────────────────────────────────────────────────────
const approvalEmail = (data) => emailWrap(`
  ${emailHeader()}

  <!-- Hero banner -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:40px 40px 32px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td align="center" style="padding-bottom:24px;">
            <div style="display:inline-block;background-color:${C.greenBg};border:1px solid ${C.greenBdr};border-radius:50%;width:72px;height:72px;line-height:72px;text-align:center;font-size:36px;">🎉</div>
          </td>
        </tr>
        <tr>
          <td align="center">
            <h1 style="margin:0 0 8px;font-size:28px;font-weight:800;color:${C.green};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">You're Approved!</h1>
            <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:${C.white};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Welcome to the official BeeyGO Ambassador Team</p>
            <p style="margin:0 0 28px;font-size:15px;color:${C.text};line-height:1.7;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
              Hey <strong style="color:${C.white};">${data.first_name}</strong>, your application has been
              <strong style="color:${C.green};">approved</strong>! You are now an official
              <strong style="color:${C.cyan};">BeeyGO Ambassador</strong>. We're thrilled to have you on the team.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  ${divider(C.greenBdr)}

  <!-- Status callout -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:0 40px 32px;">
      ${bannerBlock(C.greenBg, C.greenBdr, '🏅', 'Official Ambassador Status Granted', `Your ambassador badge will be issued across all BeeyGO platforms. You now have access to exclusive resources, early announcements, and the private ambassador community.`, C.green)}
    </td>
  </tr>

  ${divider()}

  <!-- What happens next -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px;">
      ${sectionLabel('Your Next Steps', C.green)}
      ${stepRow('📦', 'Onboarding Kit', 'Our team will reach out within 24–48 hours with your full ambassador kit, brand assets, and posting guidelines.')}
      ${stepRow('🔗', 'Referral Link', 'You will receive your unique $BYGO referral link to start earning bonuses for every new user you bring in.')}
      ${stepRow('💰', '$BYGO Allocation', 'Your first monthly $BYGO token allocation will be processed and sent to your registered wallet.')}
      ${stepRow('👥', 'Private Community', 'You will be added to the exclusive Ambassador Hub on Telegram, where you can coordinate with the team and fellow ambassadors globally.')}
    </td>
  </tr>

  ${divider()}

  <!-- Admin notes (conditional) -->
  ${data.admin_notes ? `
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:0 40px 32px;">
      ${bannerBlock(C.cyanBg, C.cyanBdr, '📝', 'Note from the BeeyGO Team', data.admin_notes, C.cyan)}
    </td>
  </tr>
  ${divider()}` : ''}

  <!-- CTA -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px;" align="center">
      <p style="margin:0 0 20px;font-size:14px;color:${C.text};font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-weight:600;">
        Join the exclusive Ambassador Hub now to meet the team:
      </p>
      ${ctaButton('🚀  Join Ambassador Hub', 'https://t.me/+HcnnNcqBh2VjMmU0', C.green, C.bg)}
      <p style="margin:14px 0 0;font-size:12px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
        Questions? Reply to this email or reach us on Telegram.
      </p>
    </td>
  </tr>

  ${emailFooter()}
`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. REJECTION EMAIL — sent to applicant when their application is not accepted
// ─────────────────────────────────────────────────────────────────────────────
const rejectionEmail = (data) => emailWrap(`
  ${emailHeader()}

  <!-- Hero -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:40px 40px 32px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td align="center" style="padding-bottom:24px;">
            <div style="display:inline-block;background-color:${C.cyanBg};border:1px solid ${C.cyanBdr};border-radius:50%;width:64px;height:64px;line-height:64px;text-align:center;font-size:30px;">📩</div>
          </td>
        </tr>
        <tr>
          <td align="center">
            <h1 style="margin:0 0 8px;font-size:26px;font-weight:800;color:${C.white};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Application Update</h1>
            <p style="margin:0 0 24px;font-size:15px;color:${C.text};line-height:1.7;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
              Hey <strong style="color:${C.white};">${data.first_name}</strong>, thank you for taking the time to apply
              to the <strong style="color:${C.cyan};">BeeyGO Ambassador Programme</strong>.<br/><br/>
              After a careful review of your application, we are unable to move forward at this time. This decision is
              not a reflection of your overall potential, and we appreciate the effort you put into your application.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  ${divider()}

  <!-- Feedback from admin (conditional) -->
  ${data.admin_notes ? `
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:0 40px 32px;">
      ${bannerBlock(C.cyanBg, C.cyanBdr, '💬', 'Feedback from the Team', data.admin_notes, C.cyan)}
    </td>
  </tr>
  ${divider()}` : ''}

  <!-- Keep growing -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px;">
      ${sectionLabel('Keep Growing With $BYGO')}
      ${stepRow('🌱', 'Grow Your Community', 'Continue building your audience and community presence. We look for passionate, engaged creators of all sizes.')}
      ${stepRow('📅', 'Reapply in the Future', 'Applications are reviewed on a rolling basis. You are welcome to reapply once you have expanded your community reach.')}
      ${stepRow('⚡', 'Stay in the Ecosystem', 'Join the BeeyGO Telegram Mini-App to mine $BYGO daily and stay engaged with the community while you grow.')}
    </td>
  </tr>

  ${divider()}

  <!-- CTA -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px;" align="center">
      <p style="margin:0 0 20px;font-size:14px;color:${C.text};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
        Stay connected with the $BYGO community on Telegram:
      </p>
      ${ctaButton('💬  Join BeeyGO Community', 'https://t.me/BeeyGOs')}
      <p style="margin:14px 0 0;font-size:12px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
        Questions? Reply to this email or reach us on Telegram.
      </p>
    </td>
  </tr>

  ${emailFooter()}
`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. ADMIN NOTIFICATION — sent to admin when a new application is submitted
// ─────────────────────────────────────────────────────────────────────────────
const adminNotificationEmail = (data) => {
  const submittedAt = new Date().toLocaleString('en-GB', { timeZone: 'UTC', hour12: false });
  return emailWrap(`
  <!-- Admin alert header (different accent) -->
  <tr>
    <td style="background-color:#080f1a;border:1px solid #1c3050;border-radius:16px 16px 0 0;border-bottom:none;padding:24px 40px;" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td align="center">
            <div style="display:inline-block;background:linear-gradient(135deg,#4df4ff,#0097b2);border-radius:10px;padding:8px 20px;margin-bottom:8px;">
              <span style="font-size:18px;font-weight:900;color:#04080f;letter-spacing:3px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">BYGO ADMIN</span>
            </div>
            <br/>
            <span style="font-size:11px;color:${C.muted};letter-spacing:2px;text-transform:uppercase;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Ambassador Programme · Internal Notification</span>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Alert banner -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:28px 40px 0;">
      ${bannerBlock(C.cyanBg, C.cyanBdr, '🆕', 'New Ambassador Application Received', `Submitted: <strong style="color:${C.white};">${submittedAt} UTC</strong> &nbsp;·&nbsp; Immediate review recommended`, C.cyan)}
    </td>
  </tr>

  ${divider()}

  <!-- Personal Info -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px 24px;">
      ${sectionLabel('Personal Information')}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        ${infoRow('Full Name', `${data.firstName} ${data.lastName}`, C.white)}
        ${infoRow('Email', `<a href="mailto:${data.email}" style="color:${C.cyan};text-decoration:none;">${data.email}</a>`, C.cyan)}
        ${infoRow('Country', data.country)}
        ${infoRow('Telegram', `@${data.telegram}`, C.white, true)}
      </table>
    </td>
  </tr>

  ${divider()}

  <!-- Social Presence -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px 24px;">
      ${sectionLabel('Social Presence')}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        ${infoRow('Twitter / X', `<a href="https://twitter.com/${data.twitter}" style="color:${C.cyan};text-decoration:none;">@${data.twitter}</a>`, C.cyan)}
        ${infoRow('Channel Handle', `<a href="https://t.me/${data.channelHandle}" style="color:${C.cyan};text-decoration:none;">@${data.channelHandle}</a>`, C.cyan)}
        ${infoRow('User Handle', `<a href="https://t.me/${data.userHandle}" style="color:${C.cyan};text-decoration:none;">@${data.userHandle}</a>`, C.cyan)}
        ${infoRow('Other Platform', data.socialUrl ? `<a href="${data.socialUrl}" style="color:${C.cyan};text-decoration:none;">${data.socialUrl}</a>` : '—', data.socialUrl ? C.cyan : C.dim)}
        ${infoRow('Follower Range', data.followerCount, C.gold)}
        ${infoRow('Content Niche', data.niche, C.white, true)}
      </table>
    </td>
  </tr>

  ${divider()}

  <!-- Motivation -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px 24px;">
      ${sectionLabel('Why They Want to Be an Ambassador')}
      <p style="margin:0;font-size:14px;color:${C.text};line-height:1.75;white-space:pre-line;font-family:'Segoe UI',Helvetica,Arial,sans-serif;background-color:#070f1c;border-left:3px solid ${C.cyanBdr};padding:16px 20px;border-radius:0 8px 8px 0;">${data.motivation}</p>
    </td>
  </tr>

  ${divider()}

  <!-- Promotion Plan -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px 24px;">
      ${sectionLabel('How They Plan to Promote $BYGO')}
      <p style="margin:0;font-size:14px;color:${C.text};line-height:1.75;white-space:pre-line;font-family:'Segoe UI',Helvetica,Arial,sans-serif;background-color:#070f1c;border-left:3px solid ${C.cyanBdr};padding:16px 20px;border-radius:0 8px 8px 0;">${data.promotionPlan}</p>
    </td>
  </tr>

  ${divider()}

  <!-- Admin CTA -->
  <tr>
    <td style="background-color:${C.card};border-left:1px solid ${C.cardBdr};border-right:1px solid ${C.cardBdr};padding:32px 40px;" align="center">
      <p style="margin:0 0 20px;font-size:14px;color:${C.text};font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-weight:600;">
        Review and action this application in the admin panel:
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
        <tr>
          <td style="padding-right:12px;">
            ${ctaButton('✅  Review Application', `${process.env.ADMIN_URL || 'https://beeygo-admin-three.vercel.app'}/applications`, C.cyan, C.bg)}
          </td>
        </tr>
      </table>
      <p style="margin:16px 0 0;font-size:12px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
        Reply-To is set to <strong>${data.email}</strong> — you can reply directly to this email to contact the applicant.
      </p>
    </td>
  </tr>

  <!-- Admin footer -->
  <tr>
    <td style="background-color:#080f1a;border:1px solid #1c3050;border-radius:0 0 16px 16px;border-top:none;padding:20px 40px;" align="center">
      <p style="margin:0 0 4px;font-size:12px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">BeeyGO Admin System · Ambassador Programme · Internal Use Only</p>
      <p style="margin:0;font-size:11px;color:${C.dim};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">© ${CY} BeeyGO. $BYGO Token · BEP-20 · Binance Smart Chain</p>
    </td>
  </tr>
`);
};

// Old duplicate templates removed.

const applyValidation = [
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('lastName').trim().notEmpty().withMessage('Last name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('country').trim().notEmpty().withMessage('Country is required'),
  body('telegram').trim().notEmpty().withMessage('Telegram handle required'),
  body('twitter').trim().notEmpty().withMessage('Twitter handle required'),
  body('channelHandle').trim().notEmpty().withMessage('Channel handle required'),
  body('userHandle').trim().notEmpty().withMessage('User handle required'),
  body('followerCount').notEmpty().withMessage('Follower count is required'),
  body('niche').trim().notEmpty().withMessage('Content niche required'),
  body('motivation').trim().isLength({ min: 100 }).withMessage('Motivation must be at least 100 characters'),
  body('promotionPlan').trim().isLength({ min: 50 }).withMessage('Promotion plan must be at least 50 characters'),
];

app.get('/api/apply/count', async (req, res) => {
  try {
    const result = await query('SELECT COUNT(*) FROM ambassador_applications');
    const total = parseInt(result.rows[0].count, 10);
    res.json({ count: total });
  } catch (err) {
    console.error('[Apply Count] DB Error:', err);
    res.status(500).json({ message: 'Database error' });
  }
});

app.post('/api/apply', applyValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ success: false, errors: errors.array() });
  }

  const data = req.body;
  const client = await pool.connect();

  try {
    // 1. DB Insert with Unique Check
    try {
      await client.query(`
        INSERT INTO ambassador_applications (
          first_name, last_name, email, country, telegram, twitter,
          channel_handle, user_handle, social_url, follower_count,
          niche, motivation, promotion_plan
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        data.firstName, data.lastName, data.email, data.country, data.telegram, data.twitter,
        data.channelHandle, data.userHandle, data.socialUrl || '', data.followerCount,
        data.niche, data.motivation, data.promotionPlan
      ]);
    } catch (dbErr) {
      if (dbErr.code === '23505') { // Postgres Unique Violation
        return res.status(400).json({
          success: false,
          message: 'An application with this email has already been submitted.'
        });
      }
      throw dbErr;
    }

    // 2. Send Emails (non-blocking — DB insert succeeded)
    const fromAddress = `"${process.env.FROM_NAME || 'BeeyGO Official'}" <${process.env.SMTP_USER}>`;
    const adminEmail = process.env.TEAM_EMAIL || process.env.SMTP_USER;

    transporter.sendMail({
      from: fromAddress,
      to: data.email,
      subject: `🎉 BeeyGO Ambassador Application Received — ${data.firstName}!`,
      html: confirmationEmail(data),
    }).catch(e => console.error('[Apply] Failed to send confirmation email to user:', e.message));

    transporter.sendMail({
      from: fromAddress,
      to: adminEmail,
      replyTo: data.email,
      subject: `[BYGO] New Ambassador Application — ${data.firstName} ${data.lastName} (@${data.twitter})`,
      html: adminNotificationEmail(data),
    }).catch(e => console.error('[Apply] Failed to send notification email to admin:', e.message));

    console.log(`[Apply] ✅ Application from ${data.email} saved successfully.`);
    res.json({ success: true, message: 'Application submitted! Check your email for confirmation.' });

  } catch (err) {
    console.error('[Apply] ❌ Error:', err.message);
    res.status(500).json({ success: false, message: 'Server error. Please try again later.' });
  } finally {
    client.release();
  }
});

// ============================================================
// NOWPayments — Withdrawal Fee Payment System
// ============================================================

// ── Rate limiter: 3 withdrawal fee requests per 10 minutes ──
const withdrawalLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => String(req.user?.telegram_id || req.ip),
  message: { message: 'Too many withdrawal requests. Please wait 10 minutes.' },
});

// ── POST /api/payments/create-withdrawal-fee ─────────────────────────────────
// Creates a NOWPayments invoice for the $0.50 fee and locks the user's BYGO
// balance. Returns the payment address so the frontend can display it.
app.post('/api/payments/create-withdrawal-fee', authenticateToken, withdrawalLimiter, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ message: 'User access required.' });

  const { bygoAmount } = req.body;
  if (!bygoAmount || typeof bygoAmount !== 'number' || bygoAmount <= 0 || !Number.isInteger(bygoAmount)) {
    return res.status(400).json({ message: 'bygoAmount must be a positive integer.' });
  }

  const telegramId = req.user.telegram_id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Fetch and lock user row
    const userRes = await client.query(
      'SELECT balance, wallet_address FROM users WHERE telegram_id = $1 FOR UPDATE',
      [telegramId]
    );
    if (userRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'User not found.' });
    }
    const user = userRes.rows[0];

    // 2. Validate wallet is linked
    if (!user.wallet_address) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Please link a BEP-20 wallet address first.' });
    }

    // 3. Enforce minimum withdrawal from settings
    const settingsRes = await client.query('SELECT config FROM settings WHERE id = 1');
    const config = settingsRes.rows[0]?.config || {};
    const minWithdrawal = config.minWithdrawal || 1000;

    if (!config.withdrawalsEnabled) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Withdrawals are currently disabled by admin.' });
    }
    if (bygoAmount < minWithdrawal) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `Minimum withdrawal is ${minWithdrawal} $BYGO.` });
    }

    // 4. Calculate locked balance from active withdrawals
    const activeRes = await client.query(
      "SELECT SUM(bygo_amount) as locked FROM withdrawal_requests WHERE user_id = $1 AND status IN ('fee_pending', 'fee_paid', 'processing')",
      [telegramId]
    );
    const lockedAmount = parseInt(activeRes.rows[0].locked || '0', 10);
    const availableBalance = user.balance - lockedAmount;

    if (bygoAmount > availableBalance) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `Insufficient balance. You have ${user.balance} $BYGO (${lockedAmount} is locked in pending withdrawals).` });
    }

    // 5. Token deduction ONLY happens after the withdrawal succeeds 100% (completed status)
    // Removed immediate deduction here.

    // 6. Create the withdrawal request row
    const insertRes = await client.query(`
      INSERT INTO withdrawal_requests
        (user_id, bygo_amount, wallet_address, fee_usd, fee_currency, status)
      VALUES ($1, $2, $3, $4, $5, 'fee_pending')
      RETURNING id
    `, [telegramId, bygoAmount, user.wallet_address, WITHDRAWAL_FEE, WITHDRAWAL_FEE_CUR]);
    const withdrawalId = insertRes.rows[0].id;

    await client.query('COMMIT');

    // 7. Create the NOWPayments invoice (outside the transaction — non-reversible)
    let npPayment;
    try {
      npPayment = await npRequest('POST', '/payment', {
        price_amount:       WITHDRAWAL_FEE,
        price_currency:     'usd',
        pay_currency:       WITHDRAWAL_FEE_CUR,
        order_id:           `wd_${withdrawalId}`,
        order_description:  `BeeyGO withdrawal fee — ${bygoAmount} $BYGO`,
        ipn_callback_url:   `${BACKEND_URL}/api/payments/ipn`,
      });
    } catch (npErr) {
      // If NOWPayments fails, mark request failed (no balance to restore since we didn't deduct)
      console.error('[Payment] NOWPayments invoice creation failed:', npErr.message);
      await query(
        "UPDATE withdrawal_requests SET status = 'failed', admin_note = $1 WHERE id = $2",
        ['NOWPayments invoice creation failed: ' + npErr.message, withdrawalId]
      );
      return res.status(502).json({ message: 'Payment gateway error. Your balance has been restored. Please try again.' });
    }

    // 8. Store NOWPayments IDs on the withdrawal request
    await query(`
      UPDATE withdrawal_requests
      SET nowpayments_payment_id  = $1,
          nowpayments_pay_address = $2,
          nowpayments_pay_amount  = $3,
          nowpayments_pay_currency = $4,
          updated_at              = CURRENT_TIMESTAMP
      WHERE id = $5
    `, [
      String(npPayment.payment_id),
      npPayment.pay_address,
      npPayment.pay_amount,
      npPayment.pay_currency,
      withdrawalId,
    ]);

    console.log(`[Payment] Withdrawal #${withdrawalId} created for user ${telegramId}: ${bygoAmount} $BYGO, fee payment ${npPayment.payment_id}`);

    return res.json({
      success:         true,
      withdrawal_id:   withdrawalId,
      payment_id:      String(npPayment.payment_id),
      pay_address:     npPayment.pay_address,
      pay_amount:      npPayment.pay_amount,
      pay_currency:    npPayment.pay_currency,
      payment_status:  npPayment.payment_status,
      expiry:          npPayment.expiration_estimate_date || null,
      fee_usd:         WITHDRAWAL_FEE,
      bygo_amount:     bygoAmount,
    });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Payment] Create withdrawal fee error:', err);
    return res.status(500).json({ message: 'Server error creating withdrawal. Please try again.' });
  } finally {
    client.release();
  }
});

// ── GET /api/payments/:paymentId/status ──────────────────────────────────────
// Frontend polls this every 5s to show live payment status.
// On 'finished'/'confirmed': marks fee_paid and queues the withdrawal.
app.get('/api/payments/:paymentId/status', authenticateToken, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ message: 'User access required.' });

  const { paymentId } = req.params;
  const telegramId = req.user.telegram_id;

  // Verify this payment belongs to this user
  const wrRes = await query(
    'SELECT id, status, bygo_amount, wallet_address FROM withdrawal_requests WHERE nowpayments_payment_id = $1 AND user_id = $2',
    [paymentId, telegramId]
  );
  if (wrRes.rows.length === 0) {
    return res.status(404).json({ message: 'Payment not found.' });
  }
  const wr = wrRes.rows[0];

  // If already resolved on our side, return cached status
  if (['fee_paid', 'processing', 'completed', 'failed'].includes(wr.status)) {
    return res.json({ payment_status: wr.status, withdrawal_id: wr.id, bygo_amount: wr.bygo_amount });
  }

  // Poll NOWPayments
  let npStatus;
  try {
    npStatus = await npRequest('GET', `/payment/${paymentId}`);
  } catch (err) {
    console.error('[Payment] Status poll error:', err.message);
    return res.status(502).json({ message: 'Could not reach payment gateway. Will retry.' });
  }

  const npSt = npStatus.payment_status;
  let localStatus = wr.status;

  // Map NOWPayments terminal statuses to our status
  if (npSt === 'finished' || npSt === 'confirmed') {
    localStatus = 'fee_paid';
    await query(`
      UPDATE withdrawal_requests
      SET status = 'fee_paid', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [wr.id]);
    console.log(`[Payment] Fee confirmed for withdrawal #${wr.id} — queued for processing`);
  } else if (npSt === 'failed' || npSt === 'expired' || npSt === 'refunded') {
    localStatus = 'failed';
    await query(`
      UPDATE withdrawal_requests
      SET status = 'failed', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [wr.id]);
    console.log(`[Payment] Fee failed for withdrawal #${wr.id}`);
  }

  return res.json({
    payment_status:  localStatus,
    np_status:       npSt,
    withdrawal_id:   wr.id,
    bygo_amount:     wr.bygo_amount,
    wallet_address:  wr.wallet_address,
  });
});

// ── POST /api/payments/:paymentId/cancel ──────────────────────────────────────
app.post('/api/payments/:paymentId/cancel', authenticateToken, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ message: 'User access required.' });
  const { paymentId } = req.params;
  const telegramId = req.user.telegram_id;

  const wrRes = await query(
    "SELECT id, status FROM withdrawal_requests WHERE nowpayments_payment_id = $1 AND user_id = $2",
    [paymentId, telegramId]
  );
  if (wrRes.rows.length === 0) return res.status(404).json({ message: 'Payment not found.' });
  
  const wr = wrRes.rows[0];
  if (wr.status !== 'fee_pending') {
    return res.status(400).json({ message: 'Only pending payments can be cancelled.' });
  }

  await query(`
    UPDATE withdrawal_requests
    SET status = 'failed', admin_note = 'Cancelled due to timeout', updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
  `, [wr.id]);

  console.log(`[Payment] Withdrawal #${wr.id} cancelled (timeout) by user ${telegramId}`);
  return res.json({ success: true, status: 'failed' });
});

// ── POST /api/payments/ipn ────────────────────────────────────────────────────
// NOWPayments Instant Payment Notification callback.
// MUST use raw body to verify HMAC-SHA512 signature.
// This is the backup/server-side path alongside the polling approach.
app.post('/api/payments/ipn',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    // 1. Signature verification
    const sig = req.headers['x-nowpayments-sig'];
    if (!sig || !NP_IPN_SECRET) {
      console.warn('[IPN] Missing signature or IPN secret not configured.');
      return res.status(400).json({ message: 'Bad request.' });
    }

    const rawBody = req.body; // Buffer when express.raw is used
    const expected = crypto
      .createHmac('sha512', NP_IPN_SECRET)
      .update(rawBody)
      .digest('hex');

    if (expected !== sig) {
      console.error('[IPN] Signature mismatch — possible forgery attempt.');
      return res.status(401).json({ message: 'Invalid signature.' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ message: 'Invalid JSON payload.' });
    }

    const { payment_id, payment_status, order_id } = payload;
    if (!payment_id || !payment_status) {
      return res.status(400).json({ message: 'Missing required IPN fields.' });
    }

    // 2. Idempotent audit log (deduplicates replays)
    try {
      await query(
        'INSERT INTO payment_events (nowpayments_payment_id, event_status, raw_payload) VALUES ($1, $2, $3)',
        [String(payment_id), payment_status, payload]
      );
    } catch (dupErr) {
      // Non-fatal: continue processing even if log insert fails
      console.warn('[IPN] Could not insert payment_event:', dupErr.message);
    }

    // 3. Find associated withdrawal request
    const wrRes = await query(
      'SELECT id, user_id, bygo_amount, status FROM withdrawal_requests WHERE nowpayments_payment_id = $1',
      [String(payment_id)]
    );
    if (wrRes.rows.length === 0) {
      console.warn('[IPN] No withdrawal request found for payment_id:', payment_id);
      return res.sendStatus(200); // Acknowledge anyway
    }
    const wr = wrRes.rows[0];

    // 4. Skip if already processed
    if (['fee_paid', 'processing', 'completed'].includes(wr.status)) {
      console.log(`[IPN] Withdrawal #${wr.id} already processed — skipping duplicate IPN.`);
      return res.sendStatus(200);
    }

    // 5. Update status based on IPN event
    if (payment_status === 'finished' || payment_status === 'confirmed') {
      await query(`
        UPDATE withdrawal_requests
        SET status = 'fee_paid', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status IN ('fee_pending', 'failed')
      `, [wr.id]);
      console.log(`[IPN] Withdrawal #${wr.id} — fee confirmed via IPN`);
    } else if (payment_status === 'failed' || payment_status === 'expired' || payment_status === 'refunded') {
      await query(`
        UPDATE withdrawal_requests
        SET status = 'failed', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'fee_pending'
      `, [wr.id]);
      console.log(`[IPN] Withdrawal #${wr.id} — fee failed`);
    }

    return res.sendStatus(200);
  }
);

// ── GET /api/admin/withdrawals ────────────────────────────────────────────────
// Admin view of the full withdrawal queue
app.get('/api/admin/withdrawals', authenticateToken, requireAdmin, async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page) || 1);
  const limit  = Math.min(100, parseInt(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  const status = req.query.status || 'all'; // all | fee_pending | fee_paid | processing | completed | failed

  try {
    const conditions = [];
    const params     = [];
    let pidx = 1;

    if (status !== 'all') {
      conditions.push(`wr.status = $${pidx++}`);
      params.push(status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await query(`
      SELECT
        wr.id, wr.user_id, wr.bygo_amount, wr.wallet_address,
        wr.fee_usd, wr.fee_currency,
        wr.nowpayments_payment_id, wr.nowpayments_pay_address,
        wr.nowpayments_pay_amount, wr.nowpayments_pay_currency,
        wr.status, wr.admin_note,
        wr.created_at, wr.updated_at,
        u.first_name, u.username
      FROM withdrawal_requests wr
      JOIN users u ON u.telegram_id = wr.user_id
      ${where}
      ORDER BY wr.created_at DESC
      LIMIT $${pidx} OFFSET $${pidx + 1}
    `, [...params, limit, offset]);

    const countRes = await query(
      `SELECT COUNT(*) FROM withdrawal_requests wr ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0].count, 10);

    return res.json({ withdrawals: rows.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[Admin Withdrawals] GET error:', err);
    return res.status(500).json({ message: 'Database error' });
  }
});

// ── PUT /api/admin/withdrawals/:id ────────────────────────────────────────────
// Admin marks a withdrawal as processing or completed
app.put('/api/admin/withdrawals/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status, admin_note } = req.body;
  const validStatuses = ['processing', 'completed', 'failed'];

  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ message: `status must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    const oldStatusRes = await query('SELECT status FROM withdrawal_requests WHERE id = $1', [id]);
    if (oldStatusRes.rows.length === 0) {
      return res.status(404).json({ message: 'Withdrawal request not found.' });
    }
    const oldStatus = oldStatusRes.rows[0].status;

    const result = await query(`
      UPDATE withdrawal_requests
      SET status     = $1,
          admin_note = COALESCE($2, admin_note),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING id, status, user_id, bygo_amount
    `, [status, admin_note || null, id]);

    const wr = result.rows[0];

    // Deduct balance ONLY when transitioning to completed
    if (status === 'completed' && oldStatus !== 'completed') {
      await query('UPDATE users SET balance = balance - $1 WHERE telegram_id = $2', [wr.bygo_amount, wr.user_id]);
      console.log(`[Admin Withdrawals] #${wr.id} marked completed — ${wr.bygo_amount} $BYGO deducted from user ${wr.user_id}`);
    } else if (oldStatus === 'completed' && status !== 'completed') {
      // Revert deduction if admin un-completes it
      await query('UPDATE users SET balance = balance + $1 WHERE telegram_id = $2', [wr.bygo_amount, wr.user_id]);
      console.log(`[Admin Withdrawals] #${wr.id} un-completed — ${wr.bygo_amount} $BYGO restored to user ${wr.user_id}`);
    } else {
      console.log(`[Admin Withdrawals] #${wr.id} status → ${status} by admin`);
    }

    return res.json({ success: true, withdrawal: wr });
  } catch (err) {
    console.error('[Admin Withdrawals] PUT error:', err);
    return res.status(500).json({ message: 'Database error' });
  }
});

// ----------------------------------------------------
// Server Startup
// ----------------------------------------------------
initDB().then(() => {
  console.log("PostgreSQL Database initialized.");
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});
