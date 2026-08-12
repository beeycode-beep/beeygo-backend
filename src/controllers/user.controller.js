const { pool, query } = require('../config/db');
const ApiError = require('../middlewares/ApiError');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/me
// ─────────────────────────────────────────────────────────────────────────────
exports.getMe = async (req, res) => {
  const result = await query(
    `SELECT telegram_id, balance, total_claimed, claim_count, wallet_address,
            last_claim_time, referral_count, daily_streak, last_daily_claim,
            spins_used_today, last_spin_date
     FROM users WHERE telegram_id = $1`,
    [req.user.telegram_id]
  );
  if (result.rows.length === 0) throw ApiError.notFound('User not found.');
  res.json({ success: true, user: result.rows[0] });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/me/daily-claim
// ─────────────────────────────────────────────────────────────────────────────
exports.dailyClaim = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userRes = await client.query(
      'SELECT daily_streak, last_daily_claim FROM users WHERE telegram_id = $1 FOR UPDATE',
      [req.user.telegram_id]
    );
    if (userRes.rows.length === 0) throw ApiError.notFound('User not found.');

    const settingsRes = await client.query('SELECT config FROM settings WHERE id = 1');
    const config = settingsRes.rows[0]?.config || {};

    if (config.dailyCheckinEnabled === false) {
      throw ApiError.forbidden('Daily check-in is currently disabled.');
    }

    const baseReward   = config.dailyCheckinBaseReward || 10;
    const streakBonus  = config.dailyCheckinStreakBonus || 5;
    const maxStreak    = config.dailyCheckinMaxStreak || 7;

    const user     = userRes.rows[0];
    const nowStr   = new Date().toISOString().split('T')[0];
    const lastStr  = user.last_daily_claim ? new Date(user.last_daily_claim).toISOString().split('T')[0] : null;

    if (nowStr === lastStr) throw ApiError.badRequest('You have already claimed today.');

    const yesterday    = new Date(Date.now() - 86400000);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    const newStreak    = lastStr === yesterdayStr ? Math.min((user.daily_streak || 0) + 1, maxStreak) : 1;
    const reward       = baseReward + ((newStreak - 1) * streakBonus);

    const updated = await client.query(
      `UPDATE users
       SET balance          = balance + $1,
           total_claimed    = total_claimed + $1,
           daily_streak     = $2,
           last_daily_claim = CURRENT_TIMESTAMP
       WHERE telegram_id = $3
       RETURNING balance, daily_streak, last_daily_claim`,
      [reward, newStreak, req.user.telegram_id]
    );

    await client.query('COMMIT');
    console.log(`[Daily] User ${req.user.telegram_id} claimed ${reward} $BYGO (streak ${newStreak})`);
    res.json({ success: true, reward, streak: newStreak, ...updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/me/spin
// ─────────────────────────────────────────────────────────────────────────────
exports.spin = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userRes = await client.query(
      'SELECT spins_used_today, last_spin_date FROM users WHERE telegram_id = $1 FOR UPDATE',
      [req.user.telegram_id]
    );
    if (userRes.rows.length === 0) throw ApiError.notFound('User not found.');

    const settingsRes = await client.query('SELECT config FROM settings WHERE id = 1');
    const config = settingsRes.rows[0]?.config || {};

    if (config.spinSystemEnabled === false) throw ApiError.forbidden('Spin system is currently disabled.');

    const user   = userRes.rows[0];
    const nowStr = new Date().toISOString().split('T')[0];
    const lastStr = user.last_spin_date ? new Date(user.last_spin_date).toISOString().split('T')[0] : null;

    // Reset counter for new day
    let spinsUsed = nowStr !== lastStr ? 0 : (user.spins_used_today || 0);
    const maxSpins = config.maxDailySpins || 2;

    if (spinsUsed >= maxSpins) throw ApiError.badRequest(`No spins remaining today. Come back tomorrow.`);

    // Server-side weighted random outcome
    const rand = Math.random();
    let reward = 10;
    if (rand > 0.98)      reward = 500;   // 2%
    else if (rand > 0.93) reward = 250;   // 5%
    else if (rand > 0.83) reward = 100;   // 10%
    else if (rand > 0.65) reward = 50;    // 18%
    else if (rand > 0.35) reward = 20;    // 30%
    // else                 reward = 10    // 35%

    spinsUsed++;

    const updated = await client.query(
      `UPDATE users
       SET balance          = balance + $1,
           total_claimed    = total_claimed + $1,
           spins_used_today = $2,
           last_spin_date   = CURRENT_TIMESTAMP
       WHERE telegram_id = $3
       RETURNING balance, spins_used_today, last_spin_date`,
      [reward, spinsUsed, req.user.telegram_id]
    );

    await client.query('COMMIT');
    console.log(`[Spin] User ${req.user.telegram_id} won ${reward} $BYGO (spin ${spinsUsed}/${maxSpins})`);
    res.json({ success: true, reward, spins_remaining: maxSpins - spinsUsed, ...updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/leaderboard
// ─────────────────────────────────────────────────────────────────────────────
exports.leaderboard = async (req, res) => {
  const userId = req.user?.telegram_id;

  const result = await query(
    `SELECT telegram_id, first_name, username, balance
     FROM users
     ORDER BY balance DESC
     LIMIT 5`
  );

  const top = result.rows.map((u, index) => ({
    rank: index + 1,
    id: u.first_name || (u.username ? `@${u.username}` : `User ${String(u.telegram_id).slice(-4)}`),
    balance: u.balance || 0,
    isCurrentUser: String(u.telegram_id) === String(userId),
  }));

  let currentUser = null;
  const isInTop = top.some(u => u.isCurrentUser);

  if (!isInTop && userId) {
    const userRes = await query(
      'SELECT first_name, username, balance FROM users WHERE telegram_id = $1',
      [userId]
    );
    if (userRes.rows.length > 0) {
      const u = userRes.rows[0];
      const rankRes = await query('SELECT COUNT(*) FROM users WHERE balance > $1', [u.balance]);
      const rank = parseInt(rankRes.rows[0].count, 10) + 1;
      currentUser = {
        rank,
        id: (u.first_name || (u.username ? `@${u.username}` : `User ${String(userId).slice(-4)}`)) + ' (You)',
        balance: u.balance || 0,
        isCurrentUser: true,
      };
    }
  }

  res.json({ success: true, top, currentUser });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/me/claim — Mining Claim
// ─────────────────────────────────────────────────────────────────────────────
exports.claim = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userRes = await client.query(
      `SELECT balance, total_claimed, claim_count, last_claim_time
       FROM users WHERE telegram_id = $1 FOR UPDATE`,
      [req.user.telegram_id]
    );
    if (userRes.rows.length === 0) throw ApiError.notFound('User not found.');

    const user = userRes.rows[0];
    const settingsRes = await client.query('SELECT config FROM settings WHERE id = 1');
    const config = settingsRes.rows[0]?.config || {};

    if (config.miningPaused) throw ApiError.forbidden('Mining is currently paused by admin.');

    const cycleMinutes = config.miningCycleMinutes || 60;
    const cooldownMs   = cycleMinutes * 60 * 1000 - 5000; // 5-second clock skew tolerance

    if (user.last_claim_time) {
      const elapsed = Date.now() - new Date(user.last_claim_time).getTime();
      if (elapsed < cooldownMs) {
        throw ApiError.tooManyRequests('Mining cooldown not complete.');
      }
    }

    const baseReward  = config.baseHourlyReward || 6;
    const multiplier  = config.rewardMultiplier || 1;
    const doubleBonus = config.doubleRewardEvent ? 2 : 1;
    const safeReward  = Math.round(baseReward * multiplier * doubleBonus);

    const updated = await client.query(
      `UPDATE users
       SET balance         = balance + $1,
           total_claimed   = total_claimed + $1,
           claim_count     = claim_count + 1,
           last_claim_time = NOW()
       WHERE telegram_id = $2
       RETURNING balance, total_claimed, claim_count, last_claim_time`,
      [safeReward, req.user.telegram_id]
    );

    await client.query('COMMIT');
    console.log(`[Claim] User ${req.user.telegram_id} claimed ${safeReward} $BYGO`);
    res.json({ success: true, reward: safeReward, ...updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/me/wallet
// ─────────────────────────────────────────────────────────────────────────────
exports.saveWallet = async (req, res) => {
  const { walletAddress } = req.body;
  // Secondary server-side guard (primary is route validator)
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    throw ApiError.badRequest('Invalid BEP-20 wallet address format.');
  }
  const result = await query(
    'UPDATE users SET wallet_address = $1 WHERE telegram_id = $2 RETURNING wallet_address',
    [walletAddress, req.user.telegram_id]
  );
  if (result.rows.length === 0) throw ApiError.notFound('User not found.');
  res.json({ success: true, walletAddress: result.rows[0].wallet_address });
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/users/me/wallet
// ─────────────────────────────────────────────────────────────────────────────
exports.removeWallet = async (req, res) => {
  await query('UPDATE users SET wallet_address = NULL WHERE telegram_id = $1', [req.user.telegram_id]);
  res.json({ success: true });
};
