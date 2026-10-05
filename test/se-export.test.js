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
    { external_id: 'se:80000001', jersey_number: '17', first_name: 'Alex', last_name: 'Example', position: null, birth_date: '1961-08-16', is_sub: false },
    { external_id: 'se:80000002', jersey_number: '50', first_name: 'Gus', last_name: 'Goalie', position: 'G', birth_date: '1960-10-12', is_sub: false },
    { external_id: 'se:80000003', jersey_number: '3', first_name: 'Łukasz', last_name: 'Núñez', position: 'D', birth_date: '2001-04-19', is_sub: false },
    { external_id: 'se:80000004', jersey_number: '90', first_name: 'Fran', last_name: 'Forward', position: 'F', birth_date: null, is_sub: false },
    { external_id: 'se:80000007', jersey_number: null, first_name: 'Alex', last_name: 'Example', position: null, birth_date: '1995-05-08', is_sub: false },
  ]);
  assert.match(penguins.problems.join('\n'), /Two players named Alex Example with different dates of birth/);
  assert.match(bears.problems.join('\n'), /unrecognised date of birth "13\/45\/1990"/);
  const sub = bears.players.find((p) => p.external_id === 'se:80000006');
  assert.deepStrictEqual([sub.first_name, sub.last_name, sub.is_sub], ['Gus', 'Goalie', true], '"(Sub)" is stripped and flagged');
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
  assert.match(review.text, /2<\/strong> teams, <strong>7<\/strong> roster rows → <strong>6<\/strong> people/);
  assert.match(review.text, /1 extra roster spot/);
  assert.match(review.text, /Same person<\/span> <span class="muted">as 1 TEST PENGUINS #50/);
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
  const gus = await h.db.one(`${h.SPOTS} WHERE p.id = ${h.byExt('se:80000002')} AND sp.season_id = $1`, [season.id]);
  assert.deepStrictEqual([gus.birth_date, gus.jersey_number, gus.position], ['1960-10-12', '50', 'G']);

  // Session data is cleared after import
  assert.strictEqual((await admin.get('/admin/import/sportsengine')).headers.location, '/admin/import');

  // Set a position manually, then re-import everything into the same (existing) season
  await h.db.query(`UPDATE team_rosters SET position = 'F' WHERE season_player_id IN (SELECT id FROM season_players WHERE player_id = ${h.byExt('se:80000001')})`);
  await upload(admin);
  const review2 = await admin.get('/admin/import/sportsengine');
  assert.match(review2.text, new RegExp(`value="${season.id}" checked`), 'existing season with the same name is preselected');
  assert.match(review2.text, /7<\/strong> roster rows → <strong>6<\/strong> people/, 'people already in the database are counted once');
  const again = await admin.post('/admin/import/sportsengine/confirm').type('form')
    .send({ _csrf: h.csrfFrom(review2.text), sheets: ['0', '1'], target: String(season.id) });
  assert.match(again.text, /<strong>1<\/strong> new players, <strong>5<\/strong> existing/);
  assert.strictEqual((await h.db.one('SELECT count(*)::int AS n FROM players')).n, 6);

  // Gus: one person, both registration IDs, a regular spot on the Penguins and a sub spot on the Bears
  const gusSpots = await h.db.many(`${h.SPOTS} WHERE p.id = ${h.byExt('se:80000002')} ORDER BY t.name`);
  assert.deepStrictEqual(gusSpots.map((r) => `${r.team} #${r.jersey_number}${r.is_sub ? ' sub' : ''}`), ['1 TEST PENGUINS #50', '2 TEST BEARS #23 sub']);
  assert.deepStrictEqual(gusSpots[0].external_ids, ['se:80000002', 'se:80000006']);
  // …listed once on the players page, and on both team reports
  const list = await admin.get('/players?q=goalie');
  assert.strictEqual((list.text.match(/Goalie, Gus/g) || []).length, 1);
  const bearsTeam = await h.db.one(`SELECT id FROM teams WHERE name = '2 TEST BEARS'`);
  assert.match((await admin.get(`/reports/teams?team=${bearsTeam.id}`)).text, /Gus Goalie<\/a> <span class="tag">Sub<\/span>/);
  const alex = await h.db.one(`${h.SPOTS} WHERE p.id = ${h.byExt('se:80000001')}`);
  assert.strictEqual(alex.position, 'F', 'blank position in the file does not wipe an existing one');

  // Player page shows age derived from date of birth
  const p = await h.db.one(`SELECT ${h.byExt('se:80000002')} AS id`);
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
