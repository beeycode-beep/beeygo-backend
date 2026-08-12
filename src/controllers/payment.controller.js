const crypto = require('crypto');
const { pool, query } = require('../config/db');
const { triggerAutoTransfer } = require('../services/bsc.service');
const ApiError = require('../middlewares/ApiError');

const NP_API_KEY        = process.env.NOWPAYMENTS_API_KEY || '';
const NP_IPN_SECRET     = process.env.NOWPAYMENTS_IPN_SECRET_KEY || '';
const WITHDRAWAL_FEE    = parseFloat(process.env.WITHDRAWAL_FEE_USD || '0.50');
const WITHDRAWAL_FEE_CUR = process.env.WITHDRAWAL_FEE_CURRENCY || 'trx';
const BACKEND_URL       = process.env.BACKEND_URL || 'https://beeygo-backend.vercel.app';
const NP_API_BASE       = 'https://api.nowpayments.io/v1';

// ─────────────────────────────────────────────────────────────────────────────
// Internal: NOWPayments API request helper
// ─────────────────────────────────────────────────────────────────────────────
async function npRequest(method, path, body) {
  const opts = {
    method,
    headers: { 'x-api-key': NP_API_KEY, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(`${NP_API_BASE}${path}`, opts);
  } catch (fetchErr) {
    throw ApiError.badGateway(`NOWPayments unreachable: ${fetchErr.message}`);
  }

  const json = await res.json();
  if (!res.ok) {
    const err = ApiError.badGateway(json.message || 'NOWPayments error');
    err.npError = json;
    err.status = res.status === 401 ? 502 : res.status; // normalize auth errors
    throw err;
  }
  return json;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/create-withdrawal-fee
// ─────────────────────────────────────────────────────────────────────────────
exports.createWithdrawalFee = async (req, res) => {
  const bygoAmount = parseInt(req.body.bygoAmount, 10);
  if (!Number.isInteger(bygoAmount) || bygoAmount <= 0) {
    throw ApiError.badRequest('bygoAmount must be a positive integer.');
  }

  const telegramId = req.user.telegram_id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock and fetch user
    const userRes = await client.query(
      'SELECT balance, wallet_address FROM users WHERE telegram_id = $1 FOR UPDATE',
      [telegramId]
    );
    if (userRes.rows.length === 0) throw ApiError.notFound('User not found.');
    const user = userRes.rows[0];

    if (!user.wallet_address) {
      throw ApiError.badRequest('Please link a BEP-20 wallet address before withdrawing.');
    }

    // Fetch and validate settings
    const settingsRes = await client.query('SELECT config FROM settings WHERE id = 1');
    const config = settingsRes.rows[0]?.config || {};

    if (!config.withdrawalsEnabled) {
      throw ApiError.forbidden('Withdrawals are currently disabled by admin.');
    }

    const minWithdrawal = config.minWithdrawal || 1000;
    if (bygoAmount < minWithdrawal) {
      throw ApiError.badRequest(`Minimum withdrawal is ${minWithdrawal} $BYGO.`);
    }

    if (bygoAmount > user.balance) {
      throw ApiError.badRequest(
        `Insufficient balance. Available: ${user.balance} $BYGO.`
      );
    }

    const insertRes = await client.query(
      `INSERT INTO withdrawal_requests
         (user_id, bygo_amount, wallet_address, fee_usd, fee_currency, status)
       VALUES ($1, $2, $3, $4, $5, 'fee_pending')
       RETURNING id`,
      [telegramId, bygoAmount, user.wallet_address, WITHDRAWAL_FEE, WITHDRAWAL_FEE_CUR]
    );
    const withdrawalId = insertRes.rows[0].id;

    // Instantly deduct balance
    await client.query(
      'UPDATE users SET balance = balance - $1 WHERE telegram_id = $2',
      [bygoAmount, telegramId]
    );

    await client.query('COMMIT');

    // Create NOWPayments invoice (outside transaction)
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
      console.error('[Payment] NOWPayments invoice creation failed:', npErr.message);
      // Mark withdrawal as failed and refund balance so user can retry cleanly
      await query(
        `UPDATE withdrawal_requests SET status = 'failed', admin_note = $1 WHERE id = $2`,
        [`Invoice creation failed: ${npErr.message}`, withdrawalId]
      ).catch(() => {});
      await query(
        `UPDATE users SET balance = balance + $1 WHERE telegram_id = $2`,
        [bygoAmount, telegramId]
      ).catch(() => {});
      throw ApiError.badGateway('Payment gateway error. Your balance has been fully refunded. Please try again.');
    }

    // Store NOWPayments IDs
    await query(
      `UPDATE withdrawal_requests
       SET nowpayments_payment_id   = $1,
           nowpayments_pay_address  = $2,
           nowpayments_pay_amount   = $3,
           nowpayments_pay_currency = $4,
           updated_at               = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [
        String(npPayment.payment_id),
        npPayment.pay_address,
        npPayment.pay_amount,
        npPayment.pay_currency,
        withdrawalId,
      ]
    );

    console.log(`[Payment] Withdrawal #${withdrawalId} created for user ${telegramId}: ${bygoAmount} $BYGO, payment ${npPayment.payment_id}`);

    return res.status(201).json({
      success: true,
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
    throw err;
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/:paymentId/status
// ─────────────────────────────────────────────────────────────────────────────
exports.getPaymentStatus = async (req, res) => {
  const { paymentId } = req.params;
  const telegramId    = req.user.telegram_id;

  const wrRes = await query(
    `SELECT id, status, bygo_amount, wallet_address
     FROM withdrawal_requests
     WHERE nowpayments_payment_id = $1 AND user_id = $2`,
    [paymentId, telegramId]
  );
  if (wrRes.rows.length === 0) throw ApiError.notFound('Payment not found.');
  const wr = wrRes.rows[0];

  // Terminal statuses — return cached without hitting NP
  const terminalStatuses = ['fee_paid', 'processing', 'completed', 'failed', 'transfer_failed'];
  if (terminalStatuses.includes(wr.status)) {
    return res.json({ success: true, payment_status: wr.status, withdrawal_id: wr.id, bygo_amount: wr.bygo_amount });
  }

  // Poll NOWPayments for current status
  const npStatus = await npRequest('GET', `/payment/${paymentId}`);
  const npSt = npStatus.payment_status;
  let localStatus = wr.status;

  if (npSt === 'finished' || npSt === 'confirmed') {
    const updated = await query(
      `UPDATE withdrawal_requests
       SET status = 'fee_paid', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'fee_pending'
       RETURNING id, user_id, bygo_amount, wallet_address`,
      [wr.id]
    );
    localStatus = 'fee_paid';
    if (updated.rows.length > 0) {
      console.log(`[Payment Poll] Fee confirmed for withdrawal #${wr.id} — triggering auto transfer`);
      triggerAutoTransfer({ ...updated.rows[0], status: 'fee_paid' })
        .catch(e => console.error('[Payment Poll] triggerAutoTransfer error:', e.message));
    }
  } else if (['failed', 'expired', 'refunded'].includes(npSt)) {
    localStatus = 'failed';
    // Refund the user's instantly-deducted balance
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE withdrawal_requests SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'fee_pending'`,
        [wr.id]
      );
      await client.query(
        `UPDATE users SET balance = balance + $1 WHERE telegram_id = $2`,
        [wr.bygo_amount, telegramId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[Payment Poll] Failed to refund withdrawal #${wr.id}:`, err);
    } finally {
      client.release();
    }
    console.log(`[Payment Poll] Fee failed/expired for withdrawal #${wr.id} — Balance refunded.`);
  }

  return res.json({
    success: true,
    payment_status: localStatus,
    np_status:      npSt,
    withdrawal_id:  wr.id,
    bygo_amount:    wr.bygo_amount,
    wallet_address: wr.wallet_address,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/:paymentId/cancel
// ─────────────────────────────────────────────────────────────────────────────
exports.cancelPayment = async (req, res) => {
  const { paymentId } = req.params;
  const telegramId    = req.user.telegram_id;

  const wrRes = await query(
    `SELECT id, status FROM withdrawal_requests WHERE nowpayments_payment_id = $1 AND user_id = $2`,
    [paymentId, telegramId]
  );
  if (wrRes.rows.length === 0) throw ApiError.notFound('Payment not found.');

  const wr = wrRes.rows[0];
  if (wr.status !== 'fee_pending') {
    throw ApiError.badRequest('Only payments in fee_pending status can be cancelled.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const upd = await client.query(
      `UPDATE withdrawal_requests
       SET status = 'failed', admin_note = 'Cancelled by user', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'fee_pending'
       RETURNING id`,
      [wr.id]
    );
    
    // Only refund if we successfully changed it from fee_pending
    if (upd.rows.length > 0) {
      await client.query(
        `UPDATE users SET balance = balance + $1 WHERE telegram_id = $2`,
        [wr.bygo_amount, telegramId]
      );
    }
    
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  console.log(`[Payment] Withdrawal #${wr.id} cancelled by user ${telegramId} — Balance refunded.`);
  return res.json({ success: true, status: 'failed' });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/ipn — NOWPayments IPN Webhook
// Raw body required for HMAC-SHA512 verification
// ─────────────────────────────────────────────────────────────────────────────
exports.ipnCallback = async (req, res) => {
  // Always respond 200 quickly to prevent IPN retries, then process
  const sig = req.headers['x-nowpayments-sig'];

  if (!NP_IPN_SECRET) {
    console.error('[IPN] NOWPAYMENTS_IPN_SECRET_KEY is not configured — rejecting.');
    return res.status(500).send('Server misconfiguration.');
  }
  if (!sig) {
    console.warn('[IPN] Missing x-nowpayments-sig header.');
    return res.status(400).send('Missing signature.');
  }

  const rawBody = req.body;
  const expected = crypto
    .createHmac('sha512', NP_IPN_SECRET)
    .update(rawBody)
    .digest('hex');

  if (expected !== sig) {
    console.error('[IPN] Signature mismatch — possible forgery attempt. Rejecting.');
    return res.status(401).send('Invalid signature.');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON payload.');
  }

  // Acknowledge quickly
  res.sendStatus(200);

  // Process asynchronously to not block the response
  setImmediate(async () => {
    const { payment_id, payment_status } = payload;
    if (!payment_id || !payment_status) {
      console.warn('[IPN] Payload missing payment_id or payment_status:', payload);
      return;
    }

    // Idempotent event log
    try {
      await query(
        'INSERT INTO payment_events (nowpayments_payment_id, event_status, raw_payload) VALUES ($1, $2, $3)',
        [String(payment_id), payment_status, payload]
      );
    } catch (dupErr) {
      if (dupErr.code !== '23505') console.warn('[IPN] Could not log payment_event:', dupErr.message);
    }

    const wrRes = await query(
      'SELECT id, user_id, bygo_amount, status FROM withdrawal_requests WHERE nowpayments_payment_id = $1',
      [String(payment_id)]
    );
    if (wrRes.rows.length === 0) {
      console.warn('[IPN] No withdrawal found for payment_id:', payment_id);
      return;
    }
    const wr = wrRes.rows[0];

    // Skip if already past fee_pending (idempotency guard)
    if (['fee_paid', 'processing', 'completed', 'transfer_failed'].includes(wr.status)) {
      console.log(`[IPN] Withdrawal #${wr.id} already at '${wr.status}' — skipping duplicate.`);
      return;
    }

    if (payment_status === 'finished' || payment_status === 'confirmed') {
      const fullWr = await query(
        'SELECT id, user_id, bygo_amount, wallet_address FROM withdrawal_requests WHERE id = $1',
        [wr.id]
      );
      const upd = await query(
        `UPDATE withdrawal_requests
         SET status = 'fee_paid', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status IN ('fee_pending', 'failed')
         RETURNING id`,
        [wr.id]
      );
      if (upd.rows.length > 0 && fullWr.rows.length > 0) {
        console.log(`[IPN] Withdrawal #${wr.id} — fee confirmed, triggering on-chain transfer`);
        triggerAutoTransfer({ ...fullWr.rows[0], status: 'fee_paid' })
          .catch(e => console.error('[IPN] triggerAutoTransfer error:', e.message));
      }
    } else if (['failed', 'expired', 'refunded'].includes(payment_status)) {
      const dbClient = await pool.connect();
      try {
        await dbClient.query('BEGIN');
        const upd = await dbClient.query(
          `UPDATE withdrawal_requests
           SET status = 'failed', updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND status = 'fee_pending'
           RETURNING id`,
          [wr.id]
        );
        if (upd.rows.length > 0) {
          await dbClient.query(
            `UPDATE users SET balance = balance + $1 WHERE telegram_id = $2`,
            [wr.bygo_amount, wr.user_id]
          );
          console.log(`[IPN] Withdrawal #${wr.id} — fee ${payment_status}. Balance refunded.`);
        }
        await dbClient.query('COMMIT');
      } catch (err) {
        await dbClient.query('ROLLBACK').catch(() => {});
        console.error(`[IPN] Failed to refund withdrawal #${wr.id}:`, err);
      } finally {
        dbClient.release();
      }
    }
  });
};
