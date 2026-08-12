require('dotenv').config();

// Validate critical env variables synchronously before starting
const { validateEnv } = require('./src/config/env');
validateEnv();

// Core Express & Node
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');


// Custom Modules
const { initDB } = require('./src/config/db');
const errorHandler = require('./src/middlewares/errorHandler');

// Routes
const authRoutes = require('./src/routes/auth.routes');
const userRoutes = require('./src/routes/user.routes');
const taskRoutes = require('./src/routes/task.routes');
const paymentRoutes = require('./src/routes/payment.routes');
const adminRoutes = require('./src/routes/admin.routes');
const applyRoutes = require('./src/routes/apply.routes');
const settingsRoutes = require('./src/routes/settings.routes');

const app = express();

// Global uncaught exception handlers to prevent fatal crashes
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Middleware
app.use(helmet());

// Note: hpp (http-parameter-pollution) package is not compatible with Express 5 either.
// Parameter pollution protection is enforced by express-validator in each route.

app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    'https://beeygo-admin-three.vercel.app',
    'https://beeygo-backends.vercel.app',
    'https://t.me',
    /\.vercel\.app$/,
    /\.telegram\.org$/,
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-nowpayments-sig'],
  credentials: true,
}));

// Health checks — defined first so they are never blocked by auth middleware
app.get('/', (_req, res) => res.json({ success: true, message: 'BeeyGO Backend API is running 🐝' }));
app.get('/api/health', (_req, res) => res.json({ success: true, status: 'ok', timestamp: new Date().toISOString() }));

// Raw body for IPN webhook must be registered BEFORE express.json()
app.use('/api/payments/ipn', express.raw({ type: 'application/json' }), require('./src/controllers/payment.controller').ipnCallback);

app.use(express.json());

// Mount Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/apply', applyRoutes);
app.use('/api/settings', settingsRoutes);

// ── Cron: task expiry cleanup (called by Vercel Cron every hour) ─────────────
const asyncHandler = require('./src/middlewares/asyncHandler');
const { cleanupExpiredTasks } = require('./src/controllers/task.controller');
app.get('/api/cron/cleanup-tasks', asyncHandler(async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  return cleanupExpiredTasks(req, res);
}));

// 404 handler — must be after all routes
app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found.' }));


// Global Error Handler
app.use(errorHandler);

const PORT = process.env.PORT || 3001;

// Initialize DB in background (do not block serverless export)
initDB().then(() => {
  console.log("PostgreSQL Database initialized.");
}).catch(err => {
  console.error("Failed to initialize database schemas in background:", err.message);
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
