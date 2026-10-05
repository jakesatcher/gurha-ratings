'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { passwordProblem } = require('./auth');

const router = express.Router();

router.get('/account', requireAuth, async (req, res) => {
  const myRatings = await db.many(
    `SELECT r.id, r.created_at, r.final_level, s.name AS season_name, p.id AS player_id, p.first_name, p.last_name,
            t.name AS team, sp.jersey_number
       FROM ratings r
       JOIN players p ON p.id = r.player_id
       JOIN seasons s ON s.id = r.season_id
       LEFT JOIN season_players sp ON sp.season_id = r.season_id AND sp.player_id = r.player_id
       LEFT JOIN teams t ON t.id = sp.team_id
      WHERE r.rater_id = $1 ORDER BY r.created_at DESC`,
    [req.user.id]
  );
  res.render('account/index', { title: 'My account', myRatings, error: null });
});

router.post('/account/password', requireAuth, async (req, res) => {
  const user = await db.one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  let error = null;
  if (!(await bcrypt.compare(String(req.body.current_password || ''), user.password_hash))) error = 'Current password is incorrect.';
  else error = passwordProblem(req.body.password) || (req.body.password !== req.body.password_confirm ? 'Passwords do not match.' : null);
  if (error) {
    req.flash('error', error);
    return res.redirect('/account');
  }
  await db.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [await bcrypt.hash(req.body.password, 12), req.user.id]);
  await audit(req.user.id, 'password_changed', 'user', req.user.id);
  req.flash('success', 'Password changed.');
  res.redirect('/account');
});

module.exports = router;
