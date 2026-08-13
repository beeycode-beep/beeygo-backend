const { pool, query } = require('../config/db');
const ApiError = require('../middlewares/ApiError');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { triggerAutoTransfer } = require('../services/bsc.service');
const { logVerification, sendRewardNotification } = require('../../taskVerifier');
const { confirmationEmail, adminNotificationEmail, approvalEmail, rejectionEmail } = require('../utils/email');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FALLBACK_SETTINGS_FILE = path.join(__dirname, '../../data', 'settings.json');

// ── Email Transporter ────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587', 10),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: { rejectUnauthorized: false },
});

const isEmailConfigured = () =>
  process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_USER !== 'your@gmail.com';

const sendMail = (opts) => {
  if (!isEmailConfigured()) return Promise.resolve(null);
  return transporter.sendMail(opts).catch(e =>
    console.error('[Email] Failed to send to', opts.to, ':', e.message)
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// TASKS — Admin CRUD
// ─────────────────────────────────────────────────────────────────────────────

exports.getTasks = async (req, res) => {
  const result = await query('SELECT * FROM tasks ORDER BY created_at DESC');
  res.json({ success: true, tasks: result.rows });
};

exports.createTask = async (req, res) => {
  const { title, description, reward, link, platform, active, verification_type, chat_id, expires_at } = req.body;
  const VALID_TYPES = ['auto', 'telegram_join', 'telegram_dm', 'code_submit'];
  const verType = VALID_TYPES.includes(verification_type) ? verification_type : 'auto';

  // Default: expires 24 hours from now. Pass expires_at: null to never expire.
  const expiresAt = expires_at === null ? null
    : expires_at ? new Date(expires_at).toISOString()
    : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const result = await query(
    `INSERT INTO tasks (title, description, reward, link, platform, active, verification_type, chat_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [title, description || null, reward, link || null, platform || null, active !== false, verType, chat_id || null, expiresAt]
  );
  res.status(201).json({ success: true, task: result.rows[0] });
};

exports.updateTask = async (req, res) => {
  const { title, description, reward, link, platform, active, verification_type, chat_id, expires_at } = req.body;
  const VALID_TYPES = ['auto', 'telegram_join', 'telegram_dm', 'code_submit'];
  const verType = verification_type && VALID_TYPES.includes(verification_type) ? verification_type : undefined;

  // If expires_at is explicitly provided (even null), honour it. Otherwise keep existing value.
  const expiresAtValue = expires_at === null ? null
    : expires_at ? new Date(expires_at).toISOString()
    : undefined;

  const result = await query(
    `UPDATE tasks
     SET title             = COALESCE($1, title),
         description       = COALESCE($2, description),
         reward            = COALESCE($3, reward),
         link              = COALESCE($4, link),
         platform          = COALESCE($5, platform),
         active            = COALESCE($6, active),
         verification_type = COALESCE($7, verification_type),
         chat_id           = COALESCE($8, chat_id),
         expires_at        = CASE WHEN $9::boolean THEN $10::timestamp ELSE expires_at END,
         updated_at        = CURRENT_TIMESTAMP
     WHERE id = $11
     RETURNING *`,
    [title, description, reward, link, platform, active, verType ?? null, chat_id ?? null,
     expiresAtValue !== undefined, expiresAtValue ?? null, req.params.id]
  );
  if (result.rows.length === 0) throw ApiError.notFound('Task not found.');
  res.json({ success: true, task: result.rows[0] });
};

exports.deleteTask = async (req, res) => {
  const result = await query('DELETE FROM tasks WHERE id = $1 RETURNING id', [req.params.id]);
  if (result.rows.length === 0) throw ApiError.notFound('Task not found.');
  res.json({ success: true });
};

// ───────────────────────────────────────────────────────────────────────────────
// ADS — Admin CRUD
// ───────────────────────────────────────────────────────────────────────────────

exports.getAds = async (req, res) => {
  const result = await query('SELECT * FROM ads ORDER BY created_at DESC');
  res.json({ success: true, ads: result.rows });
};

exports.getActiveAd = async (req, res) => {
  const result = await query(
    'SELECT * FROM ads WHERE active = true ORDER BY created_at DESC LIMIT 1'
  );
  if (result.rows.length === 0) return res.json({ success: true, ad: null });
  res.json({ success: true, ad: result.rows[0] });
};

exports.createAd = async (req, res) => {
  const { title, description, image_url, link_url, cta_text, display_seconds, active } = req.body;
  const result = await query(
    `INSERT INTO ads (title, description, image_url, link_url, cta_text, display_seconds, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      title,
      description || null,
      image_url || null,
      link_url || null,
      cta_text || 'Learn More',
      display_seconds || 10,
      active !== false,
    ]
  );
  res.status(201).json({ success: true, ad: result.rows[0] });
};

exports.updateAd = async (req, res) => {
  const { title, description, image_url, link_url, cta_text, display_seconds, active } = req.body;
  const result = await query(
    `UPDATE ads
     SET title           = COALESCE($1, title),
         description     = COALESCE($2, description),
         image_url       = COALESCE($3, image_url),
         link_url        = COALESCE($4, link_url),
         cta_text        = COALESCE($5, cta_text),
         display_seconds = COALESCE($6, display_seconds),
         active          = COALESCE($7, active),
         updated_at      = CURRENT_TIMESTAMP
     WHERE id = $8
     RETURNING *`,
    [title, description, image_url, link_url, cta_text, display_seconds, active, req.params.id]
  );
  if (result.rows.length === 0) throw ApiError.notFound('Ad not found.');
  res.json({ success: true, ad: result.rows[0] });
};

exports.deleteAd = async (req, res) => {
  const result = await query('DELETE FROM ads WHERE id = $1 RETURNING id', [req.params.id]);
  if (result.rows.length === 0) throw ApiError.notFound('Ad not found.');
  res.json({ success: true });
};

// ─────────────────────────────────────────────────────────────────────────────
// SUBMISSIONS — Admin Approval
// ─────────────────────────────────────────────────────────────────────────────

exports.getAllSubmissions = async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page) || 1);
  const limit  = Math.min(100, parseInt(req.query.limit) || 50);
  const offset = (page - 1) * limit;

  const rows = await query(
    `SELECT ut.user_id, ut.task_id, ut.status, ut.verification_token AS proof,
            u.first_name, u.username,
            t.title AS task_title, t.reward
     FROM user_tasks ut
     JOIN users u ON u.telegram_id = ut.user_id
     JOIN tasks t ON t.id = ut.task_id
     WHERE ut.status = 'pending_review' AND t.verification_type = 'code_submit'
     ORDER BY ut.task_id, ut.user_id
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const countRes = await query(
    `SELECT COUNT(*) FROM user_tasks ut
     JOIN tasks t ON t.id = ut.task_id
     WHERE ut.status = 'pending_review' AND t.verification_type = 'code_submit'`
  );
  const total = parseInt(countRes.rows[0].count, 10);
  res.json({ success: true, submissions: rows.rows, total, page, pages: Math.ceil(total / limit) });
};

exports.approveSubmission = async (req, res) => {
  const { taskId, userId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const taskRes = await client.query(
      'SELECT reward, title, verification_type FROM tasks WHERE id = $1',
      [taskId]
    );
    if (taskRes.rows.length === 0) throw ApiError.notFound('Task not found.');
    if (taskRes.rows[0].verification_type !== 'code_submit') {
      throw ApiError.badRequest('This task does not use code_submit verification.');
    }

    const utRes = await client.query(
      'SELECT status FROM user_tasks WHERE user_id = $1 AND task_id = $2',
      [userId, taskId]
    );
    if (utRes.rows.length === 0) throw ApiError.notFound('No pending submission found for this user and task.');
    if (utRes.rows[0].status === 'completed') throw ApiError.conflict('Already completed.');

    const settingsRes = await client.query('SELECT config FROM settings WHERE id = 1');
    const config = settingsRes.rows[0]?.config || {};
    const finalReward = Math.round(taskRes.rows[0].reward * (config.taskRewardMultiplier || 1));

    await client.query(
      `UPDATE user_tasks
       SET status = 'completed', completed_at = CURRENT_TIMESTAMP, verification_token = NULL
       WHERE user_id = $1 AND task_id = $2`,
      [userId, taskId]
    );
    await client.query(
      'UPDATE users SET balance = balance + $1, total_claimed = total_claimed + $1 WHERE telegram_id = $2',
      [finalReward, userId]
    );
    await logVerification(pool, userId, taskId, 'code_submit_approved', 'pass', 'admin_approved');
    await client.query('COMMIT');

    sendRewardNotification(TELEGRAM_BOT_TOKEN, userId, taskRes.rows[0].title, finalReward)
      .catch(e => console.warn('[Admin] Reward notification failed:', e.message));

    console.log(`[Admin] Approved code_submit: user ${userId} task #${taskId} (+${finalReward} $BYGO)`);
    res.json({ success: true, reward: finalReward });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

exports.getSettings = async (req, res) => {
  const result = await query('SELECT config FROM settings WHERE id = 1');
  if (result.rows.length > 0) return res.json({ success: true, settings: result.rows[0].config });
  // File fallback for development/cold-start
  if (fs.existsSync(FALLBACK_SETTINGS_FILE)) {
    return res.json({ success: true, settings: JSON.parse(fs.readFileSync(FALLBACK_SETTINGS_FILE, 'utf8')) });
  }
  res.json({ success: true, settings: {} });
};

exports.updateSettings = async (req, res) => {
  const newSettings = req.body;
  await query(
    `INSERT INTO settings (id, config) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`,
    [newSettings]
  );
  // Best-effort file backup (non-blocking, non-fatal)
  try {
    const dir = path.dirname(FALLBACK_SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FALLBACK_SETTINGS_FILE, JSON.stringify(newSettings, null, 2));
  } catch (e) {
    console.warn('[Settings] Could not write backup file:', e.message);
  }
  res.json({ success: true, settings: newSettings });
};

// ─────────────────────────────────────────────────────────────────────────────
// USERS — Admin
// ─────────────────────────────────────────────────────────────────────────────

exports.getUsers = async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page) || 1);
  const limit  = Math.min(100, parseInt(req.query.limit) || 50);
  const search = (req.query.search || '').trim();
  const sort   = req.query.sort === 'balance' ? 'balance DESC' : 'created_at DESC';
  const offset = (page - 1) * limit;

  let queryText, params;
  if (search) {
    queryText = `
      SELECT telegram_id, username, first_name, balance, total_claimed, claim_count,
             referral_count, wallet_address, last_claim_time, created_at
      FROM users
      WHERE username ILIKE $1 OR first_name ILIKE $1 OR CAST(telegram_id AS TEXT) LIKE $1
      ORDER BY ${sort}
      LIMIT $2 OFFSET $3
    `;
    params = [`%${search}%`, limit, offset];
  } else {
    queryText = `
      SELECT telegram_id, username, first_name, balance, total_claimed, claim_count,
             referral_count, wallet_address, last_claim_time, created_at
      FROM users
      ORDER BY ${sort}
      LIMIT $1 OFFSET $2
    `;
    params = [limit, offset];
  }

  const [result, countRes] = await Promise.all([
    query(queryText, params),
    query('SELECT COUNT(*) FROM users'),
  ]);
  const total = parseInt(countRes.rows[0].count, 10);
  res.json({ success: true, users: result.rows, total, page, pages: Math.ceil(total / limit) });
};

