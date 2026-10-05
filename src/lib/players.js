'use strict';

const { parse } = require('csv-parse/sync');
const db = require('../db');
const { findOrCreateTeam, upsertSeasonPlayer } = require('./roster');

const FIELD_ALIASES = {
  first_name: ['first_name', 'firstname', 'first', 'given_name', 'givenname'],
  last_name: ['last_name', 'lastname', 'last', 'surname', 'family_name', 'familyname'],
  name: ['name', 'player', 'player_name', 'playername', 'full_name', 'fullname'],
  jersey_number: ['jersey_number', 'jersey', 'jerseynumber', 'number', 'no', '#', 'jersey_#', 'jersey_no'],
  team: ['team', 'team_name', 'teamname'],
  division: ['division', 'league', 'league_division', 'league/division', 'level', 'tier'],
  position: ['position', 'pos'],
  age: ['age'],
  email: ['email', 'e-mail', 'email_address'],
  external_id: ['external_id', 'externalid', 'id', 'player_id', 'playerid', 'sportsengine_id', 'member_id'],
  team_external_id: ['team_external_id'],
  notes: ['notes', 'note', 'comments'],
};

function normKey(k) {
  return String(k).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizePosition(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (['g', 'goalie', 'goaltender', 'goalkeeper', 'gk'].includes(s) || s.startsWith('goal')) return 'G';
  if (['d', 'defense', 'defence', 'defenseman', 'defenceman', 'ld', 'rd'].includes(s) || s.startsWith('def')) return 'D';
  if (['f', 'forward', 'fwd', 'c', 'center', 'centre', 'lw', 'rw', 'w', 'wing', 'left wing', 'right wing'].includes(s)) return 'F';
  return null;
}

function pickField(row, field) {
  for (const alias of FIELD_ALIASES[field]) {
    if (row[alias] !== undefined && row[alias] !== null && String(row[alias]).trim() !== '') return String(row[alias]).trim();
  }
  return null;
}

// Converts an arbitrary row object into a normalized player record (or { error }).
function normalizePlayer(raw) {
  const row = {};
  for (const [k, v] of Object.entries(raw || {})) row[normKey(k)] = v;
  let first = pickField(row, 'first_name');
  let last = pickField(row, 'last_name');
  const full = pickField(row, 'name');
  if ((!first || !last) && full) {
    if (full.includes(',')) {
      const [l, f] = full.split(',').map((s) => s.trim());
      first = first || f;
      last = last || l;
    } else {
      const parts = full.split(/\s+/);
      first = first || parts.shift();
      last = last || parts.join(' ');
    }
  }
  if (!first || !last) return { error: 'Missing first/last name' };
  const ageRaw = pickField(row, 'age');
  const age = ageRaw && /^\d{1,3}$/.test(ageRaw) ? Number(ageRaw) : null;
  return {
    first_name: first.slice(0, 100),
    last_name: last.slice(0, 100),
    jersey_number: (pickField(row, 'jersey_number') || '').replace(/^#/, '').slice(0, 10) || null,
    team: pickField(row, 'team'),
    division: pickField(row, 'division'),
    position: normalizePosition(pickField(row, 'position')),
    age: age && age > 0 && age < 120 ? age : null,
    email: pickField(row, 'email'),
    external_id: pickField(row, 'external_id'),
    team_external_id: pickField(row, 'team_external_id'),
    notes: pickField(row, 'notes'),
  };
}

function parseUpload(buffer, filename = '') {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const looksJson = filename.toLowerCase().endsWith('.json') || /^\s*[[{]/.test(text);
  if (looksJson) {
    const data = JSON.parse(text);
    const rows = Array.isArray(data) ? data : data.players || data.roster || data.data || [];
    if (!Array.isArray(rows)) throw new Error('JSON must be an array of players or { "players": [...] }');
    return rows;
  }
  return parse(text, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
}

const PLAYER_FIELDS = ['first_name', 'last_name', 'age', 'email', 'notes'];

// Finds an existing player for an imported record: external id → name + team this season → email → unique name.
async function findPlayer(client, seasonId, p) {
  const q = async (sql, params) => (await client.query(sql, params)).rows;
  if (p.external_id) {
    const r = await q('SELECT id FROM players WHERE external_id = $1', [p.external_id]);
    if (r.length) return r[0];
  }
  if (p.team) {
    const r = await q(
      `SELECT pl.id FROM players pl JOIN season_players sp ON sp.player_id = pl.id JOIN teams t ON t.id = sp.team_id
        WHERE sp.season_id = $1 AND lower(t.name) = lower($2) AND lower(pl.first_name) = lower($3) AND lower(pl.last_name) = lower($4)`,
      [seasonId, p.team, p.first_name, p.last_name]
    );
    if (r.length) return r[0];
  }
  if (p.email) {
    const r = await q('SELECT id FROM players WHERE lower(email) = lower($1)', [p.email]);
    if (r.length === 1) return r[0];
  }
  const r = await q(
    `SELECT id FROM players WHERE lower(first_name) = lower($1) AND lower(last_name) = lower($2) AND (external_id IS NULL OR $3::text IS NULL)`,
    [p.first_name, p.last_name, p.external_id || null]
  );
  return r.length === 1 ? r[0] : null;
}

// Inserts or updates players and their roster entries for a season.
async function upsertPlayers(rawRows, source, seasonId, client = db) {
  if (!seasonId) throw new Error('Choose a season to import into.');
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };
  for (let i = 0; i < rawRows.length; i++) {
    const p = normalizePlayer(rawRows[i]);
    if (p.error) {
      result.skipped++;
      result.errors.push(`Row ${i + 1}: ${p.error}`);
      continue;
    }
    let player = await findPlayer(client, seasonId, p);
    if (player) {
      const sets = [];
      const vals = [];
      for (const f of PLAYER_FIELDS) {
        if (p[f] !== null && p[f] !== undefined) {
          vals.push(p[f]);
          sets.push(`${f} = $${vals.length}`);
        }
      }
      vals.push(p.external_id || null);
      sets.push(`external_id = coalesce(external_id, $${vals.length})`);
      vals.push(player.id);
      await client.query(`UPDATE players SET ${sets.join(', ')}, active = true, updated_at = now() WHERE id = $${vals.length}`, vals);
      result.updated++;
    } else {
      player = (
        await client.query(
          `INSERT INTO players (first_name, last_name, age, email, notes, external_id, source) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [...PLAYER_FIELDS.map((f) => p[f]), p.external_id, source]
        )
      ).rows[0];
      result.created++;
    }
    const team = await findOrCreateTeam(client, seasonId, { name: p.team, division: p.division, external_id: p.team_external_id });
    await upsertSeasonPlayer(client, seasonId, player.id, {
      team_id: team && team.id,
      jersey_number: p.jersey_number,
      position: p.position,
      source,
    });
  }
  return result;
}

module.exports = { normalizePlayer, normalizePosition, parseUpload, upsertPlayers };
