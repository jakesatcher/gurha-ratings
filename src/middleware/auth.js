'use strict';

const db = require('../db');

async function loadUser(req, res, next) {
  res.locals.currentUser = null;
  if (req.session && req.session.userId) {
    const user = await db.one('SELECT id, email, name, role, status, mfa_method FROM users WHERE id = $1', [req.session.userId]);
    if (user && user.status === 'approved') {
      req.user = user;
      res.locals.currentUser = user;
    } else {
      // Account removed, disabled or un-approved since login: end the session.
      delete req.session.userId;
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (!req.user) return requireAuth(req, res, next);
  if (req.user.role === 'admin') return next();
  return res.status(403).render('error', { title: 'Not allowed', message: 'Only admins can do that.' });
}

module.exports = { loadUser, requireAuth, requireAdmin };