exports.adjustUserBalance = async (req, res) => {
  const telegramId = req.params.id;
  const { balance, reason } = req.body;

  const result = await query(
    'UPDATE users SET balance = $1 WHERE telegram_id = $2 RETURNING telegram_id, balance',
    [balance, telegramId]
  );
  if (result.rows.length === 0) throw ApiError.notFound('User not found.');
  console.log(`[Admin] Balance for user ${telegramId} set to ${balance}. Reason: ${reason || 'none'}`);
  res.json({ success: true, ...result.rows[0] });
};

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD STATS
// ─────────────────────────────────────────────────────────────────────────────

exports.getStats = async (req, res) => {
  const [usersRes, appsRes, tokenRes, withdrawalRes] = await Promise.all([
    query('SELECT COUNT(*) as total, COUNT(wallet_address) as with_wallet FROM users'),
    query(`
      SELECT COUNT(*) as total,
             COUNT(*) FILTER (WHERE status = 'pending')  as pending,
             COUNT(*) FILTER (WHERE status = 'approved') as approved,
             COUNT(*) FILTER (WHERE status = 'rejected') as rejected
      FROM ambassador_applications
    `),
    query('SELECT COALESCE(SUM(total_claimed), 0) as total_mined FROM users'),
    query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'completed')      as completed_count,
        COALESCE(SUM(bygo_amount) FILTER (WHERE status = 'completed'), 0) as total_distributed
      FROM withdrawal_requests
    `),
  ]);

  res.json({
    success: true,
    users: {
      total:      parseInt(usersRes.rows[0].total, 10),
      withWallet: parseInt(usersRes.rows[0].with_wallet, 10),
    },
    applications: {
      total:    parseInt(appsRes.rows[0].total, 10),
      pending:  parseInt(appsRes.rows[0].pending, 10),
      approved: parseInt(appsRes.rows[0].approved, 10),
      rejected: parseInt(appsRes.rows[0].rejected, 10),
    },
    tokensMined:      parseInt(tokenRes.rows[0].total_mined, 10),
    totalDistributed: parseInt(withdrawalRes.rows[0].total_distributed, 10),
    completedWithdrawals: parseInt(withdrawalRes.rows[0].completed_count, 10),
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// AMBASSADOR APPLICATIONS
// ─────────────────────────────────────────────────────────────────────────────

exports.getApplications = async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page) || 1);
  const limit  = Math.min(100, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const status = req.query.status || 'all';
  const search = (req.query.search || '').trim();

  const conditions = [];
  const params     = [];
  let pidx = 1;

  if (status !== 'all') {
    conditions.push(`status = $${pidx++}`);
    params.push(status);
  }
  if (search) {
    conditions.push(`(first_name ILIKE $${pidx} OR last_name ILIKE $${pidx} OR email ILIKE $${pidx} OR telegram ILIKE $${pidx} OR twitter ILIKE $${pidx})`);
    params.push(`%${search}%`);
    pidx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [dataRes, countRes] = await Promise.all([
    query(
      `SELECT id, first_name, last_name, email, country, telegram, twitter,
              channel_handle, user_handle, social_url, follower_count, niche,
              motivation, promotion_plan, status, admin_notes, reviewed_at, created_at
       FROM ambassador_applications
       ${where}
       ORDER BY created_at DESC
       LIMIT $${pidx} OFFSET $${pidx + 1}`,
      [...params, limit, offset]
    ),
    query(`SELECT COUNT(*) FROM ambassador_applications ${where}`, params),
  ]);

  const total = parseInt(countRes.rows[0].count, 10);
  res.json({ success: true, applications: dataRes.rows, total, page, pages: Math.ceil(total / limit) });
};

exports.getApplication = async (req, res) => {
  const result = await query('SELECT * FROM ambassador_applications WHERE id = $1', [req.params.id]);
  if (result.rows.length === 0) throw ApiError.notFound('Application not found.');
  res.json({ success: true, application: result.rows[0] });
};

exports.updateApplication = async (req, res) => {
  const { status, admin_notes } = req.body;

  const result = await query(
    `UPDATE ambassador_applications
     SET status      = $1,
         admin_notes = COALESCE($2, admin_notes),
         reviewed_at = CASE WHEN $1 IN ('approved', 'rejected') THEN CURRENT_TIMESTAMP ELSE reviewed_at END
     WHERE id = $3
     RETURNING *`,
    [status, admin_notes || null, req.params.id]
  );
  if (result.rows.length === 0) throw ApiError.notFound('Application not found.');

  const app = result.rows[0];
  console.log(`[Admin] Application #${app.id} (${app.email}) → ${status}`);

  // Send decision email asynchronously
  if (status === 'approved' || status === 'rejected') {
    const from    = `"${process.env.FROM_NAME || 'BeeyGO Official'}" <${process.env.SMTP_USER}>`;
    const subject = status === 'approved'
      ? `🎉 Congratulations! Your BeeyGO Ambassador Application is Approved`
      : `BeeyGO Ambassador Application Update — ${app.first_name}`;
    const html = status === 'approved' ? approvalEmail(app) : rejectionEmail(app);

    sendMail({ from, to: app.email, subject, html });
  }

  res.json({ success: true, application: app });
};

exports.deleteApplication = async (req, res) => {
  const result = await query(
    'DELETE FROM ambassador_applications WHERE id = $1 RETURNING id, email',
    [req.params.id]
  );
  if (result.rows.length === 0) throw ApiError.notFound('Application not found.');
  console.log(`[Admin] Deleted application #${result.rows[0].id} (${result.rows[0].email})`);
  res.json({ success: true });
};

// ─────────────────────────────────────────────────────────────────────────────
// WITHDRAWALS — Admin
// ─────────────────────────────────────────────────────────────────────────────

exports.getWithdrawals = async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page) || 1);
  const limit  = Math.min(100, parseInt(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  const status = req.query.status || 'all';

  const conditions = [];
  const params     = [];
  let pidx = 1;

  if (status !== 'all') {
    conditions.push(`wr.status = $${pidx++}`);
    params.push(status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows, countRes] = await Promise.all([
    query(
      `SELECT wr.id, wr.user_id, wr.bygo_amount, wr.wallet_address,
              wr.fee_usd, wr.fee_currency,
              wr.nowpayments_payment_id, wr.nowpayments_pay_address,
              wr.nowpayments_pay_amount, wr.nowpayments_pay_currency,
              wr.status, wr.admin_note, wr.tx_hash, wr.processed_at,
              wr.created_at, wr.updated_at,
              u.first_name, u.username
       FROM withdrawal_requests wr
       JOIN users u ON u.telegram_id = wr.user_id
       ${where}
       ORDER BY wr.created_at DESC
       LIMIT $${pidx} OFFSET $${pidx + 1}`,
      [...params, limit, offset]
    ),
    query(`SELECT COUNT(*) FROM withdrawal_requests wr ${where}`, params),
  ]);

  const total = parseInt(countRes.rows[0].count, 10);
  res.json({ success: true, withdrawals: rows.rows, total, page, pages: Math.ceil(total / limit) });
};

exports.updateWithdrawal = async (req, res) => {
  const { id }                         = req.params;
  const { status: newStatus, admin_note } = req.body;

  // Fetch current state first
  const oldRes = await query(
    'SELECT status, bygo_amount, user_id FROM withdrawal_requests WHERE id = $1',
    [id]
  );
  if (oldRes.rows.length === 0) throw ApiError.notFound('Withdrawal not found.');
  const { status: oldStatus, bygo_amount: bygoAmount, user_id: userId } = oldRes.rows[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE withdrawal_requests
       SET status     = $1,
           admin_note = COALESCE($2, admin_note),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING id, status, user_id, bygo_amount`,
      [newStatus, admin_note || null, id]
    );
    const wr = result.rows[0];

    // Handle balance adjustments for manual status changes
    const inactiveStatuses = ['failed', 'transfer_failed'];
    const oldIsInactive = inactiveStatuses.includes(oldStatus);
    const newIsInactive = inactiveStatuses.includes(newStatus);

    if (newIsInactive && !oldIsInactive) {
      // Moving to inactive state -> refund the instantly deducted balance
      await client.query(
        'UPDATE users SET balance = balance + $1 WHERE telegram_id = $2',
        [bygoAmount, userId]
      );
      console.log(`[Admin] Withdrawal #${id} marked as failed — ${bygoAmount} $BYGO refunded to user ${userId}`);
    } else if (!newIsInactive && oldIsInactive) {
      // Moving from inactive state to active -> deduct the balance again
      await client.query(
        'UPDATE users SET balance = GREATEST(0, balance - $1) WHERE telegram_id = $2',
        [bygoAmount, userId]
      );
      console.log(`[Admin] Withdrawal #${id} reactivated — ${bygoAmount} $BYGO deducted from user ${userId}`);
    }

    await client.query('COMMIT');
    res.json({ success: true, withdrawal: wr });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

exports.retryWithdrawal = async (req, res) => {
  const { id } = req.params;

  const wrRes = await query(
    'SELECT id, user_id, bygo_amount, wallet_address, status FROM withdrawal_requests WHERE id = $1',
    [id]
  );
  if (wrRes.rows.length === 0) throw ApiError.notFound('Withdrawal not found.');
  const wr = wrRes.rows[0];

  if (wr.status !== 'transfer_failed') {
    throw ApiError.badRequest(`Can only retry transfer_failed withdrawals. Current status: ${wr.status}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE withdrawal_requests
       SET status = 'fee_paid', admin_note = 'Admin retry initiated', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [id]
    );
    // Deduct balance again since it was refunded when it failed
    await client.query(
      `UPDATE users SET balance = GREATEST(0, balance - $1) WHERE telegram_id = $2`,
      [wr.bygo_amount, wr.user_id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  console.log(`[Admin] Retrying on-chain transfer for withdrawal #${id}...`);
  triggerAutoTransfer({ ...wr, status: 'fee_paid' })
    .catch(e => console.error('[Admin Retry] triggerAutoTransfer error:', e.message));

  res.json({ success: true, message: `Retry initiated for withdrawal #${id}. Check status in a moment.` });
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — Ambassador Application Submit
// ─────────────────────────────────────────────────────────────────────────────

exports.applyForAmbassador = async (req, res) => {
  const data = req.body;

  try {
    await query(
      `INSERT INTO ambassador_applications
         (first_name, last_name, email, country, telegram, twitter,
          channel_handle, user_handle, social_url, follower_count,
          niche, motivation, promotion_plan)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        data.firstName, data.lastName, data.email, data.country,
        data.telegram, data.twitter, data.channelHandle, data.userHandle,
        data.socialUrl || null, data.followerCount,
        data.niche, data.motivation, data.promotionPlan,
      ]
    );
  } catch (dbErr) {
    if (dbErr.code === '23505') {
      throw ApiError.conflict('An application with this email has already been submitted.');
    }
    throw dbErr;
  }

  // Non-blocking email dispatch
  const from       = `"${process.env.FROM_NAME || 'BeeyGO Official'}" <${process.env.SMTP_USER}>`;
  const adminEmail = process.env.TEAM_EMAIL || process.env.SMTP_USER;

  sendMail({ from, to: data.email,  subject: `🎉 BeeyGO Ambassador Application Received — ${data.firstName}!`, html: confirmationEmail(data) });
  sendMail({ from, to: adminEmail, replyTo: data.email, subject: `[BYGO] New Ambassador Application — ${data.firstName} ${data.lastName} (@${data.twitter})`, html: adminNotificationEmail(data) });

  console.log(`[Apply] Application from ${data.email} saved successfully.`);
  res.json({ success: true, message: 'Application submitted! Check your email for confirmation.' });
};

exports.getApplicationsCount = async (req, res) => {
  const result = await query('SELECT COUNT(*) FROM ambassador_applications');
  res.json({ success: true, count: parseInt(result.rows[0].count, 10) });
};
