const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Serverless-safe pool config:
  // Each Vercel function instance is isolated — a high max would exhaust
  // Neon's free-tier connection limit across concurrent invocations.
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});

async function initDB() {
  const client = await pool.connect();
  try {
    // 1. Create Users Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        username VARCHAR(255),
        first_name VARCHAR(255),
        balance INT DEFAULT 0,
        total_claimed INT DEFAULT 0,
        claim_count INT DEFAULT 0,
        last_claim_time TIMESTAMP,
        wallet_address VARCHAR(255),
        referred_by BIGINT,
        referral_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Safely add columns if the table already existed before this update
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS referred_by BIGINT,
      ADD COLUMN IF NOT EXISTS referral_count INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS daily_streak INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_daily_claim TIMESTAMP,
      ADD COLUMN IF NOT EXISTS spins_used_today INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_spin_date TIMESTAMP
    `);

    // 2. Create Settings Table (Key-Value or JSON blob)
    // We will use a single row for global config for simplicity
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id INT PRIMARY KEY DEFAULT 1,
        config JSONB NOT NULL
      )
    `);

    // 3. Create Tasks Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        reward INT DEFAULT 0,
        link VARCHAR(255),
        platform VARCHAR(50),
        active BOOLEAN DEFAULT true,
        verification_type VARCHAR(30) DEFAULT 'auto',
        chat_id VARCHAR(100),
        image_url VARCHAR(1000),
        long_description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Safely add verification columns to existing tasks table
    await client.query(`
      ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS verification_type VARCHAR(30) DEFAULT 'auto',
      ADD COLUMN IF NOT EXISTS chat_id VARCHAR(100),
      ADD COLUMN IF NOT EXISTS image_url VARCHAR(1000),
      ADD COLUMN IF NOT EXISTS long_description TEXT
    `);

    // 4. Create User Tasks Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_tasks (
        user_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
        task_id INT REFERENCES tasks(id) ON DELETE CASCADE,
        status VARCHAR(50) DEFAULT 'pending',
        verification_token VARCHAR(20),
        token_expires_at TIMESTAMP,
        completed_at TIMESTAMP,
        PRIMARY KEY (user_id, task_id)
      )
    `);

    // Safely add verification columns to existing user_tasks table
    await client.query(`
      ALTER TABLE user_tasks
      ADD COLUMN IF NOT EXISTS verification_token VARCHAR(20),
      ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP
    `);

    // 4b. Create Task Verification Log Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS task_verification_log (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        task_id INT NOT NULL,
        verification_type VARCHAR(30),
        result VARCHAR(20),
        detail TEXT,
        checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_verif_log_user ON task_verification_log(user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_verif_log_task ON task_verification_log(task_id)
    `);

    // 5. Create Ambassador Applications Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS ambassador_applications (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        country VARCHAR(100) NOT NULL,
        telegram VARCHAR(100) NOT NULL,
        twitter VARCHAR(100) NOT NULL,
        channel_handle VARCHAR(100),
        user_handle VARCHAR(100),
        social_url VARCHAR(255),
        follower_count VARCHAR(50) NOT NULL,
        niche VARCHAR(50) NOT NULL,
        motivation TEXT NOT NULL,
        promotion_plan TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        admin_notes TEXT,
        reviewed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Safely add columns if the table already existed before this update
    await client.query(`
      ALTER TABLE ambassador_applications
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS admin_notes TEXT,
      ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP
    `);

    // Index for fast status filtering
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_applications_status ON ambassador_applications(status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_applications_created ON ambassador_applications(created_at DESC)
    `);

    // ── 6. Withdrawal Requests Table ─────────────────────────────────────────
    // status flow: fee_pending → fee_paid → processing → completed
    //                                   └── failed (fee refund needed manually)
    await client.query(`
      CREATE TABLE IF NOT EXISTS withdrawal_requests (
        id                      SERIAL PRIMARY KEY,
        user_id                 BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
        bygo_amount             BIGINT NOT NULL,
        wallet_address          VARCHAR(255) NOT NULL,
        fee_usd                 NUMERIC(10,2) NOT NULL DEFAULT 0.50,
        fee_currency            VARCHAR(30) NOT NULL DEFAULT 'usdttrc20',
        nowpayments_payment_id  VARCHAR(100),
        nowpayments_pay_address VARCHAR(255),
        nowpayments_pay_amount  NUMERIC(20,8),
        nowpayments_pay_currency VARCHAR(30),
        status                  VARCHAR(30) NOT NULL DEFAULT 'fee_pending',
        admin_note              TEXT,
        created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Safe column additions for existing deployments
    await client.query(`
      ALTER TABLE withdrawal_requests
        ADD COLUMN IF NOT EXISTS admin_note TEXT,
        ADD COLUMN IF NOT EXISTS nowpayments_pay_currency VARCHAR(30),
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN IF NOT EXISTS tx_hash VARCHAR(100),
        ADD COLUMN IF NOT EXISTS processed_at TIMESTAMP
    `);


    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_withdrawals_user   ON withdrawal_requests(user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawal_requests(status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_withdrawals_np_id  ON withdrawal_requests(nowpayments_payment_id)
    `);

    // ── 7. Payment Events — append-only IPN/webhook audit log ────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_events (
        id                     SERIAL PRIMARY KEY,
        nowpayments_payment_id VARCHAR(100) NOT NULL,
        event_status           VARCHAR(50),
        raw_payload            JSONB,
        received_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payment_events_np_id ON payment_events(nowpayments_payment_id)
    `);

  } finally {
    client.release();
  }
}

// Helper query function
const query = (text, params) => pool.query(text, params);

module.exports = {
  pool,
  query,
  initDB
};
