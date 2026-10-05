'use strict';

// SportsEngine integration.
//
// SportsEngine exposes a GraphQL API to organizations with developer access. Field names vary
// by schema version and access level, so instead of hard-coding queries we introspect the schema
// and build queries from the fields that actually exist:
//   - seasons:  a top-level "seasons"-like query, if the API has one
//   - teams:    "teams", filtered to a season by argument, by a season field on Team, or via divisions
//   - rosters:  "team(id)" per selected team if available, otherwise "teams" with roster fields
// Normalizers then walk whatever comes back and collect season / team / person-like nodes.
// SPORTSENGINE_ROSTER_QUERY still overrides the generated roster query if set.
const config = require('../config');

const PER_PAGE = 100;
const MAX_PAGES = 50;
const SCHEMA_TTL_MS = 10 * 60 * 1000;

// Object fields worth following when building selection sets, per purpose.
const WRAPPERS = 'results|nodes|edges|node|items|data';
const RELEVANCE = {
  roster: new RegExp(`${WRAPPERS}|roster|player|member|athlete|person|persona|profile|user|division|contact|jersey|position`, 'i'),
  teams: new RegExp(`${WRAPPERS}|division|season|program|league`, 'i'),
  plain: new RegExp(WRAPPERS, 'i'),
};
// Object fields never followed (avoid huge or irrelevant graphs).
const SKIP_FIELD = /^(organization|org|parent|children|games|events|schedule|standings|staff|coaches|invoices|payments|registrations?)$/i;
const SKIP_FOR_TEAMS = /roster|player|member|athlete|person|persona|user/i;

const ARG = {
  organization: /^(organizationId|organization_id|orgId|org_id)$/,
  season: /^(seasonId|season_id|seasonIds|season_ids)$/,
  page: /^(page|pageNumber|page_number)$/,
  perPage: /^(perPage|per_page|pageSize|page_size|limit|first)$/,
  id: /^(id|teamId|team_id)$/,
};

function isConfigured() {
  const se = config.sportsEngine;
  return Boolean(se.clientId && se.clientSecret && se.organizationId);
}

// ---------- Transport ----------

let cache = { token: null, tokenExpires: 0, schema: null, schemaAt: 0 };

function resetCache() {
  cache = { token: null, tokenExpires: 0, schema: null, schemaAt: 0 };
}

async function getAccessToken() {
  if (cache.token && Date.now() < cache.tokenExpires) return cache.token;
  const se = config.sportsEngine;
  const res = await fetch(se.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: se.clientId, client_secret: se.clientSecret }),
  });
  if (!res.ok) throw new Error(`SportsEngine auth failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('SportsEngine auth response did not include an access_token');
  cache.token = json.access_token;
  cache.tokenExpires = Date.now() + Math.max(60, (Number(json.expires_in) || 3600) - 60) * 1000;
  return cache.token;
}

// Runs a GraphQL request. Returns { data, errors } (GraphQL validation errors come back as HTTP 400 with JSON).
async function gql(query, variables) {
  const token = await getAccessToken();
  const res = await fetch(config.sportsEngine.graphqlUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`SportsEngine API error (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok && !json.errors) throw new Error(`SportsEngine API error (${res.status}): ${text.slice(0, 300)}`);
  return { data: json.data || null, errors: json.errors || [] };
}

function errorText(errors) {
  return errors.map((e) => e.message).join('; ').slice(0, 1000);
}

async function gqlOrThrow(query) {
  const { data, errors } = await gql(query);
  if (!data) throw new Error(`SportsEngine API error: ${errorText(errors) || 'no data returned'}`);
  return { data, warnings: errors.length ? errorText(errors) : null };
}

// ---------- Schema ----------

const TYPE_REF = 'kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }';
const INTROSPECTION_QUERY = `query GurhaIntrospection {
  __schema {
    queryType { name }
    types {
      kind name
      fields { name args { name defaultValue type { ${TYPE_REF} } } type { ${TYPE_REF} } }
    }
  }
}`;

