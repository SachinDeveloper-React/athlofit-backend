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
 * Standard error response.
 *
 * `code` is an optional stable, machine-readable identifier for the failure —
 * e.g. 'STEPS_TRACKING_DISABLED'. Clients must branch on this rather than on
 * the HTTP status or the message text: several unrelated conditions return 403,
 * and the message is user-facing copy that is expected to change. Omitted from
 * the body entirely when not supplied, so existing responses are unchanged.
 */
const error = (res, message, statusCode = 400, code) => {
  return res.status(statusCode).json({
    success: false,
    message,
    data: null,
    ...(code ? { code } : {}),
  });
};

module.exports = { success, error };
