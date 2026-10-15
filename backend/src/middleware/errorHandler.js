/**
 * Centralized Error Handler Middleware
 * Captures all thrown errors from routes and returns a standardized JSON response.
 */
const errorHandler = (err, req, res, next) => {
    console.error(`[Error] ${err.stack}`);

    const statusCode = err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(statusCode).json({
        success: false,
        error: message,
        // Only include stack trace in development
        stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
};

module.exports = { errorHandler };
