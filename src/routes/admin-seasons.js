'use strict';

// Admin: seasons, teams, and the SportsEngine season/team browser. Mounted inside the admin router.
const express = require('express');

const db = require('../db');
const sportsengine = require('../lib/sportsengine');
const roster = require('../lib/roster');
const { upsertPlayers } = require('../lib/players');
const { audit } = require('../lib/audit');

const router = express.Router();
const id = (req) => Number(req.params.id) || 0;

// Same-site page the form came from (Express 5 dropped redirect('back')).
function back(req, fallback) {
  try {
    const ref = new URL(req.get('Referer'));
    if (ref.host === req.get('host')) return ref.pathname + ref.search;
  } catch {
    /* ignore */
  }
  return fallback;
}

function parseDate(v) {
  const s = String(v || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}

function seasonFromBody(body) {
  return {
    name: String(body.name || '').trim().slice(0, 100),
    start_date: parseDate(body.start_date),
    end_date: parseDate(body.end_date),
    ratings_open: body.ratings_open === 'on',
  };
}

async function makeCurrent(client, seasonId) {
  await client.query('UPDATE seasons SET is_current = false WHERE is_current AND id <> $1', [seasonId]);
  await client.query('UPDATE seasons SET is_current = true, updated_at = now() WHERE id = $1', [seasonId]);
}

async function nameTaken(name, exceptId = 0) {
  return Boolean(await db.one('SELECT 1 FROM seasons WHERE lower(name) = lower($1) AND id <> $2', [name, exceptId]));
}

// Copies teams and roster entries (not ratings or level overrides) from one season into another.
async function copyRoster(client, fromId, toId) {
  await client.query(
    `INSERT INTO teams (season_id, name, division, external_id)
     SELECT $2, t.name, t.division, NULL FROM teams t WHERE t.season_id = $1
     ON CONFLICT DO NOTHING`,
    [fromId, toId]
  );
  const { rowCount } = await client.query(
    `INSERT INTO season_players (season_id, player_id, team_id, jersey_number, position, source)
     SELECT $2, sp.player_id, nt.id, sp.jersey_number, sp.position, 'copy'
       FROM season_players sp
       LEFT JOIN teams ot ON ot.id = sp.team_id
       LEFT JOIN teams nt ON nt.season_id = $2 AND lower(nt.name) = lower(ot.name)
      WHERE sp.season_id = $1
     ON CONFLICT (season_id, player_id) DO NOTHING`,
    [fromId, toId]
  );
  return rowCount;
}

// ---------- Seasons ----------

router.get('/seasons', async (req, res) => {
  const seasons = await db.many(
    `SELECT s.*,
            (SELECT count(*) FROM teams t WHERE t.season_id = s.id)::int AS team_count,
            (SELECT count(*) FROM season_players sp WHERE sp.season_id = s.id)::int AS player_count,
            (SELECT count(*) FROM ratings r WHERE r.season_id = s.id)::int AS rating_count
       FROM seasons s ORDER BY coalesce(s.start_date, s.created_at::date) DESC, s.id DESC`
  );
  res.render('admin/seasons', { title: 'Seasons', seasonsList: seasons });
});

router.post('/seasons', async (req, res) => {
  const s = seasonFromBody(req.body);
  if (!s.name) {
    req.flash('error', 'Season name is required.');
    return res.redirect('/admin/seasons');
  }
  if (await nameTaken(s.name)) {
    req.flash('error', `A season named "${s.name}" already exists.`);
    return res.redirect('/admin/seasons');
  }
  const copyFrom = Number(req.body.copy_from) || 0;
  const created = await db.tx(async (c) => {
    const { rows } = await c.query(
      'INSERT INTO seasons (name, start_date, end_date, ratings_open) VALUES ($1, $2, $3, $4) RETURNING *',
      [s.name, s.start_date, s.end_date, s.ratings_open]
    );
    const season = rows[0];
    if (req.body.make_current === 'on') await makeCurrent(c, season.id);
    season.copied = copyFrom ? await copyRoster(c, copyFrom, season.id) : 0;
    await audit(req.user.id, 'season_created', 'season', season.id, { name: s.name, copied_from: copyFrom || null }, c);
    return season;
  });
  req.session.seasonId = created.id;
  req.flash('success', `Season "${created.name}" created${created.copied ? ` with ${created.copied} players copied` : ''}. You're now viewing it.`);
  res.redirect(`/admin/seasons/${created.id}`);
});

router.get('/seasons/:id', async (req, res) => {
  const season = await db.one('SELECT * FROM seasons WHERE id = $1', [id(req)]);
  if (!season) return res.redirect('/admin/seasons');
  const teams = await roster.seasonTeams(season.id);
  const unassigned = (await db.one('SELECT count(*)::int AS n FROM season_players WHERE season_id = $1 AND team_id IS NULL', [season.id])).n;
  const ratingCount = (await db.one('SELECT count(*)::int AS n FROM ratings WHERE season_id = $1', [season.id])).n;
  res.render('admin/season', { title: season.name, editSeason: season, teams, unassigned, ratingCount });
});

router.post('/seasons/:id', async (req, res) => {
  const season = await db.one('SELECT * FROM seasons WHERE id = $1', [id(req)]);
  if (!season) return res.redirect('/admin/seasons');
  const s = seasonFromBody(req.body);
  if (!s.name || (await nameTaken(s.name, season.id))) {
    req.flash('error', s.name ? `A season named "${s.name}" already exists.` : 'Season name is required.');
    return res.redirect(`/admin/seasons/${season.id}`);
  }
  await db.query('UPDATE seasons SET name = $1, start_date = $2, end_date = $3, ratings_open = $4, updated_at = now() WHERE id = $5', [
    s.name, s.start_date, s.end_date, s.ratings_open, season.id,
  ]);
  await audit(req.user.id, 'season_updated', 'season', season.id, { name: s.name, ratings_open: s.ratings_open });
  req.flash('success', 'Season saved.');
  res.redirect(`/admin/seasons/${season.id}`);
});

router.post('/seasons/:id/current', async (req, res) => {
  const season = await db.one('SELECT * FROM seasons WHERE id = $1', [id(req)]);
  if (season) {
    await db.tx((c) => makeCurrent(c, season.id));
    await audit(req.user.id, 'season_made_current', 'season', season.id);
    req.flash('success', `"${season.name}" is now the current season. Everyone sees it by default.`);
  }
  res.redirect('/admin/seasons');
});

router.post('/seasons/:id/delete', async (req, res) => {
  const season = await db.one('SELECT * FROM seasons WHERE id = $1', [id(req)]);
  if (!season) return res.redirect('/admin/seasons');
  const ratings = (await db.one('SELECT count(*)::int AS n FROM ratings WHERE season_id = $1', [season.id])).n;
  if (ratings) {
    req.flash('error', `"${season.name}" has ${ratings} ratings and can't be deleted. Close ratings for it instead.`);
    return res.redirect(`/admin/seasons/${season.id}`);
  }
  await db.query('DELETE FROM seasons WHERE id = $1', [season.id]);
  await audit(req.user.id, 'season_deleted', 'season', season.id, { name: season.name });
  if (req.session.seasonId === season.id) delete req.session.seasonId;
  req.flash('success', `Season "${season.name}" deleted.`);
  res.redirect('/admin/seasons');
});

// ---------- Teams ----------

router.post('/teams/:id', async (req, res) => {
  const team = await db.one('SELECT * FROM teams WHERE id = $1', [id(req)]);
  if (!team) return res.redirect('/admin/seasons');
  const name = String(req.body.name || '').trim().slice(0, 100);
  const division = String(req.body.division || '').trim().slice(0, 100) || null;
  const clash = name && (await db.one('SELECT 1 FROM teams WHERE season_id = $1 AND lower(name) = lower($2) AND id <> $3', [team.season_id, name, team.id]));
  if (!name || clash) {
    req.flash('error', name ? `This season already has a team named "${name}".` : 'Team name is required.');
  } else {
    await db.query('UPDATE teams SET name = $1, division = $2, updated_at = now() WHERE id = $3', [name, division, team.id]);
    await audit(req.user.id, 'team_updated', 'team', team.id, { name, division });
    req.flash('success', `Team "${name}" saved.`);
  }
  res.redirect(`/admin/seasons/${team.season_id}`);
});

router.post('/teams/:id/delete', async (req, res) => {
  const team = await db.one('SELECT * FROM teams WHERE id = $1', [id(req)]);
  if (!team) return res.redirect('/admin/seasons');
  await db.query('DELETE FROM teams WHERE id = $1', [team.id]);
  await audit(req.user.id, 'team_deleted', 'team', team.id, { name: team.name, season_id: team.season_id });
  req.flash('success', `Team "${team.name}" deleted. Its players stay on the season roster without a team.`);
  res.redirect(`/admin/seasons/${team.season_id}`);
});

// ---------- SportsEngine browser ----------

function seOff(req, res) {
  if (sportsengine.isConfigured()) return false;
  res.render('admin/sportsengine', { title: 'SportsEngine', step: 'off' });
  return true;
}

// Step 1: pick a SportsEngine season (or browse all teams if the API has no seasons).
router.get('/sportsengine', async (req, res) => {
  if (seOff(req, res)) return;
  let result = null;
  let error = null;
  try {
    result = await sportsengine.listSeasons();
  } catch (err) {
    error = err.message;
  }
  const linked = new Map((await db.many(`SELECT id, name, external_id FROM seasons WHERE external_id LIKE 'se:%'`)).map((s) => [s.external_id.slice(3), s]));
  res.render('admin/sportsengine', { title: 'SportsEngine', step: 'seasons', result, error, linked });
});

// Step 2: pick teams within that season, and the local season to import into.
router.get('/sportsengine/teams', async (req, res) => {
  if (seOff(req, res)) return;
  const seSeason = {
    id: String(req.query.season || '').slice(0, 100) || null,
    name: String(req.query.name || '').slice(0, 100) || null,
    start_date: parseDate(req.query.start),
    end_date: parseDate(req.query.end),
  };
  let result = null;
  let error = null;
  try {
    result = await sportsengine.listTeams(seSeason.id);
  } catch (err) {
    error = err.message;
  }
  const localSeasons = await roster.listSeasons();
  const linked = seSeason.id ? localSeasons.find((s) => s.external_id === `se:${seSeason.id}`) : null;
  const imported = new Set(
    (await db.many(`SELECT external_id FROM teams WHERE external_id LIKE 'se:%'${linked ? ' AND season_id = $1' : ' AND false'}`, linked ? [linked.id] : [])).map(
      (t) => t.external_id.slice(3)
    )
  );
  res.render('admin/sportsengine', { title: 'SportsEngine', step: 'teams', seSeason, result, error, localSeasons, linked, imported });
});

// Step 3: import the selected teams' rosters into a local season.
router.post('/sportsengine/import', async (req, res) => {
  if (seOff(req, res)) return;
  const teamIds = [].concat(req.body.team_ids || []).map(String).filter(Boolean);
  const seSeasonId = String(req.body.se_season_id || '') || null;
  if (!teamIds.length) {
    req.flash('error', 'Select at least one team to import.');
    return res.redirect(`/admin/sportsengine/teams?${new URLSearchParams({ season: seSeasonId || '', name: req.body.se_season_name || '' })}`);
  }

  // Resolve (or create) the local season.
  let season;
  if (req.body.target === 'new') {
    const name = String(req.body.new_season_name || '').trim().slice(0, 100);
    if (!name || (await nameTaken(name))) {
      req.flash('error', name ? `A season named "${name}" already exists. Pick it from the list instead.` : 'Enter a name for the new season.');
      return res.redirect(back(req, '/admin/sportsengine'));
    }
    const externalId = seSeasonId ? `se:${seSeasonId}` : null;
    const clash = externalId && (await db.one('SELECT id FROM seasons WHERE external_id = $1', [externalId]));
    season = await db.one('INSERT INTO seasons (name, start_date, end_date, external_id) VALUES ($1, $2, $3, $4) RETURNING *', [
      name,
      parseDate(req.body.se_start_date),
      parseDate(req.body.se_end_date),
      clash ? null : externalId,
    ]);
    if (req.body.make_current === 'on') await db.tx((c) => makeCurrent(c, season.id));
    await audit(req.user.id, 'season_created', 'season', season.id, { name, source: 'sportsengine', se_season_id: seSeasonId });
  } else {
    season = await db.one('SELECT * FROM seasons WHERE id = $1', [Number(req.body.target) || 0]);
    if (!season) {
      req.flash('error', 'Choose a season to import into.');
      return res.redirect(back(req, '/admin/sportsengine'));
    }
    if (seSeasonId && !season.external_id) {
      await db.query(`UPDATE seasons SET external_id = $1 WHERE id = $2 AND NOT EXISTS (SELECT 1 FROM seasons WHERE external_id = $1)`, [
        `se:${seSeasonId}`,
        season.id,
      ]);
    }
  }

  try {
    const [players, { teams }] = await Promise.all([
      sportsengine.fetchRoster({ teamIds, seasonId: seSeasonId }),
      sportsengine.listTeams(seSeasonId),
    ]);
    const selectedTeams = teams.filter((t) => teamIds.includes(t.id));
    const result = await db.tx(async (c) => {
      // Create every selected team, even ones with no players yet.
      for (const t of selectedTeams) await roster.findOrCreateTeam(c, season.id, { name: t.name, division: t.division, external_id: `se:${t.id}` });
      return upsertPlayers(players, 'sportsengine', season.id, c);
    });
    await audit(req.user.id, 'sportsengine_import', 'season', season.id, {
      se_season_id: seSeasonId,
      teams: selectedTeams.map((t) => t.name),
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
    });
    req.session.seasonId = season.id;
    res.render('admin/sportsengine', { title: 'SportsEngine', step: 'done', importResult: result, importSeason: season, teamCount: selectedTeams.length });
  } catch (err) {
    console.error(err);
    req.flash('error', `${err.message} — try SportsEngine diagnostics for details.`);
    res.redirect('/admin/sportsengine');
  }
});

// Dry run: shows what the API returns and which players would be imported, without saving anything.
router.get('/sportsengine/diagnostics', (req, res) => {
  res.render('admin/sportsengine-diagnostics', { title: 'SportsEngine diagnostics', seConfigured: sportsengine.isConfigured(), report: null });
});

router.post('/sportsengine/diagnostics', async (req, res) => {
  const diagnostics = {};
  let players = [];
  let error = null;
  sportsengine.resetCache();
  try {
    players = await sportsengine.fetchRoster({ diagnostics });
  } catch (err) {
    error = err.message;
  }
  const sample = diagnostics.sample === undefined ? null : JSON.stringify(diagnostics.sample, null, 2);
  res.render('admin/sportsengine-diagnostics', {
    title: 'SportsEngine diagnostics',
    seConfigured: sportsengine.isConfigured(),
    report: {
      error,
      diagnostics,
      players: players.slice(0, 25),
      total: players.length,
      sample: sample && sample.length > 20000 ? `${sample.slice(0, 20000)}\n… (truncated)` : sample,
    },
  });
});

module.exports = router;
