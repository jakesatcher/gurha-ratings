'use strict';

// Paper rating forms: a printed sheet lists several players (rows) and the rating categories
// (columns). Admins print it, raters fill it in by hand, and an admin types the results back in,
// optionally attaching the scan/photo of the sheet as the record.
const db = require('../db');
const R = require('./ratings');
const L = require('./levels');

const ROWS_PER_PAGE = 10;
const MAX_SCAN_BYTES = 10 * 1024 * 1024;

// Identify scans by their first bytes rather than trusting the browser-supplied type.
function sniffScan(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const brand = buf.slice(4, 12).toString('latin1');
  if (/^ftyp(heic|heix|mif1|msf1)/.test(brand)) return 'image/heic';
  return null;
}

async function createForm(client, { seasonId, teamId, title, playerIds, categoryIds, blankRows, userId }) {
  const { rows } = await client.query(
    `INSERT INTO paper_forms (code, season_id, team_id, title, player_ids, category_ids, blank_rows, created_by)
     VALUES (md5(random()::text), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [seasonId, teamId || null, title, playerIds, categoryIds, blankRows, userId]
  );
  const code = `PF-${String(rows[0].id).padStart(4, '0')}`;
  await client.query('UPDATE paper_forms SET code = $1 WHERE id = $2', [code, rows[0].id]);
  return { id: rows[0].id, code };
}

// The form with its players (in printed order, with jersey numbers for the form's team) and categories.
async function loadForm(id) {
  const form = await db.one(
    `SELECT f.*, s.name AS season_name, t.name AS team_name, t.division
       FROM paper_forms f JOIN seasons s ON s.id = f.season_id LEFT JOIN teams t ON t.id = f.team_id
      WHERE f.id = $1`,
    [id]
  );
  if (!form) return null;
  const players = await db.many(
    `SELECT p.id, p.first_name, p.last_name, p.active,
            (SELECT tr.jersey_number FROM season_players sp JOIN team_rosters tr ON tr.season_player_id = sp.id
              WHERE sp.player_id = p.id AND sp.season_id = $2 AND ($3::int IS NULL OR tr.team_id = $3)
              ORDER BY tr.is_sub, tr.id LIMIT 1) AS jersey_number,
            (SELECT bool_and(tr.is_sub) FROM season_players sp JOIN team_rosters tr ON tr.season_player_id = sp.id
              WHERE sp.player_id = p.id AND sp.season_id = $2 AND tr.team_id = $3) AS is_sub
       FROM players p WHERE p.id = ANY($1::int[])`,
    [form.player_ids, form.season_id, form.team_id]
  );
  const byId = new Map(players.map((p) => [p.id, p]));
  form.players = form.player_ids.map((pid) => byId.get(pid)).filter(Boolean); // deleted players drop out
  const cats = await db.many('SELECT * FROM categories WHERE id = ANY($1::int[])', [form.category_ids]);
  const catById = new Map(cats.map((c) => [c.id, c]));
  form.categories = form.category_ids.map((cid) => catById.get(cid)).filter(Boolean);
  form.rowCount = form.players.length + form.blank_rows;
  form.pages = Math.max(1, Math.ceil(form.rowCount / ROWS_PER_PAGE));
  return form;
}

// Reads the entry grid. Row fields: r{i}_player (write-in rows), r{i}_s{categoryId} (the points the
// rater wrote: 0, 1, 1.5, 2, 3 … 15) and r{i}_notes (comments). Blank rows are
// skipped; partly filled rows are errors.
function parseGrid(body, form) {
  const rows = [];
  const errors = [];
  const seen = new Set();
  for (let i = 0; i < form.rowCount; i++) {
    const printed = form.players[i] || null;
    const get = (k) => String(body[`r${i}_${k}`] ?? '').trim();
    const fields = [...form.categories.map((c) => get(`s${c.id}`)), get('notes')];
    const writeIn = printed ? null : Number(get('player')) || null;
    if (!fields.some(Boolean) && !writeIn) continue; // untouched row
    const label = printed ? `Row ${i + 1} (${printed.first_name} ${printed.last_name})` : `Row ${i + 1} (write-in)`;
    const playerId = printed ? printed.id : writeIn;
    if (!playerId) {
      errors.push(`${label}: choose which player this write-in row is for.`);
      continue;
    }
    if (seen.has(playerId)) {
      errors.push(`${label}: this player is already on another row of this sheet.`);
      continue;
    }
    seen.add(playerId);
    const rowErrors = [];
    const formBody = { evidence: get('notes') };
    for (const c of form.categories) {
      const raw = get(`s${c.id}`);
      const grade = raw === '' ? null : L.gradeForPoints(raw);
      if (raw !== '' && !grade) rowErrors.push(`${c.name}: "${raw}" isn't a scale value (0, 1, 1.5, 2, 3–15).`);
      formBody[`score_${c.id}`] = grade ? grade.key : '';
    }
    const parsed = R.parseRatingForm(formBody, form.categories);
    // Don't repeat "choose a level" for a cell already reported as unreadable.
    const said = new Set(rowErrors.map((e) => e.split(':')[0].split(' "')[0]));
    const all = [...rowErrors, ...parsed.errors.filter((e) => !said.has(e.split(':')[0]))];
    if (all.length) {
      errors.push(`${label}: ${[...new Set(all)].join(' ')}`);
      continue;
    }
    rows.push({ index: i, playerId, data: parsed.data, scores: parsed.scores });
  }
  return { rows, errors };
}

module.exports = { ROWS_PER_PAGE, MAX_SCAN_BYTES, sniffScan, createForm, loadForm, parseGrid };
