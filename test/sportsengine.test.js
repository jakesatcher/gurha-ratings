'use strict';

// Exercises the SportsEngine integration against a local GraphQL server with a realistic schema:
// teams() has no season argument and Team exposes divisionId (not division), so season filtering
// has to go through divisions(seasonId). Rosters nest the person inside roster entries.
const h = require('./helpers'); // sets the test DATABASE_URL before config loads
const config = require('../src/config');
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { buildSchema, graphql } = require('graphql');

const schema = buildSchema(`
  type Query {
    seasons(organizationId: ID!, page: Int): SeasonPage
    teams(organizationId: ID!, page: Int, perPage: Int): TeamPage
    team(id: ID!): Team
    divisions(organizationId: ID!, seasonId: ID): [Division]
    organization(id: ID!): Organization
  }
  type Organization { id: ID name: String }
  type SeasonPage { results: [Season] pagination: Pagination }
  type Season { id: ID! name: String startDate: String endDate: String }
  type TeamPage { results: [Team] pagination: Pagination }
  type Pagination { page: Int totalPages: Int }
  type Team { id: ID! name: String divisionId: ID rosterPlayers(page: Int): RosterPage organization: Organization }
  type RosterPage { results: [RosterPlayer] }
  type RosterPlayer { id: ID jerseyNumber: String position: String persona: Persona }
  type Persona { id: ID firstName: String lastName: String email: String }
  type Division { id: ID name: String seasonId: ID }
`);

const DIVISIONS = [
  { id: 'd1', name: 'C2', seasonId: 's25' },
  { id: 'd2', name: 'B1', seasonId: 's25' },
  { id: 'd3', name: 'C2', seasonId: 's24' },
];
const TEAMS = [
  { id: 't1', name: 'Blue Liners', divisionId: 'd1', players: [['p1', 'Sam', 'Skater', '12', 'Defense'], ['p2', 'Gail', 'Goalie', '30', 'Goalie']] },
  { id: 't2', name: 'Ice Dogs', divisionId: 'd2', players: [['p3', 'Fran', 'Forward', '9', 'Forward']] },
  { id: 't3', name: 'Blue Liners', divisionId: 'd3', players: [['p1', 'Sam', 'Skater', '4', 'Defense']] }, // last season
];
const teamValue = (t) => ({
  id: t.id, name: t.name, divisionId: t.divisionId, organization: { id: 'org-42', name: 'GURHA' },
  rosterPlayers: () => ({ results: t.players.map(([id, f, l, j, pos]) => ({ id: `rp-${t.id}-${id}`, jerseyNumber: j, position: pos, persona: { id, firstName: f, lastName: l } })) }),
});
const root = {
  seasons: ({ page = 1 }) => ({
    pagination: { page, totalPages: 1 },
    results: page === 1 ? [{ id: 's24', name: '2024-25', startDate: '2024-09-01' }, { id: 's25', name: '2025-26', startDate: '2025-09-01' }] : [],
  }),
  teams: ({ organizationId, page = 1 }) => {
    assert.strictEqual(organizationId, 'org-42');
    return { pagination: { page, totalPages: TEAMS.length }, results: TEAMS.slice(page - 1, page).map(teamValue) }; // one team per page
  },
  team: ({ id }) => teamValue(TEAMS.find((t) => t.id === id)),
  divisions: ({ seasonId }) => DIVISIONS.filter((d) => !seasonId || d.seasonId === seasonId),
};

let server;
const queries = [];

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
      const result = await graphql({ schema, source: query, rootValue: root, variableValues: variables });
      res.statusCode = result.errors && !result.data ? 400 : 200;
      res.end(JSON.stringify(result));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(config.sportsEngine, {
    clientId: 'id',
    clientSecret: 'secret',
    organizationId: 'org-42',
    tokenUrl: `${base}/oauth/token`,
    graphqlUrl: `${base}/graphql`,
    rosterQuery: undefined,
  });
});

test.after(async () => {
  server.close();
  await h.db.pool.end();
});

