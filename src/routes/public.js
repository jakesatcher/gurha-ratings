'use strict';

// Public, signed-out pages: search players by name, see a player's teams, numbers and rating, and
// contest a rating. Deliberately shows nothing else (no rating counts, raters, comments, scale or
// personal details), and only the current season.
//
// Injection safety: every query is parameterized (user text is never put into SQL), LIKE wildcards
// in search text are escaped, all output goes through EJS's HTML escaping, and emails escape HTML and
// strip line breaks from headers.
const express = require('express');
const config = require('../config');
const db = require('../db');
const R = require('../lib/ratings');
const mailer = require('../lib/mailer');
const emails = require('../lib/emails');
const { audit } = require('../lib/audit');
const { searchLimiter, contestLimiter } = require('../lib/limits');
const { LEVELS } = require('../lib/levels');

const router = express.Router();

const MAX_QUERY = 60;
const RELATIONSHIPS = ['I am this player', 'Teammate', 'Captain', 'Other'];

// Removes control characters (keeping line breaks where allowed) and trims to a length.
function cleanText(v, max, { multiline = false } = {}) {
  let s = String(v ?? '');
  s = multiline ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '') : s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  s = s.replace(/[​-‏‪-‮⁦-⁩﻿]/g, ''); // invisible / direction-changing characters
  return (multiline ? s.replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ')).trim().slice(0, max);
}

// LIKE treats % and _ as wildcards; escape them (and the escape character) so search text is literal.
const likeLiteral = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

async function publicSeason() {
  return db.one('SELECT id, name FROM seasons ORDER BY is_current DESC, coalesce(start_date, created_at::date) DESC, id DESC LIMIT 1');
}

// Players on the season's roster who are visible to the public: active and not rater-added placeholders.
const PUBLIC_PLAYERS = `
  SELECT p.id, p.first_name, p.last_name, sp.level_override,
         coalesce((SELECT json_agg(json_build_object('team', t.name, 'jersey', tr.jersey_number, 'sub', tr.is_sub) ORDER BY tr.is_sub, t.name)
                     FROM team_rosters tr JOIN teams t ON t.id = tr.team_id WHERE tr.season_player_id = sp.id), '[]'::json) AS teams
    FROM season_players sp JOIN players p ON p.id = sp.player_id
   WHERE sp.season_id = $1 AND p.active AND p.added_by IS NULL`;

// Only the fields the public pages show.
async function withRatings(players, seasonId) {
  const summaries = await R.summariesForPlayers(players, seasonId);
  return players.map((p) => {
    const s = summaries.get(p.id);
    return { id: p.id, first_name: p.first_name, last_name: p.last_name, teams: p.teams, rating: s.count || s.overridden ? { level: s.level, points: s.avgOverall } : null };
  });
}

router.get('/', searchLimiter, async (req, res) => {
  if (req.user) return res.redirect('/players');
  const season = await publicSeason();
  const q = cleanText(req.query.q, MAX_QUERY);
  let results = null;
  let tooShort = false;
  if (q && season) {
    if (q.length < 2) {
      tooShort = true;
    } else {
      const pattern = `%${likeLiteral(q.toLowerCase())}%`;
      const rows = await db.many(
        `${PUBLIC_PLAYERS}
           AND (lower(p.first_name || ' ' || p.last_name) LIKE $2 ESCAPE '\\'
                OR lower(p.last_name || ', ' || p.first_name) LIKE $2 ESCAPE '\\'
                OR lower(p.last_name || ' ' || p.first_name) LIKE $2 ESCAPE '\\')
         ORDER BY lower(p.last_name), lower(p.first_name)
         LIMIT 50`,
        [season.id, pattern]
      );
      results = await withRatings(rows, season.id);
    }
  }
  res.render('public/search', { title: 'Player ratings', publicSeason: season, q, results, tooShort });
});

