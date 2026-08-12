const jwt = require('jsonwebtoken');
const ApiError = require('./ApiError');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET is not set. Authentication will not work.');
}

/**
 * Verifies Bearer token. Attaches decoded payload to req.user.
 * Throws ApiError for missing, invalid, or expired tokens.
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') && authHeader.slice(7);

  if (!token) return next(ApiError.unauthorized('No authentication token provided.'));

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      if (err.name === 'TokenExpiredError') return next(ApiError.unauthorized('Token expired. Please re-authenticate.'));
      return next(ApiError.unauthorized('Invalid token.'));
    }
    req.user = decoded;
    next();
  });
};

/**
 * Ensures the authenticated user has the 'admin' role.
 * Must be used AFTER authenticateToken.
 */
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return next(ApiError.forbidden('Admin access required.'));
  }
  next();
};

/**
 * Ensures the authenticated user has the 'user' role.
 * Must be used AFTER authenticateToken.
 */
const requireUser = (req, res, next) => {
  if (!req.user || req.user.role !== 'user') {
    return next(ApiError.forbidden('User access required.'));
  }
  next();
};

module.exports = { authenticateToken, requireAdmin, requireUser };
