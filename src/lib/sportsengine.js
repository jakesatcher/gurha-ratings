'use strict';

// SportsEngine roster sync.
//
// SportsEngine exposes a GraphQL API to organizations with developer access. Rather than
// hard-coding a query (field names vary by schema version/access level), we introspect the
// schema and build the roster query from the fields that actually exist:
//   teams(<args we can satisfy>) { ...every scalar field, recursing into roster/player/person-like fields }
// The response normalizer then walks whatever comes back and collects person-like nodes.
// SPORTSENGINE_ROSTER_QUERY still overrides the generated query if set.
const config = require('../config');

const PER_PAGE = 100;
const MAX_PAGES = 50;
const MAX_DEPTH = 6;
// Object fields worth following when building the selection set.
const RELEVANT_FIELD = /roster|player|member|athlete|person|persona|profile|user|results|nodes|edges|node|items|division|contact|jersey|position/i;
// Object fields never followed (avoid huge or irrelevant graphs).
const SKIP_FIELD = /^(organization|org|parent|children|games|events|schedule|standings|staff|coaches|invoices|payments|registrations?)$/i;

const ARG_VALUES = {
  organization: /^(organizationId|organization_id|orgId|org_id)$/,
  season: /^(seasonId|season_id)$/,
  page: /^(page|pageNumber|page_number)$/,
  perPage: /^(perPage|per_page|pageSize|page_size|limit|first)$/,
};

function isConfigured() {
  const se = config.sportsEngine;
  return Boolean(se.clientId && se.clientSecret && se.organizationId);
}

async function getAccessToken() {
  const se = config.sportsEngine;
  const res = await fetch(se.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: se.clientId, client_secret: se.clientSecret }),
  });
  if (!res.ok) throw new Error(`SportsEngine auth failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('SportsEngine auth response did not include an access_token');
  return json.access_token;
}

// Runs a GraphQL request. Returns { data, errors } (GraphQL validation errors come back as HTTP 400 with JSON).
async function gql(token, query, variables) {
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

// ---------- Schema introspection ----------

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

async function introspect(token) {
  const { data, errors } = await gql(token, INTROSPECTION_QUERY);
  if (!data || !data.__schema) {
    throw new Error(
      `Could not read the SportsEngine schema (introspection${errors.length ? `: ${errorText(errors)}` : ' returned no data'}). ` +
        'Set SPORTSENGINE_ROSTER_QUERY to a query from your SportsEngine API docs.'
    );
  }
  const types = new Map(data.__schema.types.map((t) => [t.name, t]));
  return { types, queryTypeName: data.__schema.queryType.name };
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

function buildSelection(types, typeName, depth, seen) {
  const type = types.get(typeName);
  if (!type || !type.fields) return '';
  const parts = ['__typename'];
  for (const f of type.fields) {
    if (f.name.startsWith('__')) continue;
    if (f.args.some(isRequired)) continue;
    const u = unwrap(f.type);
    if (u.kind === 'SCALAR' || u.kind === 'ENUM') {
      parts.push(f.name);
    } else if ((u.kind === 'OBJECT' || u.kind === 'INTERFACE') && depth > 0 && RELEVANT_FIELD.test(f.name) && !SKIP_FIELD.test(f.name) && !seen.includes(u.name)) {
      const sub = buildSelection(types, u.name, depth - 1, [...seen, u.name]);
      if (sub) parts.push(`${f.name} { ${sub} }`);
    }
  }
  return parts.join(' ');
}

function literal(value, typeRef) {
  const u = unwrap(typeRef);
  if (u.name === 'Int' || u.name === 'Float') return String(Number(value));
  return JSON.stringify(String(value));
}

// Builds the teams query for one page from the introspected schema.
function buildTeamsQuery(schema, page = 1) {
  const se = config.sportsEngine;
  const queryType = schema.types.get(schema.queryTypeName);
  const teamsField =
    queryType.fields.find((f) => f.name === 'teams') ||
    queryType.fields.find((f) => /teams$/i.test(f.name) && !f.args.some((a) => isRequired(a) && !Object.values(ARG_VALUES).some((re) => re.test(a.name))));
  if (!teamsField) {
    throw new Error(`The SportsEngine schema has no "teams" query. Available queries: ${queryType.fields.map((f) => f.name).join(', ')}`);
  }

  const args = [];
  const missing = [];
  let paged = false;
  for (const a of teamsField.args) {
    let value = null;
    if (ARG_VALUES.organization.test(a.name)) value = se.organizationId;
    else if (ARG_VALUES.season.test(a.name)) value = se.seasonId || null;
    else if (ARG_VALUES.page.test(a.name)) {
      value = page;
      paged = true;
    } else if (ARG_VALUES.perPage.test(a.name)) value = PER_PAGE;
    if (value !== null && value !== undefined && value !== '') args.push(`${a.name}: ${literal(value, a.type)}`);
    else if (isRequired(a)) missing.push(a.name);
  }
  if (missing.length) {
    throw new Error(`SportsEngine "${teamsField.name}" query requires arguments this app can't fill: ${missing.join(', ')}`);
  }

  const returnType = unwrap(teamsField.type);
  const selection = buildSelection(schema.types, returnType.name, MAX_DEPTH, [returnType.name]);
  const query = `query GurhaRoster {\n  ${teamsField.name}${args.length ? `(${args.join(', ')})` : ''} { ${selection} }\n}`;
  return { query, field: teamsField.name, args: teamsField.args.map((a) => a.name), paged };
}

