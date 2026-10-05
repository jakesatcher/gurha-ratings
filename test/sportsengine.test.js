'use strict';

// Exercises the SportsEngine sync against a local GraphQL server with a realistic schema
// (no seasonId argument, divisionId instead of division, person nested in roster entries).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { buildSchema, graphql } = require('graphql');

const schema = buildSchema(`
  type Query {
    teams(organizationId: ID!, page: Int, perPage: Int): TeamPage
    divisions(organizationId: ID!): [Division]
    organization(id: ID!): Organization
  }
  type Organization { id: ID name: String }
  type TeamPage { results: [Team] pagination: Pagination }
  type Pagination { page: Int totalPages: Int }
  type Team { id: ID! name: String divisionId: ID rosterPlayers(page: Int): RosterPage organization: Organization }
  type RosterPage { results: [RosterPlayer] }
  type RosterPlayer { id: ID jerseyNumber: String position: String persona: Persona }
  type Persona { id: ID firstName: String lastName: String email: String }
  type Division { id: ID name: String }
`);

const TEAMS = [
  { id: 't1', name: 'Blue Liners', divisionId: 'd1', players: [['p1', 'Sam', 'Skater', '12', 'Defense'], ['p2', 'Gail', 'Goalie', '30', 'Goalie']] },
  { id: 't2', name: 'Ice Dogs', divisionId: 'd2', players: [['p3', 'Fran', 'Forward', '9', 'Forward']] },
];
const root = {
  teams: ({ organizationId, page = 1, perPage = 10 }) => {
    assert.strictEqual(organizationId, 'org-42');
    const slice = TEAMS.slice((page - 1) * 1, page * 1); // one team per page to exercise paging
    return {
      pagination: { page, totalPages: TEAMS.length },
      results: slice.map((t) => ({
        id: t.id, name: t.name, divisionId: t.divisionId, organization: { id: 'org-42', name: 'GURHA' },
        rosterPlayers: () => ({ results: t.players.map(([id, f, l, j, pos]) => ({ id: `rp-${id}`, jerseyNumber: j, position: pos, persona: { id, firstName: f, lastName: l } })) }),
      })),
    };
  },
  divisions: () => [{ id: 'd1', name: 'C2' }, { id: 'd2', name: 'B1' }],
};

let server;
const queries = [];

test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok' }));
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
  Object.assign(process.env, {
    SPORTSENGINE_CLIENT_ID: 'id',
    SPORTSENGINE_CLIENT_SECRET: 'secret',
    SPORTSENGINE_ORG_ID: 'org-42',
    SPORTSENGINE_SEASON_ID: 'season-1', // set, but the schema has no seasonId arg: must be ignored
    SPORTSENGINE_TOKEN_URL: `${base}/oauth/token`,
    SPORTSENGINE_GRAPHQL_URL: `${base}/graphql`,
  });
});

test.after(() => server.close());

test('builds a valid query from the schema and extracts players across pages', async () => {
  const se = require('../src/lib/sportsengine');
  const diagnostics = {};
  const players = await se.fetchRoster({ diagnostics });

  assert.ok(!diagnostics.query.includes('seasonId'));
  assert.ok(!/\bdivision \{/.test(diagnostics.query));
  assert.ok(!diagnostics.query.includes('organization {'), 'skips irrelevant object fields');
  assert.strictEqual(diagnostics.pages, 3, 'stops on the first empty page');
  assert.strictEqual(players.length, 3);

  const sam = players.find((p) => p.last_name === 'Skater');
  assert.deepStrictEqual(sam, {
    first_name: 'Sam', last_name: 'Skater', jersey_number: '12', position: 'Defense', email: null,
    external_id: 'se:p1', team: 'Blue Liners', division: 'C2',
  });
  assert.strictEqual(players.find((p) => p.last_name === 'Forward').division, 'B1');
});

test('surfaces GraphQL errors from a custom query', async () => {
  process.env.SPORTSENGINE_ROSTER_QUERY = 'query { teams(organizationId: "org-42", seasonId: "x") { results { id } } }';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/lib/sportsengine')];
  const se = require('../src/lib/sportsengine');
  await assert.rejects(se.fetchRoster(), /Unknown argument "seasonId"/);
  delete process.env.SPORTSENGINE_ROSTER_QUERY;
});
