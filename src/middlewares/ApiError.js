/**
 * Custom API Error class for consistent error handling.
 * Use this to throw intentional errors with HTTP status codes.
 */
class ApiError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = statusCode;
    this.details = details;
  }

  static badRequest(msg, details = null) { return new ApiError(400, msg, details); }
  static unauthorized(msg = 'Unauthorized') { return new ApiError(401, msg); }
  static forbidden(msg = 'Forbidden') { return new ApiError(403, msg); }
  static notFound(msg = 'Not found') { return new ApiError(404, msg); }
  static conflict(msg = 'Conflict') { return new ApiError(409, msg); }
  static unprocessable(msg, details = null) { return new ApiError(422, msg, details); }
  static tooManyRequests(msg = 'Too many requests') { return new ApiError(429, msg); }
  static internal(msg = 'Internal server error') { return new ApiError(500, msg); }
  static badGateway(msg = 'Payment gateway error') { return new ApiError(502, msg); }
}

module.exports = ApiError;