test('lists seasons, newest first', async () => {
  const se = require('../src/lib/sportsengine');
  const { supported, seasons } = await se.listSeasons();
  assert.ok(supported);
  assert.deepStrictEqual(seasons.map((s) => s.name), ['2025-26', '2024-25']);
  assert.strictEqual(seasons[0].start_date, '2025-09-01');
});

test('lists teams for a season via divisions and never sends unsupported arguments', async () => {
  const se = require('../src/lib/sportsengine');
  const log = {};
  const { teams, filter } = await se.listTeams('s25', log);
  assert.strictEqual(filter, 'division');
  assert.deepStrictEqual(teams.map((t) => `${t.name} ${t.division}`), ['Ice Dogs B1', 'Blue Liners C2']);
  assert.ok(!queries.some((q) => /teams\([^)]*season/i.test(q)), 'no seasonId argument on teams');
  assert.ok(!queries.some((q) => /\bdivision \{/.test(q)), 'never selects Team.division');
  assert.ok(!log.query.includes('rosterPlayers'), 'team listing does not pull rosters');

  const all = await se.listTeams(null);
  assert.strictEqual(all.teams.length, 3);
});

test('fetches rosters for selected teams only, per team', async () => {
  const se = require('../src/lib/sportsengine');
  const diagnostics = {};
  const players = await se.fetchRoster({ teamIds: ['t1'], seasonId: 's25', diagnostics });
  assert.match(diagnostics.queryMode, /per team/);
  assert.strictEqual(players.length, 2);
  const sam = players.find((p) => p.last_name === 'Skater');
  assert.deepStrictEqual(sam, {
    first_name: 'Sam', last_name: 'Skater', jersey_number: '12', position: 'Defense', email: null,
    external_id: 'se:p1', team: 'Blue Liners', team_external_id: 'se:t1', division: 'C2',
  });
});

test('admin imports SportsEngine seasons and teams; players carry across seasons', async () => {
  await h.resetDb();
  const app = h.createApp();
  await h.createUser({ email: 'se-admin@test.com', name: 'SE Admin', role: 'admin' });
  const admin = await h.login(app, 'se-admin@test.com');

  const seasonsPage = await admin.get('/admin/sportsengine');
  assert.match(seasonsPage.text, /2025-26/);
  const teamsPage = await admin.get('/admin/sportsengine/teams?season=s25&name=2025-26&start=2025-09-01');
  assert.match(teamsPage.text, /Ice Dogs/);
  assert.ok(!teamsPage.text.includes('value="t3"'), 'last season team is filtered out');

  const csrf = h.csrfFrom(teamsPage.text);
  const imp = await admin.post('/admin/sportsengine/import').type('form').send({
    _csrf: csrf, se_season_id: 's25', se_season_name: '2025-26', se_start_date: '2025-09-01',
    team_ids: ['t1', 't2'], target: 'new', new_season_name: '2025-26', make_current: 'on',
  });
  assert.strictEqual(imp.status, 200);
  assert.match(imp.text, /<strong>3<\/strong> new players/);
  const s25 = await h.db.one(`SELECT * FROM seasons WHERE external_id = 'se:s25'`);
  assert.ok(s25.is_current);
  assert.strictEqual(new Date(s25.start_date).toISOString().slice(0, 10), '2025-09-01');
  assert.strictEqual((await h.db.one('SELECT count(*)::int AS n FROM teams WHERE season_id = $1', [s25.id])).n, 2);

  // Import last season's team into its own season: Sam is matched, not duplicated
  const imp2 = await admin.post('/admin/sportsengine/import').type('form').send({
    _csrf: csrf, se_season_id: 's24', se_season_name: '2024-25', team_ids: 't3', target: 'new', new_season_name: '2024-25',
  });
  assert.match(imp2.text, /<strong>0<\/strong> new players, <strong>1<\/strong> existing/);
  const sam = await h.db.many(
    `SELECT s.name, sp.jersey_number FROM players p JOIN season_players sp ON sp.player_id = p.id JOIN seasons s ON s.id = sp.season_id
      WHERE p.external_id = 'se:p1' ORDER BY s.name`);
  assert.deepStrictEqual(sam.map((r) => `${r.name} #${r.jersey_number}`), ['2024-25 #4', '2025-26 #12']);

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
