'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const { parseSportsEngineExport } = require('../src/lib/seExport');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'se-roster-export.xls'));

test('parses the SportsEngine roster export layout', () => {
  const r = parseSportsEngineExport(FIXTURE);
  assert.strictEqual(r.league, 'TEST RECREATIONAL HOCKEY  2026');
  assert.deepStrictEqual(r.seasonParts, ['TEST SPRING/FALL 2026', 'FALL SEASON 2026']);
  assert.strictEqual(r.suggestedSeasonName, 'FALL SEASON 2026');
  assert.strictEqual(r.teams.length, 2);
  assert.match(r.errors[0], /Notes/); // sheet without a roster header is reported, not fatal

  const [penguins, bears] = r.teams;
  assert.strictEqual(penguins.team, '1 TEST PENGUINS');
  assert.strictEqual(penguins.team_external_id, 'se:90000001');
  assert.strictEqual(penguins.division, 'C1B2');
  assert.deepStrictEqual(penguins.missingColumns, []);
  assert.deepStrictEqual(penguins.players.map(({ row, ...p }) => p), [
    { external_id: 'se:80000001', jersey_number: '17', first_name: 'Alex', last_name: 'Example', position: null, birth_date: '1961-08-16' },
    { external_id: 'se:80000002', jersey_number: '29', first_name: 'Gus', last_name: 'Goalie', position: 'G', birth_date: '1998-04-16' },
    { external_id: 'se:80000003', jersey_number: '3', first_name: 'Łukasz', last_name: 'Núñez', position: 'D', birth_date: '2001-04-19' },
    { external_id: 'se:80000004', jersey_number: '90', first_name: 'Fran', last_name: 'Forward', position: 'F', birth_date: null },
    { external_id: 'se:80000007', jersey_number: null, first_name: 'Alex', last_name: 'Example', position: null, birth_date: '1995-05-08' },
  ]);
  assert.match(penguins.problems.join('\n'), /Two players named Alex Example/);
  assert.match(bears.problems.join('\n'), /unrecognised date of birth "13\/45\/1990"/);
  assert.match(bears.problems.join('\n'), /Gus Goalie is also on 1 TEST PENGUINS/);
});

test('rejects files that are not .xls workbooks', () => {
  assert.throws(() => parseSportsEngineExport(Buffer.from('first_name,last_name\nA,B\n')), /not an Excel \.xls workbook/);
});

let app;
test.before(async () => {
  await h.resetDb();
  app = h.createApp();
});
test.after(async () => {
  await h.db.pool.end();
});

async function upload(agent, buffer = FIXTURE, name = 'roster.xls') {
  const page = await agent.get('/admin/import');
  return agent.post('/admin/import/sportsengine').field('_csrf', h.csrfFrom(page.text)).attach('file', buffer, name);
}

