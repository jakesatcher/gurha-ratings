'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const { requireAuth, requireRater } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const R = require('../lib/ratings');
const roster = require('../lib/roster');
const { levelForScore } = require('../lib/levels');

const router = express.Router();

function canSeeRaterNames(user) {
  return user.role === 'admin' || config.showRaterNamesToRaters;
}

function noSeason(req, res) {
  return res.status(404).render('error', {
    title: 'No seasons yet',
    message: req.user.role === 'admin' ? 'Create a season under Admin → Seasons to get started.' : 'No season has been set up yet. Check back soon.',
  });
}

// Switch the season being viewed.
router.post('/season', requireAuth, async (req, res) => {
  const season = await db.one('SELECT id FROM seasons WHERE id = $1', [Number(req.body.season_id) || 0]);
  if (season) req.session.seasonId = season.id;
  const back = String(req.body.return_to || '');
  // Player pages stay put; anything season-specific (forms, filters) goes back to its list.
  const safe = back.startsWith('/') && !back.startsWith('//') ? back.replace(/\/(rate|edit)$/, '').split('?')[0] : '/players';
  res.redirect(safe.startsWith('/admin/ratings') ? '/players' : safe);
});

// ---------- Browse: league → team → player ----------

const NO_LEAGUE = '_none';
const leagueKey = (division) => (division ? encodeURIComponent(division) : NO_LEAGUE);

