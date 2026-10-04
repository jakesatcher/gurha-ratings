'use strict';

const { randomToken, safeEqual } = require('../lib/crypto');

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = randomToken(24);
  return req.session.csrfToken;
}

function tokenFromRequest(req) {
  return (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
}

function csrfValid(req) {
  const expected = req.session && req.session.csrfToken;
  return Boolean(expected) && safeEqual(tokenFromRequest(req), expected);
}

// Routes that accept multipart uploads; they call `verifyCsrf` after multer parses the body.
const MULTIPART_ROUTES = new Set(['/admin/import']);

// Global CSRF check.
function csrf(req, res, next) {
  res.locals.csrfToken = ensureCsrfToken(req);
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (MULTIPART_ROUTES.has(req.path) && req.is('multipart/form-data')) return next();
  if (csrfValid(req)) return next();
  return res.status(403).render('error', { title: 'Session expired', message: 'Your form session expired. Please go back, refresh the page and try again.' });
}

function verifyCsrf(req, res, next) {
  if (csrfValid(req)) return next();
  return res.status(403).render('error', { title: 'Session expired', message: 'Your form session expired. Please go back, refresh the page and try again.' });
}

function flash(req, res, next) {
  req.flash = (type, message) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, message });
  };
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;
  next();
}

module.exports = { csrf, verifyCsrf, flash };
