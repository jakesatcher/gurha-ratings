'use strict';

// Season-scoped player queries. A "roster row" is a player merged with their season entry:
// p.* plus season_player_id, season_id, jersey_number, position, level_override(_note), team_id, team, division.
const db = require('../db');

const ROSTER_SELECT = `
  SELECT p.*, sp.id AS season_player_id, sp.season_id, sp.jersey_number, sp.position,
         sp.level_override, sp.level_override_note, t.id AS team_id, t.name AS team, t.division
    FROM season_players sp
    JOIN players p ON p.id = sp.player_id
    LEFT JOIN teams t ON t.id = sp.team_id`;

async function listSeasons() {
  return db.many('SELECT * FROM seasons ORDER BY coalesce(start_date, created_at::date) DESC, id DESC');
}

// Middleware: picks the season the signed-in user is viewing (session choice → current → newest).
async function loadSeason(req, res, next) {
  req.season = null;
  res.locals.season = null;
  res.locals.seasons = [];
  if (!req.user) return next();
  const seasons = await listSeasons();
  const season =
    seasons.find((s) => s.id === req.session.seasonId) || seasons.find((s) => s.is_current) || seasons[0] || null;
  req.season = season;
  res.locals.season = season;
  res.locals.seasons = seasons;
  next();
}

async function seasonPlayer(seasonId, playerId, client = db) {
  const { rows } = await client.query(`${ROSTER_SELECT} WHERE sp.season_id = $1 AND sp.player_id = $2`, [seasonId, playerId]);
  return rows[0] || null;
}

async function seasonTeams(seasonId) {
  return db.many(
    `SELECT t.*, (SELECT count(*) FROM season_players sp WHERE sp.team_id = t.id)::int AS player_count
       FROM teams t WHERE t.season_id = $1 ORDER BY lower(t.name)`,
    [seasonId]
  );
}

// Season roster search used by the players page.
async function searchRoster(seasonId, { q, teamId, position, includeInactive } = {}) {
  const where = ['sp.season_id = $1'];
  const params = [seasonId];
  if (!includeInactive) where.push('p.active');
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    const i = params.length;
    let clause = `lower(p.first_name || ' ' || p.last_name) LIKE $${i} OR lower(p.last_name || ', ' || p.first_name) LIKE $${i}
                  OR lower(coalesce(t.name, '')) LIKE $${i} OR lower(coalesce(t.division, '')) LIKE $${i}`;
    if (/^#?\d{1,3}$/.test(q)) {
      params.push(q.replace('#', ''));
      clause += ` OR sp.jersey_number = $${params.length}`;
    }
    where.push(`(${clause})`);
  }
  if (teamId) {
    params.push(Number(teamId) || 0);
    where.push(`t.id = $${params.length}`);
  }
  if (['F', 'D', 'G'].includes(position)) {
    params.push(position);
    where.push(`sp.position = $${params.length}`);
  }
  return db.many(`${ROSTER_SELECT} WHERE ${where.join(' AND ')} ORDER BY lower(p.last_name), lower(p.first_name) LIMIT 2000`, params);
}

// Finds or creates a team in a season, matching by external id then name.
async function findOrCreateTeam(client, seasonId, { name, division, external_id }) {
  if (!name) return null;
  let team = null;
  if (external_id) {
    team = (await client.query('SELECT * FROM teams WHERE season_id = $1 AND external_id = $2', [seasonId, external_id])).rows[0];
  }
  if (!team) {
    team = (await client.query('SELECT * FROM teams WHERE season_id = $1 AND lower(name) = lower($2)', [seasonId, name])).rows[0];
  }
  if (!team) {
    return (
      await client.query('INSERT INTO teams (season_id, name, division, external_id) VALUES ($1, $2, $3, $4) RETURNING *', [
        seasonId,
        name,
        division || null,
        external_id || null,
      ])
    ).rows[0];
  }
  if ((division && division !== team.division) || (external_id && !team.external_id) || name !== team.name) {
    team = (
      await client.query(
        `UPDATE teams SET name = $1, division = coalesce($2, division), external_id = coalesce(external_id, $3), updated_at = now()
          WHERE id = $4 RETURNING *`,
        [name, division || null, external_id || null, team.id]
      )
    ).rows[0];
  }
  return team;
}

// Adds/updates a player's roster entry for a season. Only provided values overwrite existing ones.
async function upsertSeasonPlayer(client, seasonId, playerId, { team_id, jersey_number, position, source = 'manual' }) {
  await client.query(
    `INSERT INTO season_players (season_id, player_id, team_id, jersey_number, position, source)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (season_id, player_id) DO UPDATE SET
       team_id = coalesce(EXCLUDED.team_id, season_players.team_id),
       jersey_number = coalesce(EXCLUDED.jersey_number, season_players.jersey_number),
       position = coalesce(EXCLUDED.position, season_players.position),
       updated_at = now()`,
    [seasonId, playerId, team_id || null, jersey_number || null, position || null, source]
  );
}

module.exports = { ROSTER_SELECT, listSeasons, loadSeason, seasonPlayer, seasonTeams, searchRoster, findOrCreateTeam, upsertSeasonPlayer };
