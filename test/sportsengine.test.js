'use strict';

// Exercises the SportsEngine integration against a local GraphQL server shaped like the real API:
//   teams(organizationId, page, perPage) { results { id name divisionId players { … profile { … } } } }
// with large nested lists we must not request, no season argument on teams (seasons go via
// divisions), no team(id) query, and the same complexity limit and error message as SportsEngine:
// complexity = 1 + perPage × (nested objects), maximum 101.
const h = require('./helpers'); // sets the test DATABASE_URL before config loads
const config = require('../src/config');
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { buildSchema, graphql, parse } = require('graphql');

const schema = buildSchema(`
  type Query {
    seasons(organizationId: ID!, page: Int, perPage: Int): SeasonPage
    teams(organizationId: Int!, page: Int, perPage: Int): TeamPage
    divisions(organizationId: ID!, seasonId: ID, page: Int, perPage: Int): DivisionPage
    organization(id: ID!): Organization
  }
  type Organization { id: ID name: String }
  type SeasonPage { results: [Season] }
  type Season { id: ID! name: String startDate: String endDate: String status: String }
  type DivisionPage { results: [Division] }
  type Division { id: ID name: String seasonId: ID }
  type TeamPage { results: [Team] }
  type Team { id: ID! name: String abbreviation: String divisionId: ID organizationId: ID gender: String statistics: String players: [Player] }
  type Player { id: ID! firstName: String lastName: String jerseyNumber: String profileId: ID rosterStatus: String photoUrl: String profile: Profile }
  type Profile {
    id: ID! firstName: String lastName: String dateOfBirth: String email: String phone: String sportsEngineId: String
    memberships: [Membership] registrationResults: RegistrationPage verifiedProfile: VerifiedProfile
  }
  type Membership { id: ID name: String status: String }
  type RegistrationPage { results: [Registration] }
  type Registration { id: ID registrationName: String }
  type VerifiedProfile { firstName: String lastName: String dateOfBirth: String }
`);

const DIVISIONS = [
  { id: 'd1', name: 'C2', seasonId: 's25' },
  { id: 'd2', name: 'B1', seasonId: 's25' },
  { id: 'd3', name: 'C2', seasonId: 's24' },
];
// [rosterPlayerId, first, last, jersey, profileId, dateOfBirth]
const TEAMS = [
  { id: 't1', name: 'Blue Liners', divisionId: 'd1', players: [['p1', 'Sam', 'Skater', '12', 'pr1', '1980-02-02'], ['p2', 'Gail', 'Goalie', '30', 'pr2', '1990-03-03']] },
  { id: 't2', name: 'Ice Dogs', divisionId: 'd2', players: [['p3', 'Fran', 'Forward', '9', 'pr3', null], ['p9', 'Sam', 'Skater (Sub)', '44', 'pr1', '1980-02-02']] },
  { id: 't3', name: 'Blue Liners', divisionId: 'd3', players: [['p7', 'Sam', 'Skater', '4', 'pr1', '1980-02-02']] }, // last season, new registration ID
];
const teamValue = (t) => ({
  id: t.id, name: t.name, divisionId: t.divisionId, organizationId: '237023', statistics: '{}',
  players: t.players.map(([id, f, l, j, pr, dob]) => ({
    id, firstName: f, lastName: l, jerseyNumber: j, profileId: pr,
    profile: { id: pr, firstName: f, lastName: l.replace(' (Sub)', ''), dateOfBirth: dob, sportsEngineId: `se-${pr}`, memberships: [], registrationResults: { results: [] } },
  })),
});
const page = (list, p = 1, n = 25) => list.slice((p - 1) * n, p * n);
const root = {
  seasons: ({ page: p, perPage }) => ({ results: page([{ id: 's24', name: '2024-25', startDate: '2024-09-01' }, { id: 's25', name: '2025-26', startDate: '2025-09-01' }], p, perPage) }),
  teams: ({ organizationId, page: p, perPage }) => {
    assert.strictEqual(organizationId, 237023);
    return { results: page(TEAMS, p, perPage).map(teamValue) };
  },
  divisions: ({ seasonId, page: p, perPage }) => ({ results: page(DIVISIONS.filter((d) => !seasonId || d.seasonId === seasonId), p, perPage) }),
};

