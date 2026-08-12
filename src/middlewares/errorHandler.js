const ApiError = require('./ApiError');

const errorHandler = (err, req, res, next) => {
  const isDev = process.env.NODE_ENV !== 'production';

  // Log all errors with context
  console.error(`[Error] ${req.method} ${req.originalUrl} — ${err.name || 'Error'}: ${err.message}`);
  if (isDev && err.stack) console.error(err.stack);

  // Known intentional error
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      success: false,
      message: err.message,
      ...(err.details && { details: err.details }),
      ...(isDev && { stack: err.stack }),
    });
  }

  // PostgreSQL-specific errors
  if (err.code) {
    if (err.code === '23505') { // Unique violation
      return res.status(409).json({ success: false, message: 'A record with that value already exists.' });
    }
    if (err.code === '23503') { // Foreign key violation
      return res.status(400).json({ success: false, message: 'Related record does not exist.' });
    }
    if (err.code === '23502') { // Not null violation
      return res.status(400).json({ success: false, message: `Missing required field: ${err.column || ''}` });
    }
    if (err.code === '22P02') { // Invalid UUID or type
      return res.status(400).json({ success: false, message: 'Invalid ID format provided.' });
    }
  }

  // express-validator ValidationError (shouldn't reach here, but just in case)
  if (Array.isArray(err.errors)) {
    return res.status(422).json({ success: false, message: 'Validation failed.', errors: err.errors });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Invalid token.' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Token expired. Please re-authenticate.' });
  }

  // Fallback: generic 500
  return res.status(500).json({
    success: false,
    message: 'Something went wrong on our end. Please try again later.',
    ...(isDev && { detail: err.message, stack: err.stack }),
  });
};

module.exports = errorHandler;