async function getSchema() {
  if (cache.schema && Date.now() - cache.schemaAt < SCHEMA_TTL_MS) return cache.schema;
  const { data, errors } = await gql(INTROSPECTION_QUERY);
  if (!data || !data.__schema) {
    throw new Error(
      `Could not read the SportsEngine schema (introspection${errors.length ? `: ${errorText(errors)}` : ' returned no data'}). ` +
        'Set SPORTSENGINE_ROSTER_QUERY to a query from your SportsEngine API docs.'
    );
  }
  const types = new Map(data.__schema.types.map((t) => [t.name, t]));
  cache.schema = { types, query: types.get(data.__schema.queryType.name) };
  cache.schemaAt = Date.now();
  return cache.schema;
}

function unwrap(typeRef) {
  let t = typeRef;
  let list = false;
  while (t && (t.kind === 'NON_NULL' || t.kind === 'LIST')) {
    if (t.kind === 'LIST') list = true;
    t = t.ofType;
  }
  return { kind: t && t.kind, name: t && t.name, list };
}

const isRequired = (arg) => arg.type.kind === 'NON_NULL' && (arg.defaultValue === null || arg.defaultValue === undefined);

function buildSelection(types, typeName, depth, { relevance = RELEVANCE.roster, skip = null, seen = [] } = {}) {
  const type = types.get(typeName);
  if (!type || !type.fields) return '';
  const parts = ['__typename'];
  for (const f of type.fields) {
    if (f.name.startsWith('__') || f.args.some(isRequired)) continue;
    const u = unwrap(f.type);
    if (u.kind === 'SCALAR' || u.kind === 'ENUM') {
      parts.push(f.name);
    } else if (
      (u.kind === 'OBJECT' || u.kind === 'INTERFACE') &&
      depth > 0 &&
      relevance.test(f.name) &&
      !SKIP_FIELD.test(f.name) &&
      !(skip && skip.test(f.name)) &&
      !seen.includes(u.name)
    ) {
      const sub = buildSelection(types, u.name, depth - 1, { relevance, skip, seen: [...seen, u.name] });
      if (sub) parts.push(`${f.name} { ${sub} }`);
    }
  }
  return parts.join(' ');
}

function literal(value, typeRef) {
  const u = unwrap(typeRef);
  const one = (v) => (u.name === 'Int' || u.name === 'Float' ? String(Number(v)) : JSON.stringify(String(v)));
  return u.list ? `[${one(value)}]` : one(value);
}

// Builds the argument list for a query field. Returns null if a required argument can't be filled.
function buildArgs(field, { page = 1, seasonId = null, id = null } = {}) {
  const args = [];
  let paged = false;
  let usedSeason = false;
  for (const a of field.args) {
    let value = null;
    if (ARG.organization.test(a.name)) value = config.sportsEngine.organizationId;
    else if (ARG.season.test(a.name)) {
      value = seasonId;
      usedSeason = Boolean(seasonId);
    } else if (ARG.page.test(a.name)) {
      value = page;
      paged = true;
    } else if (ARG.perPage.test(a.name)) value = PER_PAGE;
    else if (id !== null && ARG.id.test(a.name)) value = id;
    if (value !== null && value !== undefined && value !== '') args.push(`${a.name}: ${literal(value, a.type)}`);
    else if (isRequired(a)) return null;
  }
  return { text: args.length ? `(${args.join(', ')})` : '', paged, usedSeason };
}

function findQuery(schema, names) {
  for (const n of names) {
    const f = schema.query.fields.find((x) => (n instanceof RegExp ? n.test(x.name) : x.name === n));
    if (f && buildArgs(f, { seasonId: 'x', id: 'x' })) return f;
  }
  return null;
}

const supportsArg = (field, re) => field.args.some((a) => re.test(a.name));