// SportsEngine-style complexity: 1 + perPage × (number of nested object selections).
function complexity(query) {
  const op = parse(query).definitions[0];
  let worst = 0;
  for (const top of op.selectionSet.selections) {
    if (!top.selectionSet) continue;
    const perPageArg = (top.arguments || []).find((a) => a.name.value === 'perPage');
    const perPage = perPageArg ? Number(perPageArg.value.value) : 25;
    const objects = (query.slice(query.indexOf(top.name.value)).match(/\{/g) || []).length - 1;
    worst = Math.max(worst, 1 + perPage * objects);
  }
  return worst;
}

let server;
const queries = [];
// The schema the mock server answers with; tests for other API shapes swap it out.
const active = { schema, root };

test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      assert.strictEqual(req.headers.authorization, 'Bearer tok');
      const { query, variables } = JSON.parse(body);
      queries.push(query);
      if (!query.includes('__schema')) {
        const c = complexity(query);
        if (c > 101) {
          res.statusCode = 200;
          return res.end(JSON.stringify({ data: null, errors: [{ message: `Query is too complex: ${c}. Maximum allowed complexity: 101` }] }));
        }
      }
      const result = await graphql({ schema: active.schema, source: query, rootValue: active.root, variableValues: variables });
      res.statusCode = result.errors && !result.data ? 400 : 200;
      res.end(JSON.stringify(result));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(config.sportsEngine, {
    clientId: 'id',
    clientSecret: 'secret',
    organizationId: '237023',
    tokenUrl: `${base}/oauth/token`,
    graphqlUrl: `${base}/graphql`,
    rosterQuery: undefined,
  });
});

test.after(async () => {
  server.close();
  await h.db.pool.end();
});

test('lists seasons, newest first, and marks the current one', async () => {
  const se = require('../src/lib/sportsengine');
  const { supported, seasons, currentId } = await se.listSeasons();
  assert.ok(supported);
  assert.deepStrictEqual(seasons.map((s) => s.name), ['2025-26', '2024-25']);
  assert.strictEqual(seasons[0].start_date, '2025-09-01');
  assert.strictEqual(currentId, 's25');
});

test('current season: the one running today, else the latest started, else the newest', () => {
  const { currentSeasonId } = require('../src/lib/sportsengine');
  const list = [
    { id: 'next', start_date: '2026-09-01', end_date: '2027-03-01' },
    { id: 'now', start_date: '2026-03-01', end_date: '2026-08-31' },
    { id: 'old', start_date: '2025-09-01', end_date: '2026-02-28' },
  ];
  assert.strictEqual(currentSeasonId(list, '2026-05-10'), 'now');
  assert.strictEqual(currentSeasonId(list, '2026-08-31'), 'now');
  assert.strictEqual(currentSeasonId(list.slice(1), '2026-12-01'), 'now', 'between seasons: the latest that started');
  assert.strictEqual(currentSeasonId([{ id: 'a' }, { id: 'b' }]), 'a');
});

// Runs fn against a different mock API shape, then restores the default one.
async function withApi(sdl, rootValue, fn) {
  const se = require('../src/lib/sportsengine');
  const saved = { ...active };
  Object.assign(active, { schema: buildSchema(sdl), root: rootValue });
  se.resetCache();
  try {
    await fn(se);
  } finally {
    Object.assign(active, saved);
    se.resetCache();
  }
}

const TEAM_SDL = `
  type TeamPage { results: [Team] }
  type Team { id: ID! name: String divisionId: ID created: String status: String players: [Player] }
  type Player { id: ID! firstName: String lastName: String }`;
