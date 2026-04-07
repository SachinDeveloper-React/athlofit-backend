// src/middleware/validate.middleware.js
const { validationResult } = require('express-validator');
const { error } = require('../utils/response');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const messages = errors.array().map(e => e.msg).join(', ');
    return error(res, messages, 422);
  }
  next();
};

module.exports = { validate };