// Runs a (possibly paged) list query, returning every page's data until a page adds nothing new.
async function fetchAllPages(field, selection, opts, itemsOf, log) {
  const pages = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const args = buildArgs(field, { ...opts, page });
    if (!args) throw new Error(`SportsEngine "${field.name}" needs arguments this app can't fill: ${field.args.filter(isRequired).map((a) => a.name).join(', ')}`);
    const query = `query { ${field.name}${args.text} { ${selection} } }`;
    if (log && page === 1) log.query = query;
    const { data, warnings } = await gqlOrThrow(query);
    if (log && warnings) log.warnings = warnings;
    if (log && page === 1) log.sample = data;
    const items = itemsOf(data);
    const fresh = items.filter((i) => {
      const key = i.id !== undefined ? String(i.id) : JSON.stringify(i);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    pages.push(data);
    if (log) log.pages = page;
    if (!args.paged || fresh.length === 0) break;
  }
  return pages;
}

// ---------- Generic node collection ----------

const first = (o, keys) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return null;
};

function collect(node, predicate, out = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => collect(n, predicate, out));
  } else if (node && typeof node === 'object') {
    if (predicate(node)) out.push(node);
    Object.values(node).forEach((v) => collect(v, predicate, out));
  }
  return out;
}

const isWrapperType = (t) => /page|connection|edge|result|list|pagination/i.test(t || '');
const isTeamNode = (n) => n.id !== undefined && n.name && (n.__typename ? /team/i.test(n.__typename) && !isWrapperType(n.__typename) : true);
const seasonIdOf = (n) => {
  const k = Object.keys(n).find((key) => /^season_?id$/i.test(key));
  if (k && n[k] !== null && n[k] !== undefined) return String(n[k]);
  return n.season && n.season.id !== undefined ? String(n.season.id) : null;
};
const DATE_KEYS = {
  start: ['startDate', 'start_date', 'startsAt', 'starts_at', 'startOn', 'start'],
  end: ['endDate', 'end_date', 'endsAt', 'ends_at', 'endOn', 'end'],
};

// ---------- Seasons ----------

async function listSeasons(log = {}) {
  const schema = await getSchema();
  const field = findQuery(schema, ['seasons', /seasons$/i]);
  log.seasonsQuery = field ? field.name : null;
  if (!field) return { supported: false, seasons: [] };
  const selection = buildSelection(schema.types, unwrap(field.type).name, 3, { relevance: RELEVANCE.plain });
  const isSeason = (n) => n.id !== undefined && (n.name || n.title) && !isWrapperType(n.__typename);
  const pages = await fetchAllPages(field, selection, {}, (d) => collect(d, isSeason), log);
  const byId = new Map();
  for (const n of pages.flatMap((d) => collect(d, isSeason))) {
    byId.set(String(n.id), {
      id: String(n.id),
      name: String(n.name || n.title),
      start_date: first(n, DATE_KEYS.start),
      end_date: first(n, DATE_KEYS.end),
    });
  }
  const seasons = [...byId.values()].sort((a, b) => String(b.start_date || '').localeCompare(String(a.start_date || '')) || b.id.localeCompare(a.id));
  return { supported: true, seasons };
}

// ---------- Divisions (names, and season filtering when teams can't be filtered directly) ----------

async function listDivisions(seasonId) {
  const schema = await getSchema();
  const field = findQuery(schema, ['divisions', /divisions$/i]);
  if (!field) return { names: new Map(), seasonDivisionIds: null };
  const selection = buildSelection(schema.types, unwrap(field.type).name, 3, { relevance: RELEVANCE.teams, skip: SKIP_FOR_TEAMS });
  try {
    const bySeasonArg = Boolean(seasonId) && supportsArg(field, ARG.season);
    const pages = await fetchAllPages(field, selection, { seasonId: bySeasonArg ? seasonId : null }, (d) => collect(d, (n) => n.id !== undefined && n.name));
    const divisions = pages.flatMap((d) => collect(d, (n) => n.id !== undefined && n.name && !isWrapperType(n.__typename) && !/season/i.test(n.__typename || '')));
    const names = new Map(divisions.map((d) => [String(d.id), d.name]));
    let seasonDivisionIds = null;
    if (seasonId && bySeasonArg) seasonDivisionIds = new Set(divisions.map((d) => String(d.id)));
    else if (seasonId && divisions.some((d) => seasonIdOf(d) !== null)) {
      seasonDivisionIds = new Set(divisions.filter((d) => seasonIdOf(d) === String(seasonId)).map((d) => String(d.id)));
    }
    return { names, seasonDivisionIds };
  } catch {
    return { names: new Map(), seasonDivisionIds: null };
  }
}

