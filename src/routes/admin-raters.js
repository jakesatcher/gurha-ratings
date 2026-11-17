'use strict';

// Admin → Raters: everyone who has rated (or can rate), and the players each one rated.
const express = require('express');
const db = require('../db');
const R = require('../lib/ratings');

const router = express.Router();

// The season to show: ?season=<id>, 'all', or the season selected at the top of the page.
async function seasonFilter(req) {
  if (req.query.season === 'all') return { id: null, name: 'All seasons' };
  const id = Number(req.query.season) || (req.season && req.season.id) || null;
  if (!id) return { id: null, name: 'All seasons' };
  return (await db.one('SELECT id, name FROM seasons WHERE id = $1', [id])) || { id: null, name: 'All seasons' };
}

router.get('/raters', async (req, res) => {
  const season = await seasonFilter(req);
  const raters = await db.many(
    `SELECT u.id, u.name, u.email, u.role, u.status, u.can_login,
            count(r.id)::int AS ratings,
            count(r.id) FILTER (WHERE r.disqualified_at IS NOT NULL)::int AS disqualified,
            count(r.id) FILTER (WHERE r.source = 'paper')::int AS paper,
            max(r.created_at) AS last_rated
       FROM users u
       LEFT JOIN ratings r ON r.rater_id = u.id AND ($1::int IS NULL OR r.season_id = $1)
      WHERE u.role IN ('rater', 'admin') OR EXISTS (SELECT 1 FROM ratings x WHERE x.rater_id = u.id)
      GROUP BY u.id
      ORDER BY count(r.id) DESC, lower(u.name)`,
    [season.id]
  );
  res.render('admin/raters', { title: 'Raters', raters, filterSeason: season, allSeasons: await db.many('SELECT id, name FROM seasons ORDER BY coalesce(start_date, created_at::date) DESC, id DESC') });
});

router.get('/raters/:id', async (req, res) => {
  const rater = await db.one('SELECT id, name, email, role, status, can_login, created_at FROM users WHERE id = $1', [Number(req.params.id) || 0]);
  if (!rater) return res.status(404).render('error', { title: 'Not found', message: 'Rater not found.' });
  const season = await seasonFilter(req);
  const rows = await db.many(
    `SELECT r.id, r.player_id, r.season_id FROM ratings r WHERE r.rater_id = $1 AND ($2::int IS NULL OR r.season_id = $2)`,
    [rater.id, season.id]
  );
  // Full rating details (points, grade, comments, paper form, disqualification) via the shared loader.
  const { ratings } = rows.length ? await R.loadRatings({ playerIds: [...new Set(rows.map((r) => r.player_id))], seasonId: season.id || undefined }) : { ratings: [] };
  const mine = ratings.filter((r) => r.rater_id === rater.id);
  const players = await db.many(
    `SELECT p.id, p.first_name, p.last_name,
            (SELECT string_agg(coalesce(t.name, 'No team') || coalesce(' #' || tr.jersey_number, ''), ', ' ORDER BY tr.is_sub, t.name)
               FROM season_players sp JOIN team_rosters tr ON tr.season_player_id = sp.id LEFT JOIN teams t ON t.id = tr.team_id
              WHERE sp.player_id = p.id AND sp.season_id = $2) AS teams
       FROM players p WHERE p.id = ANY($1::int[])`,
    [mine.map((r) => r.player_id), season.id]
  );
  const byId = new Map(players.map((p) => [p.id, p]));
  const list = mine
    .map((r) => ({ ...r, player: byId.get(r.player_id) }))
    .filter((r) => r.player)
    .sort((a, b) => a.player.last_name.localeCompare(b.player.last_name) || a.player.first_name.localeCompare(b.player.first_name));
  res.render('admin/rater', {
    title: rater.name,
    rater,
    ratings: list,
    filterSeason: season,
    allSeasons: await db.many('SELECT id, name FROM seasons ORDER BY coalesce(start_date, created_at::date) DESC, id DESC'),
  });
});

module.exports = router;
