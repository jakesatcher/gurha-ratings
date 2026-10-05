'use strict';

// Parses a SportsEngine roster export (.xls): one worksheet per team, laid out as
//
//   League    | GURHA UPSTATE RECREATIONAL HOCKEY 2026
//   Division  | C1B2 DIVISION
//   Season    | GURHA SPRING/FALL 2026 | FALL SEASON 2026
//   Team      | 1 ACE LANDSCAPING      | 10535551        (team name, SportsEngine team ID)
//   (blank)
//   SportNgin ID | Jersey # | First Name | Last Name | Position | Date of Birth | Gender | Height | ...
//   79249095     | 17       | Yuriy      | ...
//
// Labels and columns are located by name, not position, so reordered or extra columns are fine.
const { readWorkbook, excelSerialToISO } = require('./xls');
const { normalizePosition, parseDate } = require('./players');

const META_LABELS = ['league', 'division', 'season', 'team'];
const COLUMNS = {
  external_id: ['sportngin id', 'sportsengine id', 'sport ngin id', 'se id', 'member id', 'id'],
  jersey_number: ['jersey #', 'jersey', 'jersey number', 'number', '#', 'no.'],
  first_name: ['first name', 'first', 'firstname'],
  last_name: ['last name', 'last', 'lastname'],
  position: ['position', 'pos'],
  birth_date: ['date of birth', 'dob', 'birth date', 'birthdate'],
};

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const norm = (v) => text(v).toLowerCase().replace(/\s+/g, ' ');

// Numbers from Excel (IDs, jerseys) arrive as floats: 79249095 → "79249095", 17 → "17".
function idText(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return text(v);
}

function parseBirthDate(v) {
  if (typeof v === 'number' && v > 0 && v < 100000) return excelSerialToISO(v);
  return parseDate(text(v));
}

function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const cells = (rows[r] || []).map(norm);
    if (cells.includes('first name') && cells.includes('last name')) return r;
  }
  return -1;
}

function columnMap(headerRow) {
  const cells = headerRow.map(norm);
  const map = {};
  for (const [field, names] of Object.entries(COLUMNS)) {
    const idx = cells.findIndex((c) => names.includes(c));
    if (idx !== -1) map[field] = idx;
  }
  return map;
}

function parseSheet(sheet) {
  const rows = sheet.rows;
  const headerRow = findHeader(rows);
  if (headerRow === -1) return { sheet: sheet.name, error: 'No "First Name" / "Last Name" header row found' };

  const meta = {};
  for (let r = 0; r < headerRow; r++) {
    const row = rows[r] || [];
    const label = norm(row[0]);
    if (META_LABELS.includes(label)) meta[label] = row.slice(1).map((v) => (typeof v === 'number' ? v : text(v))).filter((v) => v !== '');
  }
  const cols = columnMap(rows[headerRow]);
  const teamName = text((meta.team || [])[0]) || sheet.name;
  const teamId = (meta.team || []).find((v, i) => i > 0 && /^\d+$/.test(idText(v)));

  const players = [];
  const problems = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    if (!row.some((v) => text(v) !== '')) continue;
    const get = (f) => (cols[f] === undefined ? null : row[cols[f]]);
    const first = text(get('first_name'));
    const last = text(get('last_name'));
    if (!first || !last) {
      problems.push(`Row ${r + 1}: missing first or last name`);
      continue;
    }
    const rawPos = text(get('position'));
    const dobRaw = get('birth_date');
    const birth = parseBirthDate(dobRaw);
    if (text(dobRaw) && !birth) problems.push(`Row ${r + 1} (${first} ${last}): unrecognised date of birth "${text(dobRaw)}"`);
    const id = idText(get('external_id'));
    players.push({
      external_id: id ? `se:${id}` : null,
      jersey_number: idText(get('jersey_number')).replace(/^#/, '') || null,
      first_name: first,
      last_name: last,
      position: normalizePosition(rawPos),
      birth_date: birth,
      row: r + 1,
    });
    if (rawPos && !normalizePosition(rawPos)) problems.push(`Row ${r + 1} (${first} ${last}): unknown position "${rawPos}"`);
  }

  return {
    sheet: sheet.name,
    league: text((meta.league || [])[0]) || null,
    // "C1B2 DIVISION" → "C1B2"
    division: text((meta.division || [])[0]).replace(/\s+division$/i, '') || null,
    season: (meta.season || []).map(text).filter(Boolean),
    team: teamName,
    team_external_id: teamId !== undefined ? `se:${idText(teamId)}` : null,
    players,
    problems,
    missingColumns: ['external_id', 'jersey_number', 'position', 'birth_date'].filter((f) => cols[f] === undefined),
  };
}

// Returns { league, seasonParts, suggestedSeasonName, teams[], errors[] }.
function parseSportsEngineExport(buffer) {
  const sheets = readWorkbook(buffer);
  const teams = [];
  const errors = [];
  for (const s of sheets) {
    if (!s.rows.length) continue;
    const t = parseSheet(s);
    if (t.error) errors.push(`Sheet "${s.name}": ${t.error}`);
    else teams.push(t);
  }
  if (!teams.length) throw new Error(errors[0] || 'No team sheets were found in this workbook.');

  // A player listed on two teams keeps one roster entry per season; note it for the admin.
  const seen = new Map();
  for (const t of teams) {
    const names = new Map();
    for (const p of t.players) {
      const name = `${p.first_name} ${p.last_name}`.toLowerCase();
      if (names.has(name) && names.get(name) !== p.external_id) {
        t.problems.push(`Two players named ${p.first_name} ${p.last_name} (different SportsEngine IDs); they'll be imported as separate players`);
      }
      names.set(name, p.external_id);
    }
    for (const p of t.players) {
      const key = p.external_id || `${p.first_name.toLowerCase()}|${p.last_name.toLowerCase()}`;
      if (seen.has(key)) t.problems.push(`${p.first_name} ${p.last_name} is also on ${seen.get(key)}; the last team imported becomes their team this season`);
      else seen.set(key, t.team);
    }
  }

  const seasonParts = teams.find((t) => t.season.length)?.season || [];
  return {
    league: teams.find((t) => t.league)?.league || null,
    seasonParts,
    // "FALL SEASON 2026" is more specific than "GURHA SPRING/FALL 2026"; prefer the last part.
    suggestedSeasonName: seasonParts.length ? seasonParts[seasonParts.length - 1] : '',
    teams,
    errors,
  };
}

module.exports = { parseSportsEngineExport, parseBirthDate };
