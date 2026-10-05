'use strict';

const db = require('../db');

async function loadUser(req, res, next) {
  res.locals.currentUser = null;
  if (req.session && req.session.userId) {
    const user = await db.one('SELECT id, email, name, role, status, mfa_method, notify_access_requests FROM users WHERE id = $1', [req.session.userId]);
    if (user && user.status === 'approved') {
      // Viewers can see everything but can't rate; raters and admins can.
      user.canRate = user.role === 'admin' || user.role === 'rater';
      req.user = user;
      res.locals.currentUser = user;
    } else {
      // Account removed, disabled or un-approved since login: end the session.
      delete req.session.userId;
    }
  }
  next();
}

// Until a weak password is replaced, a signed-in user can only reach the change-password page.
const PASSWORD_UPDATE_ALLOWED = new Set(['/account/new-password', '/logout']);
function requirePasswordUpdate(req, res, next) {
  if (req.user && req.session.mustChangePassword && !PASSWORD_UPDATE_ALLOWED.has(req.path)) {
    return res.redirect('/account/new-password');
  }
  next();
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
  return res.redirect('/login');
}

// Rating (and anything else that changes ratings) needs the rater or admin role.
function requireRater(req, res, next) {
  if (!req.user) return requireAuth(req, res, next);
  if (req.user.canRate) return next();
  return res.status(403).render('error', { title: 'View-only access', message: 'Your account has Viewer access, so you can see ratings but not submit them. Ask an admin if you need Rater access.' });
}

function requireAdmin(req, res, next) {
  if (!req.user) return requireAuth(req, res, next);
  if (req.user.role === 'admin') return next();
  return res.status(403).render('error', { title: 'Not allowed', message: 'Only admins can do that.' });
}

module.exports = { loadUser, requireAuth, requireRater, requireAdmin, requirePasswordUpdate };
