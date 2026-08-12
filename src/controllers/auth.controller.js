const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool, query } = require('../config/db');
const ApiError = require('../middlewares/ApiError');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login — Admin Login
// ─────────────────────────────────────────────────────────────────────────────
exports.adminLogin = async (req, res, next) => {
  const { email, password } = req.body;
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminHash = process.env.ADMIN_PASSWORD_HASH;
  const jwtSecret = process.env.JWT_SECRET;

  const emailMatch = email === adminEmail;
  const hashToCheck = adminHash || '$2a$10$invalidhashpadding000000000000000000000000000000000000';
  const isMatch = await bcrypt.compare(password, hashToCheck);

  if (!emailMatch || !isMatch) {
    throw ApiError.unauthorized('Invalid credentials.');
  }

  const token = jwt.sign({ email: adminEmail, role: 'admin' }, jwtSecret, { expiresIn: '24h' });
  res.json({ success: true, token, message: 'Login successful' });
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/verify — Verify Token
// ─────────────────────────────────────────────────────────────────────────────
exports.verifyUser = async (req, res, next) => {
  if (req.user.role === 'user') {
    const result = await query(
      'SELECT telegram_id, username, first_name, referral_count FROM users WHERE telegram_id = $1',
      [req.user.telegram_id]
    );
    if (result.rows.length === 0) {
      throw ApiError.unauthorized('User record not found. Please re-authenticate.');
    }
    const u = result.rows[0];
    return res.json({
      success: true,
      user: {
        id: parseInt(u.telegram_id, 10),
        username: u.username,
        first_name: u.first_name,
        referral_count: u.referral_count,
      },
    });
  }
  res.json({ success: true, user: req.user });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/telegram — Telegram Mini-App Auth
// ─────────────────────────────────────────────────────────────────────────────
exports.telegramAuth = async (req, res, next) => {
  const { initData } = req.body;
  if (!initData) throw ApiError.badRequest('initData is required.');

  // Always read from process.env dynamically at request time
  const rawToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const jwtSecret = process.env.JWT_SECRET;

  if (!rawToken) {
    throw ApiError.internal('Server misconfiguration: TELEGRAM_BOT_TOKEN is not set.');
  }
  if (!jwtSecret) {
    throw ApiError.internal('Server misconfiguration: JWT_SECRET is not set.');
  }

  // Strip quotes just in case they were accidentally included in Vercel dashboard
  const botToken = rawToken.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');

  const urlParams = new URLSearchParams(initData);
  const hash      = urlParams.get('hash');
  const authDate  = urlParams.get('auth_date');

  if (!hash || !authDate) throw ApiError.unauthorized('Invalid Telegram data: Missing hash or auth_date.');

  // Validate auth_date freshness (10-minute window in production)
  const now = Math.floor(Date.now() / 1000);
  if (process.env.NODE_ENV === 'production') {
    const authTime = parseInt(authDate, 10);
    if (isNaN(authTime)) throw ApiError.unauthorized('Invalid Telegram data: auth_date is not a number.');
    if (now - authTime > 600) {
      throw ApiError.unauthorized('Telegram session expired. Please close and reopen the Mini-App.');
    }
  }

  // Reconstruct data check string
  urlParams.delete('hash');
  const dataCheckString = Array.from(urlParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const calculatedHash = crypto.createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (calculatedHash !== hash) {
    throw ApiError.unauthorized('Invalid Telegram signature. Verification failed.');
  }

  const userStr = urlParams.get('user');
  if (!userStr) throw ApiError.badRequest('User data missing from initData.');


  let user;
  try {
    user = JSON.parse(userStr);
  } catch {
    throw ApiError.badRequest('Malformed user data in initData.');
  }

  const { id: telegramId, username, first_name } = user;
  if (!telegramId) throw ApiError.badRequest('Invalid telegram user ID.');

  // Parse referral from start_param
  const startParam = urlParams.get('start_param');
  let referredBy = null;
  if (startParam && startParam.startsWith('ref_')) {
    const refId = parseInt(startParam.replace('ref_', ''), 10);
    if (!isNaN(refId) && refId !== telegramId) referredBy = refId;
  }

  // Upsert user atomically — new user gets referral counted once
  // NOTE: declared OUTSIDE the try block so it is accessible after client.release()
  let currentReferralCount = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT telegram_id, referral_count FROM users WHERE telegram_id = $1',
      [telegramId]
    );

    if (existing.rows.length === 0) {
      // New user — insert and optionally bump referral count
      await client.query(
        'INSERT INTO users (telegram_id, username, first_name, referred_by) VALUES ($1, $2, $3, $4)',
        [telegramId, username || null, first_name || null, referredBy]
      );
      if (referredBy) {
        // Only give bonus if referrer exists
        await client.query(
          'UPDATE users SET referral_count = referral_count + 1 WHERE telegram_id = $1',
          [referredBy]
        );
      }
    } else {
      // Returning user — update display name only
      currentReferralCount = existing.rows[0].referral_count;
      await client.query(
        'UPDATE users SET username = $1, first_name = $2 WHERE telegram_id = $3',
        [username || null, first_name || null, telegramId]
      );
    }

    await client.query('COMMIT');
  } catch (dbErr) {
    await client.query('ROLLBACK');
    throw dbErr;
  } finally {
    client.release();
  }

  const token = jwt.sign(
    { telegram_id: telegramId, username, role: 'user' },
    jwtSecret,
    { expiresIn: '72h' }
  );

  res.json({ success: true, token, user: { id: telegramId, username, first_name, referral_count: currentReferralCount } });
};
