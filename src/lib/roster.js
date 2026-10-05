'use strict';

// Season-scoped player queries. A "roster row" is a person merged with their season entry:
// p.* plus season_player_id, season_id, level_override(_note), the primary team spot
// (team_id, team, division, jersey_number, is_sub), position, and `memberships`: every team
// spot that season (a player can be on several teams, e.g. as a sub).
const db = require('../db');

const ROSTER_SELECT = `
  SELECT p.*, sp.id AS season_player_id, sp.season_id, sp.level_override, sp.level_override_note,
         pr.team_id, pr.team, pr.division, pr.jersey_number, pr.is_sub,
         (SELECT tr.position FROM team_rosters tr WHERE tr.season_player_id = sp.id AND tr.position IS NOT NULL
           ORDER BY tr.is_sub, tr.id LIMIT 1) AS position,
         coalesce(ms.memberships, '[]'::json) AS memberships
    FROM season_players sp
    JOIN players p ON p.id = sp.player_id
    LEFT JOIN LATERAL (
      SELECT tr.team_id, t.name AS team, t.division, tr.jersey_number, tr.is_sub
        FROM team_rosters tr LEFT JOIN teams t ON t.id = tr.team_id
       WHERE tr.season_player_id = sp.id
       ORDER BY tr.is_sub, (tr.team_id IS NULL), tr.id
       LIMIT 1
    ) pr ON true
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('id', tr.id, 'team_id', tr.team_id, 'team', t.name, 'division', t.division,
                                        'jersey_number', tr.jersey_number, 'position', tr.position, 'is_sub', tr.is_sub,
                                        'registration_id', tr.registration_id)
                      ORDER BY tr.is_sub, t.name) AS memberships
        FROM team_rosters tr LEFT JOIN teams t ON t.id = tr.team_id
       WHERE tr.season_player_id = sp.id
    ) ms ON true`;

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
    `SELECT t.*, (SELECT count(*) FROM team_rosters tr WHERE tr.team_id = t.id)::int AS player_count
       FROM teams t WHERE t.season_id = $1 ORDER BY lower(t.name)`,
    [seasonId]
  );
}

const ON_TEAM = (cond) =>
  `EXISTS (SELECT 1 FROM team_rosters tr LEFT JOIN teams t ON t.id = tr.team_id WHERE tr.season_player_id = sp.id AND ${cond})`;

// Season roster search used by the players page. Each person appears once.
async function searchRoster(seasonId, { q, teamId, position, includeInactive } = {}) {
  const where = ['sp.season_id = $1'];
  const params = [seasonId];
  if (!includeInactive) where.push('p.active');
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    const i = params.length;
    let clause = `lower(p.first_name || ' ' || p.last_name) LIKE $${i} OR lower(p.last_name || ', ' || p.first_name) LIKE $${i}
                  OR ${ON_TEAM(`(lower(coalesce(t.name, '')) LIKE $${i} OR lower(coalesce(t.division, '')) LIKE $${i})`)}`;
    if (/^#?\d{1,3}$/.test(q)) {
      params.push(q.replace('#', ''));
      clause += ` OR ${ON_TEAM(`tr.jersey_number = $${params.length}`)}`;
    }
    where.push(`(${clause})`);
  }
  if (teamId) {
    params.push(Number(teamId) || 0);
    where.push(ON_TEAM(`tr.team_id = $${params.length}`));
  }
  if (['F', 'D', 'G'].includes(position)) {
    params.push(position);
    where.push(ON_TEAM(`tr.position = $${params.length}`));
  }
  return db.many(`${ROSTER_SELECT} WHERE ${where.join(' AND ')} ORDER BY lower(p.last_name), lower(p.first_name) LIMIT 2000`, params);
}

// Players on one team, with that team's jersey number and sub flag (regulars first).
async function teamRoster(teamId) {
  return db.many(
    `SELECT r.*, tr.jersey_number AS team_jersey, tr.is_sub AS team_is_sub
       FROM (${ROSTER_SELECT}) r
       JOIN team_rosters tr ON tr.season_player_id = r.season_player_id AND tr.team_id = $1
      WHERE r.active
      ORDER BY tr.is_sub, NULLIF(regexp_replace(coalesce(tr.jersey_number, ''), '\\D', '', 'g'), '')::int NULLS LAST, lower(r.last_name)`,
    [teamId]
  );
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

// Puts a person in a season (idempotent). Returns the season_players id.
async function ensureSeasonPlayer(client, seasonId, playerId, source = 'manual') {
  const { rows } = await client.query(
    `INSERT INTO season_players (season_id, player_id, source) VALUES ($1, $2, $3)
     ON CONFLICT (season_id, player_id) DO UPDATE SET updated_at = now() RETURNING id`,
    [seasonId, playerId, source]
  );
  return rows[0].id;
}

// Adds or updates one team spot. Imported blanks never erase existing values, and a regular spot
// wins over a sub spot on the same team. Without a team, a team-less spot is kept only while the
// player has no team at all that season.
async function upsertMembership(client, seasonPlayerId, { team_id, jersey_number, position, is_sub = false, registration_id, source = 'manual' }) {
  if (!team_id) {
    await client.query(
      `INSERT INTO team_rosters (season_player_id, team_id, jersey_number, position, is_sub, registration_id, source)
       SELECT $1, NULL, $2, $3, $4, $5, $6 WHERE NOT EXISTS (SELECT 1 FROM team_rosters WHERE season_player_id = $1)`,
      [seasonPlayerId, jersey_number || null, position || null, Boolean(is_sub), registration_id || null, source]
    );
    return;
  }
  await client.query('DELETE FROM team_rosters WHERE season_player_id = $1 AND team_id IS NULL', [seasonPlayerId]);
  await client.query(
    `INSERT INTO team_rosters (season_player_id, team_id, jersey_number, position, is_sub, registration_id, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (season_player_id, (coalesce(team_id, 0))) DO UPDATE SET
       jersey_number = coalesce(EXCLUDED.jersey_number, team_rosters.jersey_number),
       position = coalesce(EXCLUDED.position, team_rosters.position),
       is_sub = team_rosters.is_sub AND EXCLUDED.is_sub,
       registration_id = coalesce(EXCLUDED.registration_id, team_rosters.registration_id),
       updated_at = now()`,
    [seasonPlayerId, team_id, jersey_number || null, position || null, Boolean(is_sub), registration_id || null, source]
  );
}

module.exports = {
  ROSTER_SELECT,
  listSeasons,
  loadSeason,
  seasonPlayer,
  seasonTeams,
  searchRoster,
  teamRoster,
  findOrCreateTeam,
  ensureSeasonPlayer,
  upsertMembership,
};
