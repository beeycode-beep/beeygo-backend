/**
 * Async Handler Middleware
 * Wraps async route handlers and passes any unhandled errors to the express error handler
 */
const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
