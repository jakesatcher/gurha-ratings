'use strict';

const { parse } = require('csv-parse/sync');
const db = require('../db');
const { findOrCreateTeam, ensureSeasonPlayer, upsertMembership } = require('./roster');
const { normalizeName, nameKey, matchPlayer, linkExternalId } = require('./identity');

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
  birth_date: ['birth_date', 'date_of_birth', 'dob', 'birthdate'],
  is_sub: ['is_sub', 'sub', 'substitute'],
  notes: ['notes', 'note', 'comments'],
};

// Accepts YYYY-MM-DD or MM/DD/YYYY; returns YYYY-MM-DD or null.
function parseDate(v) {
  if (!v) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  let y, mo, d;
  if (m) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v))) [y, mo, d] = [+m[3], +m[1], +m[2]];
  else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 1900 || dt > new Date()) return null;
  return dt.toISOString().slice(0, 10);
}

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
  // "Hassan (Sub)" → last name "Hassan", marked as a sub on this team.
  const clean = normalizeName(first, last);
  if (!clean.first_name || !clean.last_name) return { error: 'Missing first/last name' };
  first = clean.first_name;
  last = clean.last_name;
  const subRaw = pickField(row, 'is_sub');
  const ageRaw = pickField(row, 'age');
  const age = ageRaw && /^\d{1,3}$/.test(ageRaw) ? Number(ageRaw) : null;
  return {
    first_name: first.slice(0, 100),
    last_name: last.slice(0, 100),
    jersey_number: (pickField(row, 'jersey_number') || '').replace(/^#/, '').slice(0, 10) || null,
    team: pickField(row, 'team'),
    division: pickField(row, 'division'),
    position: normalizePosition(pickField(row, 'position')) || clean.position,
    age: age && age > 0 && age < 120 ? age : null,
    email: pickField(row, 'email'),
    external_id: pickField(row, 'external_id'),
    team_external_id: pickField(row, 'team_external_id'),
    birth_date: parseDate(pickField(row, 'birth_date')),
    is_sub: clean.isSub || (subRaw !== null && ['1', 'true', 'yes', 'y', 'sub', 'x'].includes(subRaw.toLowerCase())),
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

// Inserts or updates people and their team spots for a season.
// Returns counts plus `matches`: how each row was resolved (for the import report).
// Pass the same `seen` Set across calls that make up one import so people count once.
async function upsertPlayers(rawRows, source, seasonId, client = db, { seen } = {}) {
  if (!seasonId) throw new Error('Choose a season to import into.');
  const result = { created: 0, updated: 0, skipped: 0, errors: [], matches: [], ambiguous: [] };
  const seenThisImport = seen || new Set();
  for (let i = 0; i < rawRows.length; i++) {
    const p = normalizePlayer(rawRows[i]);
    if (p.error) {
      result.skipped++;
      result.errors.push(`Row ${i + 1}: ${p.error}`);
      continue;
    }
    const match = await matchPlayer(client, { ...p, seasonId });
    let player = match.player;
    if (player) {
      // Keep the stored name (admins may have corrected it); fill in anything we didn't know.
      await client.query(
        `UPDATE players SET birth_date = coalesce(birth_date, $1), email = coalesce(email, $2), age = coalesce(age, $3),
                active = true, updated_at = now() WHERE id = $4`,
        [p.birth_date, p.email, p.age, player.id]
      );
      if (seenThisImport.has(player.id)) result.matches.push({ row: i + 1, name: `${p.first_name} ${p.last_name}`, player_id: player.id, how: `same person as an earlier row (${match.how})` });
      else {
        result.updated++;
        if (match.how !== 'registration ID') result.matches.push({ row: i + 1, name: `${p.first_name} ${p.last_name}`, player_id: player.id, how: match.how });
      }
    } else {
      player = (
        await client.query(
          `INSERT INTO players (first_name, last_name, name_key, age, birth_date, email, notes, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [p.first_name, p.last_name, nameKey(p.first_name, p.last_name), p.age, p.birth_date, p.email, p.notes, source]
        )
      ).rows[0];
      result.created++;
      if (match.ambiguous.length) result.ambiguous.push({ row: i + 1, name: `${p.first_name} ${p.last_name}`, player_id: player.id });
    }
    seenThisImport.add(player.id);
    await linkExternalId(client, player.id, p.external_id, source);
    const team = await findOrCreateTeam(client, seasonId, { name: p.team, division: p.division, external_id: p.team_external_id });
    const spId = await ensureSeasonPlayer(client, seasonId, player.id, source);
    await upsertMembership(client, spId, {
      team_id: team && team.id,
      jersey_number: p.jersey_number,
      position: p.position,
      is_sub: p.is_sub,
      registration_id: p.external_id,
      source,
    });
  }
  return result;
}

// Read-only dry run of upsertPlayers' matching for the import review screen.
// Returns one { status, how, player_id } per row: 'existing' | 'duplicate-in-file' | 'new' | 'new-ambiguous'.
async function previewPlayers(rawRows, seasonId, client = db) {
  const inFile = new Map(); // name key → [{ birth_date, label }]
  const out = [];
  for (const raw of rawRows) {
    const p = normalizePlayer(raw);
    if (p.error) {
      out.push({ status: 'error', how: p.error });
      continue;
    }
    const key = nameKey(p.first_name, p.last_name);
    const earlier = (inFile.get(key) || []).find((e) => !e.birth_date || !p.birth_date || e.birth_date === p.birth_date);
    const match = await matchPlayer(client, { ...p, seasonId });
    if (match.player) out.push({ status: 'existing', how: match.how, player_id: match.player.id, also: earlier ? earlier.label : null });
    else if (earlier) out.push({ status: 'duplicate-in-file', how: `same person as ${earlier.label}` });
    else out.push({ status: match.ambiguous.length ? 'new-ambiguous' : 'new', how: match.ambiguous.length ? 'several players share this name' : null });
    if (!inFile.has(key)) inFile.set(key, []);
    inFile.get(key).push({ birth_date: p.birth_date, label: raw.__label || `row ${out.length}` });
  }
  return out;
}

module.exports = { normalizePlayer, normalizePosition, parseDate, parseUpload, upsertPlayers, previewPlayers };