function divisionOf(team, divisionNames) {
  const div = team.division || team.league;
  if (div) return typeof div === 'string' ? div : div.name || null;
  if (team.divisionName) return team.divisionName;
  const id = first(team, ['divisionId', 'division_id']);
  return id !== null ? divisionNames.get(String(id)) || null : null;
}

// ---------- Teams ----------

// Lists teams, filtered to an SE season when possible. `filter` says how the season filter was applied.
async function listTeams(seasonId = null, log = {}) {
  const schema = await getSchema();
  const field = findQuery(schema, ['teams', /teams$/i]);
  if (!field) throw new Error(`The SportsEngine API has no "teams" query. Available queries: ${schema.query.fields.map((f) => f.name).join(', ')}`);
  const selection = buildSelection(schema.types, unwrap(field.type).name, 4, { relevance: RELEVANCE.teams, skip: SKIP_FOR_TEAMS });
  const byArg = Boolean(seasonId) && supportsArg(field, ARG.season);
  const pages = await fetchAllPages(field, selection, { seasonId: byArg ? seasonId : null }, (d) => collect(d, isTeamNode), log);
  let teams = pages.flatMap((d) => collect(d, isTeamNode));
  const { names, seasonDivisionIds } = await listDivisions(seasonId);

  let filter = 'none';
  if (seasonId) {
    if (byArg) filter = 'argument';
    else if (teams.some((t) => seasonIdOf(t) !== null)) {
      teams = teams.filter((t) => seasonIdOf(t) === String(seasonId));
      filter = 'team season';
    } else if (seasonDivisionIds) {
      teams = teams.filter((t) => seasonDivisionIds.has(String(first(t, ['divisionId', 'division_id']) ?? (t.division && t.division.id))));
      filter = 'division';
    }
  }
  const byId = new Map();
  for (const t of teams) byId.set(String(t.id), { id: String(t.id), name: String(t.name), division: divisionOf(t, names) });
  log.teamsFilter = filter;
  return { teams: [...byId.values()].sort((a, b) => (a.division || '').localeCompare(b.division || '') || a.name.localeCompare(b.name)), filter };
}

// ---------- Rosters ----------

const FIRST_KEYS = ['firstName', 'first_name', 'givenName', 'given_name', 'preferredFirstName'];
const LAST_KEYS = ['lastName', 'last_name', 'familyName', 'family_name', 'surname'];
const JERSEY_KEYS = ['jerseyNumber', 'jersey_number', 'jersey', 'number', 'uniformNumber'];
const POSITION_KEYS = ['position', 'positionName', 'position_name', 'primaryPosition'];
const EMAIL_KEYS = ['email', 'emailAddress', 'email_address'];
const isPerson = (o) => o && typeof o === 'object' && !Array.isArray(o) && first(o, FIRST_KEYS) && first(o, LAST_KEYS);
const positionText = (p) => (p && typeof p === 'object' ? p.name || p.abbreviation || null : p);

// Recursively collects player records, carrying team/division context down from parent nodes.
function extractPlayers(node, ctx = {}, out = [], divisionNames = new Map()) {
  if (Array.isArray(node)) {
    for (const item of node) extractPlayers(item, ctx, out, divisionNames);
    return out;
  }
  if (!node || typeof node !== 'object') return out;

  // A roster entry may hold the person in a nested object (e.g. { jerseyNumber, persona: { firstName } }).
  const personChild = isPerson(node) ? null : Object.values(node).find(isPerson);
  const person = isPerson(node) ? node : personChild;
  if (person) {
    const id = person.id ?? node.id;
    out.push({
      first_name: String(first(person, FIRST_KEYS)),
      last_name: String(first(person, LAST_KEYS)),
      jersey_number: first(node, JERSEY_KEYS) ?? first(person, JERSEY_KEYS),
      position: positionText(first(node, POSITION_KEYS) ?? first(person, POSITION_KEYS)),
      email: first(person, EMAIL_KEYS) ?? first(node, EMAIL_KEYS),
      external_id: id !== undefined && id !== null ? `se:${id}` : null,
      team: ctx.team || null,
      team_external_id: ctx.teamId ? `se:${ctx.teamId}` : null,
      division: ctx.division || null,
    });
    return out;
  }

  const next = { ...ctx };
  const looksLikeTeam = node.__typename
    ? isTeamNode(node)
    : node.name && (node.roster || node.players || node.members || node.rosterPlayers);
  if (looksLikeTeam) {
    next.team = node.name;
    next.teamId = node.id !== undefined ? String(node.id) : null;
    next.division = divisionOf(node, divisionNames) || next.division;
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') extractPlayers(v, next, out, divisionNames);
  }
  return out;
}

