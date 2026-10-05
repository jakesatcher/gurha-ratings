'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const mailer = require('../lib/mailer');
const emails = require('../lib/emails');
const { passwordProblems } = require('./auth');

const router = express.Router();

router.get('/account', requireAuth, async (req, res) => {
  const myRatings = await db.many(
    `SELECT r.id, r.created_at, r.final_level, s.name AS season_name, p.id AS player_id, p.first_name, p.last_name,
            (SELECT string_agg(t.name, ', ' ORDER BY tr.is_sub, t.name) FROM season_players sp
               JOIN team_rosters tr ON tr.season_player_id = sp.id JOIN teams t ON t.id = tr.team_id
              WHERE sp.season_id = r.season_id AND sp.player_id = r.player_id) AS team,
            NULL AS jersey_number
       FROM ratings r
       JOIN players p ON p.id = r.player_id
       JOIN seasons s ON s.id = r.season_id
      WHERE r.rater_id = $1 ORDER BY r.created_at DESC`,
    [req.user.id]
  );
  res.render('account/index', { title: 'My account', myRatings, error: null });
});

router.post('/account/notifications', requireAuth, async (req, res) => {
  if (req.user.role === 'admin') {
    const on = req.body.notify_access_requests === 'on';
    await db.query('UPDATE users SET notify_access_requests = $1, updated_at = now() WHERE id = $2', [on, req.user.id]);
    req.flash('success', on ? "You'll get an email when someone requests access." : "You won't get access-request emails.");
  }
  res.redirect('/account');
});

// Required after signing in with a password that doesn't meet the current policy.
router.get('/account/new-password', requireAuth, (req, res) => {
  if (!req.session.mustChangePassword) return res.redirect('/account');
  res.render('account/new-password', { title: 'Choose a new password', errors: [] });
});

router.post('/account/new-password', requireAuth, async (req, res) => {
  if (!req.session.mustChangePassword) return res.redirect('/account');
  const problems = passwordProblems(req.body.password, req.body.password_confirm);
  const user = await db.one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!problems.length && (await bcrypt.compare(String(req.body.password), user.password_hash))) {
    problems.push('Choose a password different from your current one.');
  }
  if (problems.length) return res.status(422).render('account/new-password', { title: 'Choose a new password', errors: problems });
  await db.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [await bcrypt.hash(req.body.password, 12), req.user.id]);
  delete req.session.mustChangePassword;
  await audit(req.user.id, 'password_changed', 'user', req.user.id, { reason: 'policy' });
  mailer.sendQuietly({ to: req.user.email, userId: req.user.id, ...emails.securityNotice({ name: req.user.name, what: 'Your password was changed' }) });
  req.flash('success', 'Password updated. Thanks for keeping your account secure.');
  res.redirect('/players');
});

router.post('/account/password', requireAuth, async (req, res) => {
  const user = await db.one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  let error = null;
  if (!(await bcrypt.compare(String(req.body.current_password || ''), user.password_hash))) error = 'Current password is incorrect.';
  else error = passwordProblems(req.body.password, req.body.password_confirm).join(' ') || null;
  if (error) {
    req.flash('error', error);
    return res.redirect('/account');
  }
  await db.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [await bcrypt.hash(req.body.password, 12), req.user.id]);
  await audit(req.user.id, 'password_changed', 'user', req.user.id);
  mailer.sendQuietly({ to: req.user.email, userId: req.user.id, ...emails.securityNotice({ name: req.user.name, what: 'Your password was changed' }) });
  req.flash('success', 'Password changed.');
  res.redirect('/account');
});

module.exports = router;
