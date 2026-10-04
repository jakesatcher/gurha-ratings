'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const R = require('../lib/ratings');

const router = express.Router();

function canSeeRaterNames(user) {
  return user.role === 'admin' || config.showRaterNamesToRaters;
}

async function teamsList() {
  return (await db.many(`SELECT DISTINCT team FROM players WHERE team IS NOT NULL AND team <> '' AND active ORDER BY team`)).map((r) => r.team);
}

// Shared player search used by the players page and the admin player list.
async function searchPlayers({ q, team, position, includeInactive }) {
  const where = [];
  const params = [];
  if (!includeInactive) where.push('active');
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    const i = params.length;
    where.push(`(lower(first_name || ' ' || last_name) LIKE $${i} OR lower(last_name || ', ' || first_name) LIKE $${i}
                 OR lower(coalesce(team, '')) LIKE $${i} OR lower(coalesce(division, '')) LIKE $${i})`);
    if (/^#?\d{1,3}$/.test(q)) {
      params.push(q.replace('#', ''));
      where[where.length - 1] = `(${where[where.length - 1]} OR jersey_number = $${params.length})`;
    }
  }
  if (team) {
    params.push(team);
    where.push(`team = $${params.length}`);
  }
  if (['F', 'D', 'G'].includes(position)) {
    params.push(position);
    where.push(`position = $${params.length}`);
  }
  return db.many(
    `SELECT * FROM players ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY lower(last_name), lower(first_name) LIMIT 1000`,
    params
  );
}

router.get('/players', requireAuth, async (req, res) => {
  const filters = {
    q: String(req.query.q || '').trim().slice(0, 100),
    team: String(req.query.team || ''),
    position: String(req.query.position || ''),
    status: String(req.query.status || ''),
    sort: String(req.query.sort || 'name'),
  };
  let players = await searchPlayers(filters);
  const summaries = await R.summariesForPlayers(players);
  const mine = new Set(
    (await db.many('SELECT player_id FROM ratings WHERE rater_id = $1', [req.user.id])).map((r) => r.player_id)
  );
  if (filters.status === 'unrated') players = players.filter((p) => !mine.has(p.id));
  if (filters.status === 'rated') players = players.filter((p) => mine.has(p.id));
  if (filters.status === 'review') players = players.filter((p) => summaries.get(p.id).needsReview);
  if (filters.status === 'none') players = players.filter((p) => summaries.get(p.id).count === 0);
  if (filters.sort === 'rating') {
    players.sort((a, b) => (summaries.get(b.id).avgOverall ?? -1) - (summaries.get(a.id).avgOverall ?? -1));
  }
  res.render('players/index', { title: 'Players', players, summaries, mine, filters, teams: await teamsList() });
});

async function loadPlayerPage(req, playerId) {
  const player = await db.one('SELECT * FROM players WHERE id = $1', [playerId]);
  if (!player) return null;
  const { ratings, categories } = await R.loadRatings({ playerIds: [player.id] });
  const summary = R.summarize(ratings, categories, player);
  const myRating = ratings.find((r) => r.rater_id === req.user.id) || null;
  const showNames = canSeeRaterNames(req.user);
  ratings.forEach((r, i) => {
    r.display_name = showNames || r.rater_id === req.user.id ? r.rater_name : `Rater ${i + 1}`;
  });
  return { player, ratings, categories, summary, myRating };
}

router.get('/players/:id', requireAuth, async (req, res) => {
  const data = await loadPlayerPage(req, Number(req.params.id) || 0);
  if (!data || (!data.player.active && req.user.role !== 'admin')) {
    return res.status(404).render('error', { title: 'Not found', message: 'Player not found.' });
  }
  res.render('players/show', { title: `${data.player.first_name} ${data.player.last_name}`, ...data });
});

function renderAlreadyRated(res, player) {
  return res.status(409).render('ratings/already-rated', { title: 'Already rated', player, message: R.ALREADY_RATED_MESSAGE });
}

async function ratablePlayer(req, res) {
  const player = await db.one('SELECT * FROM players WHERE id = $1', [Number(req.params.id) || 0]);
  if (!player || !player.active) {
    res.status(404).render('error', { title: 'Not found', message: 'Player not found.' });
    return null;
  }
  return player;
}

router.get('/players/:id/rate', requireAuth, async (req, res) => {
  const player = await ratablePlayer(req, res);
  if (!player) return;
  const existing = await db.one('SELECT id FROM ratings WHERE player_id = $1 AND rater_id = $2', [player.id, req.user.id]);
  if (existing) return renderAlreadyRated(res, player);
  const categories = await R.getCategories();
  res.render('ratings/form', { title: `Rate ${player.first_name} ${player.last_name}`, player, categories, values: {}, errors: [], mode: 'create', R });
});

router.post('/players/:id/rate', requireAuth, async (req, res) => {
  const player = await ratablePlayer(req, res);
  if (!player) return;
  const existing = await db.one('SELECT id FROM ratings WHERE player_id = $1 AND rater_id = $2', [player.id, req.user.id]);
  if (existing) return renderAlreadyRated(res, player);

  const categories = await R.getCategories();
  const { errors, data, scores } = R.parseRatingForm(req.body, categories);
  if (errors.length) {
    return res.status(422).render('ratings/form', {
      title: `Rate ${player.first_name} ${player.last_name}`, player, categories, values: req.body, errors, mode: 'create', R,
    });
  }
  try {
    const ratingId = await db.tx(async (c) => {
      const id = await R.createRating(c, player.id, req.user.id, data, scores);
      await audit(req.user.id, 'rating_created', 'rating', id, { player_id: player.id }, c);
      return id;
    });
    req.flash('success', `Rating submitted for ${player.first_name} ${player.last_name}. Thank you!`);
    res.redirect(`/players/${player.id}#rating-${ratingId}`);
  } catch (err) {
    // Unique (player_id, rater_id) violation: a concurrent duplicate submission.
    if (err.code === '23505') return renderAlreadyRated(res, player);
    throw err;
  }
});

// ---------- Team summary report (mirrors the GURHA Team Player Rating & Division Summary) ----------

router.get('/reports/teams', requireAuth, async (req, res) => {
  const teams = await teamsList();
  const team = String(req.query.team || '');
  let players = [];
  let summaries = new Map();
  if (team) {
    players = await db.many(
      `SELECT * FROM players WHERE active AND team = $1
        ORDER BY NULLIF(regexp_replace(coalesce(jersey_number, ''), '\\D', '', 'g'), '')::int NULLS LAST, lower(last_name)`,
      [team]
    );
    summaries = await R.summariesForPlayers(players);
  }
  const division = players.find((p) => p.division)?.division || '';
  res.render('players/team-report', { title: team ? `${team} summary` : 'Team summary', teams, team, players, summaries, division });
});

module.exports = router;
module.exports.searchPlayers = searchPlayers;
