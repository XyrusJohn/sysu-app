/**
 * Centralized Error Handler Middleware
 * Captures all thrown errors from routes and returns a standardized JSON response.
 */
const {randomUUID} = require('node:crypto');
const errorHandler = (err, req, res, next) => {

    const statusCode = err.name === 'ZodError' ? 400 : (err.statusCode || err.status || 500);
    const requestId = randomUUID();
    console.error(JSON.stringify({event: 'request_error', requestId, statusCode,
        category: err.name === 'ZodError' ? 'validation' : statusCode >= 500 ? 'internal' : 'client'}));
    const message = statusCode >= 500 ? "Internal Server Error" :
        (err.name === 'ZodError' ? 'Invalid request data' : err.message || 'Request failed');

    res.status(statusCode).json({
        success: false,
        requestId,
        error: message,
        // Only include stack trace in development
        stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
};

module.exports = { errorHandler };
