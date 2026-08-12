const rateLimit = require('express-rate-limit');

// ── Rate Limiters ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 mins
  max: 10,
  message: { message: 'Too many auth attempts from this IP, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

const withdrawalLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 mins
  max: 3, // Max 3 withdrawal requests per 5 mins per IP
  message: { message: 'Too many withdrawal attempts. Please wait 5 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  authLimiter,
  withdrawalLimiter
};