// Everything the browse pages need for a season, computed once: teams with roster stats, grouped by league.
async function browseData(season, userId) {
  const [players, teams, mineRows] = await Promise.all([
    roster.searchRoster(season.id),
    roster.seasonTeams(season.id),
    db.many('SELECT player_id FROM ratings WHERE rater_id = $1 AND season_id = $2', [userId, season.id]),
  ]);
  const summaries = await R.summariesForPlayers(players, season.id);
  const mine = new Set(mineRows.map((r) => r.player_id));
  const stats = (list) => {
    const rated = list.filter((p) => summaries.get(p.id).count > 0);
    const scores = rated.map((p) => summaries.get(p.id).avgOverall).filter((v) => v !== null);
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    return {
      players: list.length,
      rated: rated.length,
      ratedByMe: list.filter((p) => mine.has(p.id)).length,
      review: list.filter((p) => summaries.get(p.id).needsReview).length,
      avg,
      level: levelForScore(avg),
    };
  };
  const teamRows = teams.map((t) => {
    const members = players.filter((p) => p.memberships.some((m) => m.team_id === t.id));
    return { ...t, members, stats: stats(members) };
  });
  const leagues = new Map();
  for (const t of teamRows) {
    const key = leagueKey(t.division);
    if (!leagues.has(key)) leagues.set(key, { key, name: t.division || 'No league', teams: [] });
    leagues.get(key).teams.push(t);
  }
  for (const l of leagues.values()) {
    const people = [...new Map(l.teams.flatMap((t) => t.members).map((p) => [p.id, p])).values()];
    l.stats = stats(people);
  }
  const unassigned = players.filter((p) => !p.memberships.some((m) => m.team_id));
  const sorted = [...leagues.values()].sort((a, b) => (a.key === NO_LEAGUE) - (b.key === NO_LEAGUE) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { players, summaries, mine, leagues: sorted, unassigned, totals: stats(players) };
}

router.get('/players', requireAuth, async (req, res, next) => {
  if (!req.season) return noSeason(req, res);
  const searching = ['q', 'team', 'position', 'status', 'sort'].some((k) => req.query[k]) || req.query.view === 'all';
  if (searching) return next();
  const data = await browseData(req.season, req.user.id);
  res.render('players/leagues', { title: 'Leagues', ...data });
});

router.get('/leagues/:key', requireAuth, async (req, res) => {
  if (!req.season) return noSeason(req, res);
  const data = await browseData(req.season, req.user.id);
  const league = data.leagues.find((l) => l.key === leagueKey(req.params.key === NO_LEAGUE ? null : req.params.key));
  if (!league) return res.status(404).render('error', { title: 'Not found', message: `That league isn't in ${req.season.name}.` });
  res.render('players/league', { title: league.name, league });
});

router.get('/teams/:id', requireAuth, async (req, res) => {
  const team = await db.one('SELECT * FROM teams WHERE id = $1', [Number(req.params.id) || 0]);
  if (!team) return res.status(404).render('error', { title: 'Not found', message: 'Team not found.' });
  if (!req.season || req.season.id !== team.season_id) {
    // Follow the team into its season so ratings and links line up.
    req.session.seasonId = team.season_id;
    return res.redirect(req.originalUrl);
  }
  const players = await roster.teamRoster(team.id);
  const summaries = await R.summariesForPlayers(players, req.season.id);
  const mine = new Set(
    (await db.many('SELECT player_id FROM ratings WHERE rater_id = $1 AND season_id = $2', [req.user.id, req.season.id])).map((r) => r.player_id)
  );
  const rated = players.filter((p) => summaries.get(p.id).count > 0).length;
  res.render('players/team', {
    title: team.name,
    team,
    leagueHref: `/leagues/${leagueKey(team.division)}`,
    players,
    summaries,
    mine,
    rated,
    ratedByMe: players.filter((p) => mine.has(p.id)).length,
  });
});

// ---------- Search / filtered list ----------

router.get('/players', requireAuth, async (req, res) => {
  if (!req.season) return noSeason(req, res);
  const filters = {
    q: String(req.query.q || '').trim().slice(0, 100),
    team: String(req.query.team || ''),
    position: String(req.query.position || ''),
    status: String(req.query.status || ''),
    sort: String(req.query.sort || 'name'),
  };
  let players = await roster.searchRoster(req.season.id, { ...filters, teamId: filters.team });
  const summaries = await R.summariesForPlayers(players, req.season.id);
  const mine = new Set(
    (await db.many('SELECT player_id FROM ratings WHERE rater_id = $1 AND season_id = $2', [req.user.id, req.season.id])).map((r) => r.player_id)
  );
  if (filters.status === 'unrated') players = players.filter((p) => !mine.has(p.id));
  if (filters.status === 'rated') players = players.filter((p) => mine.has(p.id));
  if (filters.status === 'review') players = players.filter((p) => summaries.get(p.id).needsReview);
  if (filters.status === 'none') players = players.filter((p) => summaries.get(p.id).count === 0);
  if (filters.sort === 'rating') {
    players.sort((a, b) => (summaries.get(b.id).avgOverall ?? -1) - (summaries.get(a.id).avgOverall ?? -1));
  }
  res.render('players/index', { title: 'Players', players, summaries, mine, filters, teams: await roster.seasonTeams(req.season.id) });
});

router.get('/players/:id', requireAuth, async (req, res) => {
  const playerId = Number(req.params.id) || 0;
  const base = await db.one('SELECT * FROM players WHERE id = $1', [playerId]);
  if (!base || (!base.active && req.user.role !== 'admin')) {
    return res.status(404).render('error', { title: 'Not found', message: 'Player not found.' });
  }
  const entry = req.season ? await roster.seasonPlayer(req.season.id, playerId) : null;
  const player = entry || base;
  const { ratings, categories } = req.season
    ? await R.loadRatings({ playerIds: [playerId], seasonId: req.season.id })
    : { ratings: [], categories: await R.getCategories() };
  const summary = R.summarize(ratings, categories, player);
  const myRating = ratings.find((r) => r.rater_id === req.user.id) || null;
  const showNames = canSeeRaterNames(req.user);
  ratings.forEach((r, i) => {
    r.display_name = showNames || r.rater_id === req.user.id ? r.rater_name : `Rater ${i + 1}`;
  });
  const history = await R.playerHistory(playerId);
  res.render('players/show', {
    title: `${player.first_name} ${player.last_name}`,
    player,
    onRoster: Boolean(entry),
    ratings,
    categories,
    summary,
    myRating,
    history,
    canRate: Boolean(req.user.canRate && entry && base.active && req.season.ratings_open),
  });
});

function renderAlreadyRated(res, player) {
  return res.status(409).render('ratings/already-rated', { title: 'Already rated', player, message: R.ALREADY_RATED_MESSAGE });
}

// Returns the season roster row if this player can be rated in the selected season, else renders why not.
async function ratablePlayer(req, res) {
  if (!req.season) {
    noSeason(req, res);
    return null;
  }
  const player = await roster.seasonPlayer(req.season.id, Number(req.params.id) || 0);
  if (!player || !player.active) {
    res.status(404).render('error', { title: 'Not found', message: `That player isn't on the ${req.season.name} roster.` });
    return null;
  }
  if (!req.season.ratings_open) {
    res.status(403).render('error', { title: 'Ratings closed', message: `Ratings for ${req.season.name} are closed.` });
    return null;
  }
  return player;
}

async function existingRating(req, player) {
  return db.one('SELECT id FROM ratings WHERE season_id = $1 AND player_id = $2 AND rater_id = $3', [req.season.id, player.id, req.user.id]);
}

router.get('/players/:id/rate', requireRater, async (req, res) => {
  const player = await ratablePlayer(req, res);
  if (!player) return;
  if (await existingRating(req, player)) return renderAlreadyRated(res, player);
  const categories = await R.getCategories();
  res.render('ratings/form', { title: `Rate ${player.first_name} ${player.last_name}`, player, categories, values: {}, errors: [], mode: 'create', R });
});

router.post('/players/:id/rate', requireRater, async (req, res) => {
  const player = await ratablePlayer(req, res);
  if (!player) return;
  // Guard against the season being switched in another tab while the form was open.
  if (req.body.season_id && Number(req.body.season_id) !== req.season.id) {
    req.flash('error', 'You switched seasons while rating. Please check the season and submit again.');
    return res.redirect(`/players/${player.id}`);
  }
  if (await existingRating(req, player)) return renderAlreadyRated(res, player);

  const categories = await R.getCategories();
  const { errors, data, scores } = R.parseRatingForm(req.body, categories);
  if (errors.length) {
    return res.status(422).render('ratings/form', {
      title: `Rate ${player.first_name} ${player.last_name}`, player, categories, values: req.body, errors, mode: 'create', R,
    });
  }
  try {
    const ratingId = await db.tx(async (c) => {
      const id = await R.createRating(c, req.season.id, player.id, req.user.id, data, scores);
      await audit(req.user.id, 'rating_created', 'rating', id, { player_id: player.id, season_id: req.season.id }, c);
      return id;
    });
    req.flash('success', `Rating submitted for ${player.first_name} ${player.last_name}. Thank you!`);
    res.redirect(`/players/${player.id}#rating-${ratingId}`);
  } catch (err) {
    // Unique (season, player, rater) violation: a concurrent duplicate submission.
    if (err.code === '23505') return renderAlreadyRated(res, player);
    throw err;
  }
});

// ---------- Team summary report (mirrors the GURHA Team Player Rating & Division Summary) ----------

router.get('/reports/teams', requireAuth, async (req, res) => {
  if (!req.season) return noSeason(req, res);
  const teams = await roster.seasonTeams(req.season.id);
  const team = teams.find((t) => String(t.id) === String(req.query.team)) || null;
  let players = [];
  let summaries = new Map();
  if (team) {
    players = await roster.teamRoster(team.id);
    summaries = await R.summariesForPlayers(players, req.season.id);
  }
  res.render('players/team-report', { title: team ? `${team.name} summary` : 'Team summary', teams, team, players, summaries });
});

module.exports = router;
