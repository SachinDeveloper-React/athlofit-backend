// src/utils/response.js

/**
 * Standard success response
 */
const success = (res, message, data, statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    message,
    data: data ?? null,
  });
};

/**
 * Standard error response
 */
const error = (res, message, statusCode = 400) => {
  return res.status(statusCode).json({
    success: false,
    message,
    data: null,
  });
};

module.exports = { success, error };