const TEAM_ROWS = [
  { id: 'n1', name: 'Pond Hockey', divisionId: 'dA', created: '2026-08-15T00:00:00Z', status: 'active' },
  { id: 'n2', name: 'Biscuits', divisionId: 'dB', created: '2026-08-20T00:00:00Z', status: 'active' },
  { id: 'o1', name: 'Pond Hockey', divisionId: 'dOld', created: '2025-08-10T00:00:00Z', status: 'inactive' },
];
const teamsRoot = { teams: ({ page: p, perPage }) => ({ results: page(TEAM_ROWS, p, perPage).map((t) => ({ ...t, players: [] })) }) };

test('no seasons query: seasons come from divisions, and teams are matched through their division', async () => {
  await withApi(`
    type Query {
      teams(organizationId: Int!, page: Int, perPage: Int): TeamPage
      divisions(organizationId: ID!, page: Int, perPage: Int): DivisionPage
    }
    type DivisionPage { results: [Division] }
    type Division { id: ID name: String season: Season }
    type Season { id: ID name: String startDate: String endDate: String }
  ${TEAM_SDL}`, {
    ...teamsRoot,
    divisions: () => ({ results: [
      { id: 'dA', name: 'C2', season: { id: '70', name: 'Fall 2026', startDate: '2026-09-01', endDate: '2027-03-31' } },
      { id: 'dB', name: 'B1', season: { id: '70', name: 'Fall 2026', startDate: '2026-09-01', endDate: '2027-03-31' } },
      { id: 'dOld', name: 'C2', season: { id: '60', name: 'Fall 2025', startDate: '2025-09-01', endDate: '2026-03-31' } },
    ] }),
  }, async (se) => {
    const { supported, seasons, source } = await se.listSeasons();
    assert.ok(supported);
    assert.strictEqual(source, 'divisions');
    assert.deepStrictEqual(seasons.map((x) => x.name), ['Fall 2026', 'Fall 2025']);
    const { teams, filter } = await se.listTeams('70');
    assert.strictEqual(filter, 'division');
    assert.deepStrictEqual(teams.map((t) => `${t.name} ${t.division}`), ['Biscuits B1', 'Pond Hockey C2']);
  });
});

test('seasons that list their divisions link teams to a season', async () => {
  await withApi(`
    type Query {
      seasons(organizationId: ID!, page: Int, perPage: Int): SeasonPage
      teams(organizationId: Int!, page: Int, perPage: Int): TeamPage
    }
    type SeasonPage { results: [Season] }
    type Season { id: ID name: String startDate: String endDate: String divisions: [Division] }
    type Division { id: ID name: String }
  ${TEAM_SDL}`, {
    ...teamsRoot,
    seasons: () => ({ results: [
      { id: '60', name: 'Fall 2025', startDate: '2025-09-01', endDate: '2026-03-31', divisions: [{ id: 'dOld', name: 'C2' }] },
      { id: '70', name: 'Fall 2026', startDate: '2026-09-01', endDate: '2027-03-31', divisions: [{ id: 'dA', name: 'C2' }, { id: 'dB', name: 'B1' }] },
    ] }),
  }, async (se) => {
    const { teams, filter } = await se.listTeams('60');
    assert.strictEqual(filter, 'season divisions');
    assert.deepStrictEqual(teams.map((t) => t.id), ['o1']);
  });
});

test('no season link at all: every team is listed with created date and status for filtering', async () => {
  await withApi(`
    type Query { teams(organizationId: Int!, page: Int, perPage: Int): TeamPage }
  ${TEAM_SDL}`, teamsRoot, async (se) => {
    const { supported, seasons } = await se.listSeasons();
    assert.strictEqual(supported, false);
    assert.deepStrictEqual(seasons, []);
    const { teams, filter } = await se.listTeams(null);
    assert.strictEqual(filter, 'none');
    assert.deepStrictEqual(teams.map((t) => [t.id, t.created.slice(0, 10), t.status, t.division_id]), [
      ['n2', '2026-08-20', 'active', 'dB'], ['n1', '2026-08-15', 'active', 'dA'], ['o1', '2025-08-10', 'inactive', 'dOld'],
    ]);
  });
});