test('upload → review → import into a new season, then re-import updates in place', async () => {
  await h.createUser({ email: 'x-admin@test.com', name: 'X Admin', role: 'admin' });
  const admin = await h.login(app, 'x-admin@test.com');

  const up = await upload(admin);
  assert.strictEqual(up.status, 302);
  assert.strictEqual(up.headers.location, '/admin/import/sportsengine');
  const review = await admin.get('/admin/import/sportsengine');
  assert.match(review.text, /2<\/strong> teams, <strong>7<\/strong> players/);
  assert.match(review.text, /value="FALL SEASON 2026"/);
  assert.match(review.text, /Łukasz/);
  assert.ok(!review.text.includes('1961-08-16'), 'review shows age, not date of birth');

  // Import only the Penguins into a new season
  const csrf = h.csrfFrom(review.text);
  const done = await admin.post('/admin/import/sportsengine/confirm').type('form')
    .send({ _csrf: csrf, sheets: '0', target: 'new', new_season_name: 'FALL SEASON 2026', make_current: 'on' });
  assert.strictEqual(done.status, 200);
  assert.match(done.text, /<strong>5<\/strong> new players/);
  // Two people named Alex Example on the same team stay separate
  assert.strictEqual((await h.db.one(`SELECT count(*)::int AS n FROM players WHERE last_name = 'Example'`)).n, 2);
  const season = await h.db.one(`SELECT * FROM seasons WHERE name = 'FALL SEASON 2026'`);
  assert.ok(season.is_current);
  const team = await h.db.one('SELECT * FROM teams WHERE season_id = $1', [season.id]);
  assert.deepStrictEqual([team.name, team.division, team.external_id], ['1 TEST PENGUINS', 'C1B2', 'se:90000001']);
  const gus = await h.db.one(
    `SELECT p.birth_date, sp.jersey_number, sp.position FROM players p JOIN season_players sp ON sp.player_id = p.id
      WHERE p.external_id = 'se:80000002' AND sp.season_id = $1`, [season.id]);
  assert.deepStrictEqual({ ...gus }, { birth_date: '1998-04-16', jersey_number: '29', position: 'G' });

  // Session data is cleared after import
  assert.strictEqual((await admin.get('/admin/import/sportsengine')).headers.location, '/admin/import');

  // Set a position manually, then re-import everything into the same (existing) season
  await h.db.query(`UPDATE season_players SET position = 'F' WHERE player_id = (SELECT id FROM players WHERE external_id = 'se:80000001')`);
  await upload(admin);
  const review2 = await admin.get('/admin/import/sportsengine');
  assert.match(review2.text, new RegExp(`value="${season.id}" checked`), 'existing season with the same name is preselected');
  const again = await admin.post('/admin/import/sportsengine/confirm').type('form')
    .send({ _csrf: h.csrfFrom(review2.text), sheets: ['0', '1'], target: String(season.id) });
  assert.match(again.text, /<strong>1<\/strong> new players, <strong>6<\/strong> existing/);
  assert.strictEqual((await h.db.one('SELECT count(*)::int AS n FROM players')).n, 6);
  const alex = await h.db.one(`SELECT sp.position FROM season_players sp JOIN players p ON p.id = sp.player_id WHERE p.external_id = 'se:80000001'`);
  assert.strictEqual(alex.position, 'F', 'blank position in the file does not wipe an existing one');

  // Player page shows age derived from date of birth
  const p = await h.db.one(`SELECT id FROM players WHERE external_id = 'se:80000002'`);
  assert.match((await admin.get(`/players/${p.id}`)).text, /Age \d{2}/);
});

test('cancel, bad files and CSRF', async () => {
  await h.createUser({ email: 'y-admin@test.com', name: 'Y Admin', role: 'admin' });
  const admin = await h.login(app, 'y-admin@test.com');

  await upload(admin);
  const review = await admin.get('/admin/import/sportsengine');
  await admin.post('/admin/import/sportsengine/cancel').type('form').send({ _csrf: h.csrfFrom(review.text) });
  assert.strictEqual((await admin.get('/admin/import/sportsengine')).status, 302);

  const bad = await upload(admin, Buffer.from('not a spreadsheet'), 'roster.xls');
  assert.strictEqual(bad.headers.location, '/admin/import');
  assert.match((await admin.get('/admin/import')).text, /not an Excel \.xls workbook/);

  const noCsrf = await admin.post('/admin/import/sportsengine').attach('file', FIXTURE, 'roster.xls');
  assert.strictEqual(noCsrf.status, 403);

  await h.createUser({ email: 'y-rater@test.com', name: 'Y Rater' });
  const rater = await h.login(app, 'y-rater@test.com');
  assert.strictEqual((await rater.get('/admin/import/sportsengine')).status, 403);
});

test('fallback matching never merges players with different IDs or birth dates', async () => {
  const { upsertPlayers } = require('../src/lib/players');
  const season = await h.db.one('SELECT id FROM seasons ORDER BY id LIMIT 1');
  const run = (rows) => h.db.tx((c) => upsertPlayers(rows, 'import', season.id, c));
  await run([{ first_name: 'Sam', last_name: 'Same', team: 'Twins', birth_date: '1970-01-01' }]);
  // Same name + team, different birth date → new player
  const r1 = await run([{ first_name: 'Sam', last_name: 'Same', team: 'Twins', birth_date: '2000-01-01' }]);
  assert.strictEqual(r1.created, 1);
  // Same name, no birth date, but now ambiguous (two candidates) → new player rather than a guess
  const r2 = await run([{ first_name: 'Sam', last_name: 'Same' }]);
  assert.strictEqual(r2.created, 1);
  // Matching birth date links to the right one
  const r3 = await run([{ first_name: 'Sam', last_name: 'Same', team: 'Twins', birth_date: '2000-01-01', jersey_number: '9' }]);
  assert.strictEqual(r3.updated, 1);
});