function dedupe(players) {
  const seen = new Set();
  return players.filter((p) => {
    const key = p.external_id ? `${p.external_id}|${p.team_external_id || p.team}` : `${p.first_name}|${p.last_name}|${p.team}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Fetches players. teamIds limits to those SE teams; seasonId narrows the teams query when supported.
async function fetchRoster({ teamIds = null, seasonId = null, diagnostics = null } = {}) {
  if (!isConfigured()) {
    throw new Error('SportsEngine is not configured. Set SPORTSENGINE_CLIENT_ID, SPORTSENGINE_CLIENT_SECRET and SPORTSENGINE_ORG_ID.');
  }
  const log = diagnostics || {};
  const wanted = teamIds && teamIds.length ? new Set(teamIds.map(String)) : null;
  const keep = (players) => dedupe(wanted ? players.filter((p) => p.team_external_id && wanted.has(p.team_external_id.slice(3))) : players);

  if (config.sportsEngine.rosterQuery) {
    await getAccessToken();
    log.auth = 'ok';
    log.queryMode = 'custom (SPORTSENGINE_ROSTER_QUERY)';
    log.query = config.sportsEngine.rosterQuery;
    const { data, errors } = await gql(config.sportsEngine.rosterQuery, {
      organizationId: config.sportsEngine.organizationId,
      seasonId: seasonId || config.sportsEngine.seasonId || null,
    });
    log.sample = data;
    if (!data) throw new Error(`SportsEngine API error: ${errorText(errors)}`);
    return keep(extractPlayers(data));
  }

  const schema = await getSchema();
  log.auth = 'ok';
  log.queryMode = 'generated from schema';
  log.queries = schema.query.fields.map((f) => f.name);
  const { names } = await listDivisions(seasonId);
  log.divisionsFound = names.size;

  // Preferred: query each selected team directly.
  const teamField = wanted ? schema.query.fields.find((f) => f.name === 'team' && f.args.some((a) => ARG.id.test(a.name))) : null;
  if (teamField) {
    log.queryMode += ' (per team)';
    const selection = buildSelection(schema.types, unwrap(teamField.type).name, 6, { relevance: RELEVANCE.roster });
    const players = [];
    for (const id of wanted) {
      const args = buildArgs(teamField, { id, seasonId });
      if (!args) throw new Error(`SportsEngine "team" query needs arguments this app can't fill.`);
      const query = `query { team${args.text} { ${selection} } }`;
      if (!log.query) log.query = query;
      const { data, warnings } = await gqlOrThrow(query);
      if (!log.sample) log.sample = data;
      if (warnings) log.warnings = warnings;
      players.push(...extractPlayers(data, {}, [], names));
    }
    return keep(players);
  }

  const field = findQuery(schema, ['teams', /teams$/i]);
  if (!field) throw new Error(`The SportsEngine API has no "teams" query. Available queries: ${log.queries.join(', ')}`);
  log.teamsArgs = field.args.map((a) => a.name);
  const selection = buildSelection(schema.types, unwrap(field.type).name, 6, { relevance: RELEVANCE.roster });
  const opts = { seasonId: supportsArg(field, ARG.season) ? seasonId : null };
  const pages = await fetchAllPages(field, selection, opts, (d) => collect(d, isTeamNode), log);
  return keep(pages.flatMap((d) => extractPlayers(d, {}, [], names)));
}

module.exports = {
  isConfigured,
  listSeasons,
  listTeams,
  fetchRoster,
  extractPlayers,
  buildSelection,
  resetCache,
  INTROSPECTION_QUERY,
};