async function publicPlayer(req, res) {
  const season = await publicSeason();
  const id = Number(req.params.id);
  const row = season && Number.isInteger(id) && id > 0 ? await db.one(`${PUBLIC_PLAYERS} AND p.id = $2`, [season.id, id]) : null;
  if (!row) {
    res.status(404).render('error', { title: 'Not found', message: 'That player isn\'t listed. Try searching by name.' });
    return null;
  }
  const [player] = await withRatings([row], season.id);
  return { season, player };
}

router.get('/player/:id', searchLimiter, async (req, res) => {
  const found = await publicPlayer(req, res);
  if (!found) return;
  res.render('public/player', { title: `${found.player.first_name} ${found.player.last_name}`, publicSeason: found.season, player: found.player });
});

router.get('/player/:id/contest', searchLimiter, async (req, res) => {
  const found = await publicPlayer(req, res);
  if (!found) return;
  res.render('public/contest', { title: 'Contest a rating', publicSeason: found.season, player: found.player, values: {}, errors: [], relationships: RELATIONSHIPS, levelChoices: LEVELS });
});

router.post('/player/:id/contest', contestLimiter, async (req, res) => {
  const found = await publicPlayer(req, res);
  if (!found) return;
  const { season, player } = found;
  const values = {
    name: cleanText(req.body.name, 100),
    email: cleanText(req.body.email, 200).toLowerCase(),
    relationship: RELATIONSHIPS.includes(req.body.relationship) ? req.body.relationship : '',
    requested_level: LEVELS.includes(req.body.requested_level) ? req.body.requested_level : '',
    message: cleanText(req.body.message, 2000, { multiline: true }),
  };
  // Honeypot: a hidden field people never see. Bots that fill it get a normal-looking thank-you.
  if (cleanText(req.body.website, 200)) {
    req.flash('success', 'Thanks. Your request was sent to the GURHA admins.');
    return res.redirect(`/player/${player.id}`);
  }
  const errors = [];
  if (values.name.length < 2) errors.push('Enter your name.');
  if (!mailer.SAFE_ADDRESS.test(values.email)) errors.push('Enter a valid email address so an admin can reply.');
  if (!values.requested_level) errors.push('Choose the rating you think the player should have.');
  if (values.message.length < 20) errors.push('Explain why the current rating is inaccurate (at least 20 characters).');
  if (/<\s*\/?\s*(script|iframe|object|embed|style|link|meta|svg)\b|javascript:/i.test(`${values.name} ${values.message}`)) {
    errors.push('Please remove the HTML or code from your message.');
  }
  if (errors.length) {
    return res.status(422).render('public/contest', { title: 'Contest a rating', publicSeason: season, player, values, errors, relationships: RELATIONSHIPS, levelChoices: LEVELS });
  }
  const contest = await db.one(
    `INSERT INTO rating_contests (player_id, season_id, name, email, relationship, requested_level, message) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [player.id, season.id, values.name, values.email, values.relationship || null, values.requested_level, values.message]
  );
  await audit(null, 'rating_contested', 'player', player.id, { contest_id: contest.id, season_id: season.id, from: values.name });

  const admins = await db.many(`SELECT id, email FROM users WHERE role = 'admin' AND status = 'approved' AND can_login AND notify_access_requests AND email IS NOT NULL`);
  const { n: openCount } = await db.one(`SELECT count(*)::int AS n FROM rating_contests WHERE status = 'open'`);
  for (const a of admins) {
    mailer.sendQuietly({
      to: a.email,
      userId: a.id,
      replyTo: values.email,
      ...emails.ratingContest({
        playerName: `${player.first_name} ${player.last_name}`,
        teams: player.teams.map((t) => t.team).join(', '),
        name: values.name,
        email: values.email,
        relationship: values.relationship,
        currentLevel: player.rating ? player.rating.level : null,
        requestedLevel: values.requested_level,
        message: values.message,
        reviewUrl: `${config.appUrl}/admin/contests`,
        openCount,
      }),
    });
  }
  req.flash('success', 'Thanks. Your request was sent to the GURHA admins, who will review the rating and may reply by email.');
  res.redirect(`/player/${player.id}`);
});

module.exports = router;
module.exports.cleanText = cleanText;
module.exports.likeLiteral = likeLiteral;
