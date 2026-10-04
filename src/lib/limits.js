'use strict';

const { rateLimit } = require('express-rate-limit');

function limiter(limit, windowMinutes) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',
    handler: (req, res) =>
      res.status(429).render('error', { title: 'Slow down', message: 'Too many attempts. Please wait a few minutes and try again.' }),
  });
}

module.exports = {
  loginLimiter: limiter(20, 15),
  mfaLimiter: limiter(20, 15),
  registerLimiter: limiter(10, 60),
  resetLimiter: limiter(10, 60),
};