// Optional: map divisionId -> division name using a top-level "divisions" query if one exists.
async function fetchDivisionNames(token, schema) {
  const queryType = schema.types.get(schema.queryTypeName);
  const field = queryType.fields.find((f) => f.name === 'divisions');
  if (!field) return new Map();
  const args = [];
  for (const a of field.args) {
    if (ARG_VALUES.organization.test(a.name)) args.push(`${a.name}: ${literal(config.sportsEngine.organizationId, a.type)}`);
    else if (ARG_VALUES.perPage.test(a.name)) args.push(`${a.name}: ${literal(PER_PAGE * 5, a.type)}`);
    else if (isRequired(a)) return new Map();
  }
  const selection = buildSelection(schema.types, unwrap(field.type).name, 2, []);
  try {
    const { data } = await gql(token, `query { divisions${args.length ? `(${args.join(', ')})` : ''} { ${selection} } }`);
    const map = new Map();
    (function walk(n) {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      if (n.id !== undefined && n.name) map.set(String(n.id), n.name);
      Object.values(n).forEach(walk);
    })(data);
    return map;
  } catch {
    return new Map();
  }
}

// ---------- Response normalization ----------

const first = (o, keys) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return null;
};
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
    const id = node.id ?? person.id;
    out.push({
      first_name: String(first(person, FIRST_KEYS)),
      last_name: String(first(person, LAST_KEYS)),
      jersey_number: first(node, JERSEY_KEYS) ?? first(person, JERSEY_KEYS),
      position: positionText(first(node, POSITION_KEYS) ?? first(person, POSITION_KEYS)),
      email: first(person, EMAIL_KEYS) ?? first(node, EMAIL_KEYS),
      external_id: id !== undefined && id !== null ? `se:${person.id ?? id}` : null,
      team: ctx.team || null,
      division: ctx.division || null,
    });
    return out;
  }

  const next = { ...ctx };
  const looksLikeTeam = node.__typename ? /team/i.test(node.__typename) && node.name : node.name && (node.roster || node.players || node.members || node.rosterPlayers);
  if (looksLikeTeam) {
    next.team = node.name;
    const div = node.division || node.league || node.program;
    if (div) next.division = typeof div === 'string' ? div : div.name || next.division;
    else if (node.divisionName) next.division = node.divisionName;
    else if (node.divisionId !== undefined && node.divisionId !== null) next.division = divisionNames.get(String(node.divisionId)) || next.division;
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') extractPlayers(v, next, out, divisionNames);
  }
  return out;
}

// ---------- Public API ----------

async function fetchRoster({ diagnostics = null } = {}) {
  if (!isConfigured()) {
    throw new Error('SportsEngine is not configured. Set SPORTSENGINE_CLIENT_ID, SPORTSENGINE_CLIENT_SECRET and SPORTSENGINE_ORG_ID.');
  }
  const log = diagnostics || {};
  const token = await getAccessToken();
  log.auth = 'ok';

  if (config.sportsEngine.rosterQuery) {
    log.queryMode = 'custom (SPORTSENGINE_ROSTER_QUERY)';
    log.query = config.sportsEngine.rosterQuery;
    const { data, errors } = await gql(token, config.sportsEngine.rosterQuery, {
      organizationId: config.sportsEngine.organizationId,
      seasonId: config.sportsEngine.seasonId || null,
    });
    log.sample = data;
    if (errors.length && !data) throw new Error(`SportsEngine API error: ${errorText(errors)}`);
    return dedupe(extractPlayers(data));
  }

  const schema = await introspect(token);
  log.queryMode = 'generated from schema';
  const queryType = schema.types.get(schema.queryTypeName);
  log.queries = queryType.fields.map((f) => f.name);
  const divisionNames = await fetchDivisionNames(token, schema);
  log.divisionsFound = divisionNames.size;

  const players = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const built = buildTeamsQuery(schema, page);
    if (page === 1) {
      log.teamsArgs = built.args;
      log.query = built.query;
    }
    const { data, errors } = await gql(token, built.query);
    if (page === 1) log.sample = data;
    if (errors.length && !data) throw new Error(`SportsEngine API error: ${errorText(errors)}`);
    if (errors.length) log.warnings = errorText(errors);
    const batch = extractPlayers(data, {}, [], divisionNames);
    const fresh = batch.filter((p) => {
      const key = p.external_id || `${p.first_name}|${p.last_name}|${p.team}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    players.push(...fresh);
    log.pages = page;
    if (!built.paged || fresh.length === 0) break;
  }
  return players;
}

function dedupe(players) {
  const seen = new Set();
  return players.filter((p) => {
    const key = p.external_id ? `${p.external_id}|${p.team}` : `${p.first_name}|${p.last_name}|${p.team}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { isConfigured, fetchRoster, extractPlayers, buildTeamsQuery, buildSelection, introspect, INTROSPECTION_QUERY };
