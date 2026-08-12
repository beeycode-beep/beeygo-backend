require('dotenv').config();

const requiredEnvVars = [
  'DATABASE_URL',
  'TELEGRAM_BOT_TOKEN',
  'JWT_SECRET',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD_HASH',
];

function validateEnv() {
  const missing = [];
  requiredEnvVars.forEach((key) => {
    if (!process.env[key]) {
      missing.push(key);
    }
  });

  if (missing.length > 0) {
    // In production (serverless), log the warning but do NOT call process.exit(1)
    // — that kills the Vercel function before it can serve any request.
    // Individual controllers handle missing vars at request time via ApiError.
    const msg = `⚠️  WARNING: Missing environment variables on Vercel: ${missing.join(', ')}. Set them in the Vercel dashboard.`;
    console.error(msg);
    if (process.env.NODE_ENV !== 'production') {
      process.exit(1);
    }
  }
}

module.exports = { validateEnv };
