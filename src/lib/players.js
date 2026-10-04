'use strict';

const { parse } = require('csv-parse/sync');
const db = require('../db');

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

const UPSERT_FIELDS = ['first_name', 'last_name', 'jersey_number', 'team', 'division', 'position', 'age', 'email', 'notes'];

// Inserts or updates players. Matches on external_id first, then on name + team.
async function upsertPlayers(rawRows, source, client = db) {
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };
  for (let i = 0; i < rawRows.length; i++) {
    const p = normalizePlayer(rawRows[i]);
    if (p.error) {
      result.skipped++;
      result.errors.push(`Row ${i + 1}: ${p.error}`);
      continue;
    }
    let existing = null;
    if (p.external_id) {
      existing = (await client.query('SELECT id FROM players WHERE external_id = $1', [p.external_id])).rows[0];
    }
    if (!existing) {
      existing = (
        await client.query(
          `SELECT id FROM players WHERE lower(first_name) = lower($1) AND lower(last_name) = lower($2)
             AND coalesce(lower(team), '') = coalesce(lower($3), '') LIMIT 1`,
          [p.first_name, p.last_name, p.team]
        )
      ).rows[0];
    }
    if (existing) {
      // Only overwrite fields the import actually provides.
      const sets = [];
      const vals = [];
      for (const f of UPSERT_FIELDS) {
        if (p[f] !== null && p[f] !== undefined) {
          vals.push(p[f]);
          sets.push(`${f} = $${vals.length}`);
        }
      }
      if (p.external_id) {
        vals.push(p.external_id);
        sets.push(`external_id = coalesce(external_id, $${vals.length})`);
      }
      vals.push(existing.id);
      await client.query(`UPDATE players SET ${sets.join(', ')}, active = true, updated_at = now() WHERE id = $${vals.length}`, vals);
      result.updated++;
    } else {
      await client.query(
        `INSERT INTO players (first_name, last_name, jersey_number, team, division, position, age, email, notes, external_id, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [...UPSERT_FIELDS.map((f) => p[f]), p.external_id, source]
      );
      result.created++;
    }
  }
  return result;
}

module.exports = { normalizePlayer, normalizePosition, parseUpload, upsertPlayers };