test('lists teams for a season via divisions and never sends unsupported arguments', async () => {
  const se = require('../src/lib/sportsengine');
  const log = {};
  const { teams, filter } = await se.listTeams('s25', log);
  assert.strictEqual(filter, 'division');
  assert.deepStrictEqual(teams.map((t) => `${t.name} ${t.division}`), ['Ice Dogs B1', 'Blue Liners C2']);
  assert.ok(!queries.some((q) => /teams\([^)]*season/i.test(q)), 'no seasonId argument on teams');
  assert.ok(!queries.some((q) => /\bdivision \{/.test(q)), 'never selects Team.division');
  assert.ok(!log.query.includes('players'), 'team listing does not pull rosters');
  assert.match(log.query, /teams\(organizationId: 237023, page: 1, perPage: 100\)/, 'Int organization ID is sent unquoted');

  const all = await se.listTeams(null);
  assert.strictEqual(all.teams.length, 3);
});

test('roster queries stay under the complexity limit and only request needed fields', async () => {
  const se = require('../src/lib/sportsengine');
  queries.length = 0;
  const diagnostics = {};
  const players = await se.fetchRoster({ teamIds: ['t1', 't2'], seasonId: 's25', diagnostics });
  const rosterQueries = queries.filter((q) => q.includes('players'));
  assert.ok(rosterQueries.length, 'roster query sent');
  for (const q of rosterQueries) {
    assert.ok(complexity(q) <= 101, `complexity ${complexity(q)} within budget`);
    assert.doesNotMatch(q, /memberships|registrationResults|verifiedProfile|statistics|photoUrl|phone|email/, 'skips unused fields');
  }
  assert.strictEqual(players.length, 4);
  const sam = players.find((p) => p.jersey_number === '12');
  assert.deepStrictEqual(sam, {
    first_name: 'Sam', last_name: 'Skater', jersey_number: '12', position: null, email: null, birth_date: '1980-02-02',
    external_id: 'se:p1', extra_ids: ['se-profile:pr1', 'se-person:se-pr1'], team: 'Blue Liners', team_external_id: 'se:t1', division: 'C2',
  });
});

test('shrinks the page and retries when the API reports a query is too complex', async () => {
  const se = require('../src/lib/sportsengine');
  process.env.SPORTSENGINE_MAX_COMPLEXITY = '100000'; // pretend we don't know the limit
  delete require.cache[require.resolve('../src/lib/sportsengine')];
  const fresh = require('../src/lib/sportsengine');
  try {
    queries.length = 0;
    const diagnostics = {};
    const players = await fresh.fetchRoster({ diagnostics });
    assert.ok(queries.some((q) => /perPage: 100\b/.test(q) && q.includes('players')), 'first tried a full page');
    assert.ok(diagnostics.pageSize < 100, `retried with page size ${diagnostics.pageSize}`);
    assert.strictEqual(players.length, 5);
  } finally {
    delete process.env.SPORTSENGINE_MAX_COMPLEXITY;
    delete require.cache[require.resolve('../src/lib/sportsengine')];
    require('../src/lib/sportsengine');
  }
  assert.ok(se);
});

test('admin imports SportsEngine seasons and teams; players carry across seasons', async () => {
  await h.resetDb();
  const app = h.createApp();
  await h.createUser({ email: 'se-admin@test.com', name: 'SE Admin', role: 'admin' });
  const admin = await h.login(app, 'se-admin@test.com');

  const seasonsPage = await admin.get('/admin/sportsengine');
  assert.match(seasonsPage.text, /2025-26/);
  assert.match(seasonsPage.text, /Show 2025-26 teams/, 'current season offered first');
  assert.match(seasonsPage.text, /Current season/);
  const teamsPage = await admin.get('/admin/sportsengine/teams?season=s25&name=2025-26&start=2025-09-01');
  assert.match(teamsPage.text, /Ice Dogs/);
  assert.ok(!teamsPage.text.includes('value="t3"'), 'last season team is filtered out');
  assert.match(teamsPage.text, /Showing only teams in <strong>2025-26/);
  assert.doesNotMatch(teamsPage.text, /data-team-filters/, 'no fallback filters when the season filter works');

  const csrf = h.csrfFrom(teamsPage.text);
  const imp = await admin.post('/admin/sportsengine/import').type('form').send({
    _csrf: csrf, se_season_id: 's25', se_season_name: '2025-26', se_start_date: '2025-09-01',
    team_ids: ['t1', 't2'], target: 'new', new_season_name: '2025-26', make_current: 'on',
  });
  assert.strictEqual(imp.status, 200);
  assert.match(imp.text, /<strong>3<\/strong> new players/); // Sam is on both teams as one person
  const s25 = await h.db.one(`SELECT * FROM seasons WHERE external_id = 'se:s25'`);
  assert.ok(s25.is_current);
  assert.strictEqual(new Date(s25.start_date).toISOString().slice(0, 10), '2025-09-01');
  assert.strictEqual((await h.db.one('SELECT count(*)::int AS n FROM teams WHERE season_id = $1', [s25.id])).n, 2);

  // Import last season's team into its own season: Sam is matched, not duplicated
  const imp2 = await admin.post('/admin/sportsengine/import').type('form').send({
    _csrf: csrf, se_season_id: 's24', se_season_name: '2024-25', team_ids: 't3', target: 'new', new_season_name: '2024-25',
  });
  assert.match(imp2.text, /<strong>0<\/strong> new players, <strong>1<\/strong> existing/);
  // Sam: one person (same SportsEngine profile across three registrations), a regular and a sub spot
  // in 2025-26 and one spot in 2024-25, with every ID linked.
  const sam = await h.db.many(
    `SELECT s.name, x.jersey_number, x.is_sub, x.external_ids FROM (${h.SPOTS}) x JOIN seasons s ON s.id = x.season_id
      WHERE x.player_id = ${h.byExt('se:p1')} ORDER BY s.name, x.jersey_number`);
  assert.deepStrictEqual(sam.map((r) => `${r.name} #${r.jersey_number}${r.is_sub ? ' sub' : ''}`), ['2024-25 #4', '2025-26 #12', '2025-26 #44 sub']);
  assert.deepStrictEqual([...sam[0].external_ids].sort(), ['se-person:se-pr1', 'se-profile:pr1', 'se:p1', 'se:p7', 'se:p9']);
  assert.strictEqual((await h.db.one(`SELECT birth_date FROM players WHERE id = ${h.byExt('se:p1')}`)).birth_date, '1980-02-02');

  // Re-importing the same season updates in place
  const imp3 = await admin.post('/admin/sportsengine/import').type('form').send({
    _csrf: csrf, se_season_id: 's25', team_ids: ['t1'], target: String(s25.id),
  });
  assert.match(imp3.text, /<strong>0<\/strong> new players, <strong>2<\/strong> existing/);
  assert.strictEqual((await h.db.one('SELECT count(*)::int AS n FROM players')).n, 3);
});

test('surfaces GraphQL errors from a custom query', async () => {
  const se = require('../src/lib/sportsengine');
  config.sportsEngine.rosterQuery = 'query { teams(organizationId: "org-42", seasonId: "x") { results { id } } }';
  try {
    await assert.rejects(se.fetchRoster(), /Unknown argument "seasonId"/);
  } finally {
    config.sportsEngine.rosterQuery = undefined;
  }
});
