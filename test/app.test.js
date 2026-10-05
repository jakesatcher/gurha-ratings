'use strict';

const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

const ALREADY = 'You already rated this player. If you feel this is an error, or would like to change your rating, please contact an Admin';

function fullRating(overrides = {}) {
  return {
    score_1: '8', score_2: '7', score_3: '6', score_4: '5', score_5: '7', score_6: '6',
    comment_1: 'Strong edges',
    independent_level: 'B3',
    game_performance: 'consistently',
    final_level: 'B3',
    evidence: 'Good skater',
    ...overrides,
  };
}

let app;

test.before(async () => {
  await h.resetDb();
  app = h.createApp();
});

test.after(async () => {
  await h.db.pool.end();
});

test('access request → admin approval → MFA → rating once → duplicate error', async (t) => {
  const admin = await h.createUser({ email: 'admin@test.com', name: 'Ada Admin', role: 'admin' });
  assert.ok(admin);

  // Rater requests access
  const anon = h.request.agent(app);
  const reg = await anon.get('/register');
  const r = await anon.post('/register').type('form').send({
    _csrf: h.csrfFrom(reg.text), name: 'Riley Rater', email: 'Riley@Test.com', password: 'Slapshot!Goal47', password_confirm: 'Slapshot!Goal47', requested_role: 'rater',
  });
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /Request submitted/);
  assert.ok(h.mailer.outbox.some((m) => m.to === 'admin@test.com' && /Access request/.test(m.subject)));

  // Pending users can't sign in
  const loginPage = await anon.get('/login');
  const pending = await anon.post('/login').type('form').send({ _csrf: h.csrfFrom(loginPage.text), email: 'riley@test.com', password: 'Slapshot!Goal47' });
  assert.strictEqual(pending.status, 401);
  assert.match(pending.text, /awaiting admin approval/);

  // Admin signs in (email MFA) and approves
  const adminAgent = await h.login(app, 'admin@test.com');
  const rater = await h.db.one(`SELECT id FROM users WHERE email = 'riley@test.com'`);
  const approve = await h.post(adminAgent, `/admin/users/${rater.id}/approve`, {}, '/admin/users');
  assert.strictEqual(approve.status, 302);
  assert.strictEqual((await h.db.one('SELECT status FROM users WHERE id = $1', [rater.id])).status, 'approved');

  // Rater signs in and enrols an authenticator app
  const raterAgent = h.request.agent(app);
  const lp = await raterAgent.get('/login');
  const lr = await raterAgent.post('/login').type('form').send({ _csrf: h.csrfFrom(lp.text), email: 'riley@test.com', password: 'Slapshot!Goal47' });
  assert.strictEqual(lr.headers.location, '/mfa/setup');
  // Can't reach the app before finishing MFA
  assert.strictEqual((await raterAgent.get('/players')).headers.location, '/login');
  const totpPage = await raterAgent.get('/mfa/setup/totp');
  const secret = /<code class="secret">([^<]+)<\/code>/.exec(totpPage.text)[1].replace(/\s/g, '');
  const bad = await raterAgent.post('/mfa/setup/totp').type('form').send({ _csrf: h.csrfFrom(totpPage.text), code: '000000' });
  assert.strictEqual(bad.status, 422);
  const good = await raterAgent.post('/mfa/setup/totp').type('form').send({ _csrf: h.csrfFrom(totpPage.text), code: h.totp.generate(secret) });
  assert.strictEqual(good.status, 302);
  assert.strictEqual((await h.db.one('SELECT mfa_method FROM users WHERE id = $1', [rater.id])).mfa_method, 'totp');

  // Admin adds a player manually
  const add = await h.post(adminAgent, '/admin/players', { first_name: 'Wayne', last_name: 'Example', jersey_number: '99', team: 'Blue Liners', position: 'F' }, '/admin/players/new');
  assert.strictEqual(add.status, 302);
  const player = await h.db.one(`SELECT * FROM players WHERE last_name = 'Example'`);
  const season1 = await h.db.one('SELECT * FROM seasons WHERE is_current');
  const entry = await h.db.one(`${h.SPOTS} WHERE p.id = $1`, [player.id]);
  assert.strictEqual(entry.season_id, season1.id);
  assert.strictEqual(entry.team, 'Blue Liners');
  assert.strictEqual(entry.jersey_number, '99');

  // Rater searches
  const search = await raterAgent.get('/players?q=wayne');
  assert.match(search.text, /Example, Wayne/);
  const byJersey = await raterAgent.get('/players?q=%2399');
  assert.match(byJersey.text, /Example, Wayne/);

  // Rater can't access admin
  assert.strictEqual((await raterAgent.get('/admin')).status, 403);

  // Incomplete rating is rejected
  const incomplete = await h.post(raterAgent, `/players/${player.id}/rate`, { score_1: '5' });
  assert.strictEqual(incomplete.status, 422);

  // Score out of range is rejected
  const outOfRange = await h.post(raterAgent, `/players/${player.id}/rate`, fullRating({ score_1: '12' }));
  assert.strictEqual(outOfRange.status, 422);

  // Rate
  const rate = await h.post(raterAgent, `/players/${player.id}/rate`, fullRating());
  assert.strictEqual(rate.status, 302);

  // Duplicate submission → exact error message
  const dup = await h.post(raterAgent, `/players/${player.id}/rate`, fullRating({ final_level: 'A1' }));
  assert.strictEqual(dup.status, 409);
  assert.ok(dup.text.includes(ALREADY), 'duplicate POST shows required message');
  const dupGet = await raterAgent.get(`/players/${player.id}/rate`);
  assert.strictEqual(dupGet.status, 409);
  assert.ok(dupGet.text.includes(ALREADY), 'revisiting the form shows required message');
  assert.strictEqual((await h.db.one('SELECT count(*)::int AS n FROM ratings')).n, 1);

  // Player page shows the weighted average (6.80 → B3)
  const show = await raterAgent.get(`/players/${player.id}`);
  assert.match(show.text, /6\.80/);
  assert.match(show.text, /B3/);

  // Rater cannot edit ratings
  const rating = await h.db.one('SELECT id FROM ratings');
  assert.strictEqual((await h.post(raterAgent, `/admin/ratings/${rating.id}`, fullRating({ score_1: '11' }))).status, 403);

  // Admin can edit; audit is recorded
  const edit = await h.post(adminAgent, `/admin/ratings/${rating.id}`, fullRating({ score_1: '10', admin_reason: 'Rater asked' }), `/admin/ratings/${rating.id}/edit`);
  assert.strictEqual(edit.status, 302);
  assert.strictEqual((await h.db.one('SELECT score FROM rating_scores WHERE rating_id = $1 AND category_id = 1', [rating.id])).score, 10);
  const log = await h.db.one(`SELECT details FROM audit_log WHERE action = 'rating_updated'`);
  assert.strictEqual(log.details.reason, 'Rater asked');

  // Second rater differs by 2+ levels → flagged for third review
  await h.createUser({ email: 'second@test.com', name: 'Second' });
  const second = await h.login(app, 'second@test.com');
  const r2 = await h.post(second, `/players/${player.id}/rate`, fullRating({ final_level: 'C2', independent_level: 'C2' }));
  assert.strictEqual(r2.status, 302);
  const review = await second.get('/players?status=review');
  assert.match(review.text, /Example, Wayne/);
  // Raters see anonymized rater names by default
  const show2 = await second.get(`/players/${player.id}`);
  assert.match(show2.text, /Rater 1/);
  assert.ok(!show2.text.includes('Riley Rater'));
  const adminShow = await adminAgent.get(`/players/${player.id}`);
  assert.match(adminShow.text, /Riley Rater/);

  // Admin deletes a rating → rater may rate again
  await h.post(adminAgent, `/admin/ratings/${rating.id}/delete`, {});
  assert.strictEqual((await raterAgent.get(`/players/${player.id}/rate`)).status, 200);

  // Team report
  const team = await h.db.one(`SELECT id FROM teams WHERE name = 'Blue Liners'`);
  const report = await raterAgent.get(`/reports/teams?team=${team.id}`);
  assert.match(report.text, /Example/);

  // CSV export is admin only
  assert.strictEqual((await raterAgent.get('/admin/export.csv')).status, 403);
  const csv = await adminAgent.get('/admin/export.csv');
  assert.match(csv.text, /avg_skating/);

  // Disabling a user signs them out
  await h.post(adminAgent, `/admin/users/${rater.id}/disable`, {}, '/admin/users');
  assert.strictEqual((await raterAgent.get('/players')).status, 302);
});

test('CSRF token is required for POSTs', async () => {
  const agent = h.request.agent(app);
  await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ email: 'x@y.z', password: 'nope' });
  assert.strictEqual(res.status, 403);
});

test('CSV and JSON import create and update players', async () => {
  await h.createUser({ email: 'imp@test.com', name: 'Importer', role: 'admin' });
  const agent = await h.login(app, 'imp@test.com');
  const page = await agent.get('/admin/import');
  const csrf = h.csrfFrom(page.text);
  const csv = 'first_name,last_name,jersey_number,team,position\nJane,Doe,7,Ice Dogs,Defense\nJohn,Roe,8,Ice Dogs,G\n,NoFirst,1,X,F\n';
  const seasonId = String((await h.db.one('SELECT id FROM seasons WHERE is_current')).id);
  const res = await agent.post('/admin/import').field('_csrf', csrf).field('season_id', seasonId).attach('file', Buffer.from(csv), 'roster.csv');
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /<strong>2<\/strong> created/);
  assert.match(res.text, /<strong>1<\/strong> skipped/);

  // Re-import JSON updates rather than duplicates
  const json = JSON.stringify([{ first_name: 'Jane', last_name: 'Doe', team: 'Ice Dogs', jersey_number: '17' }]);
  const res2 = await agent.post('/admin/import').field('_csrf', csrf).field('season_id', seasonId).attach('file', Buffer.from(json), 'roster.json');
  assert.match(res2.text, /<strong>1<\/strong> updated/);
  const jane = await h.db.one(`${h.SPOTS} WHERE p.last_name = 'Doe' AND sp.season_id = $1`, [seasonId]);
  assert.strictEqual(jane.jersey_number, '17');
  assert.strictEqual(jane.position, 'D');

  // SportsEngine diagnostics page renders and reports missing configuration
  assert.strictEqual((await agent.get('/admin/sportsengine')).status, 200);
  const diag = await h.post(agent, '/admin/sportsengine/diagnostics', {}, '/admin/sportsengine/diagnostics');
  assert.strictEqual(diag.status, 200);
  assert.match(diag.text, /not configured/);

  // Multipart without CSRF is rejected, on the upload route and elsewhere
  const noCsrf = await agent.post('/admin/import').attach('file', Buffer.from(csv), 'roster.csv');
  assert.strictEqual(noCsrf.status, 403);
  const other = await h.db.one(`SELECT id FROM users WHERE email = 'imp@test.com'`);
  const forged = await agent.post(`/admin/users/${other.id}/reset-mfa`).field('x', '1');
  assert.strictEqual(forged.status, 403);
});

test('wrong email code is rejected and attempts are limited', async () => {
  await h.createUser({ email: 'otp@test.com', name: 'Otp' });
  await h.db.query(`UPDATE users SET mfa_method = 'email' WHERE email = 'otp@test.com'`);
  const agent = h.request.agent(app);
  const lp = await agent.get('/login');
  await agent.post('/login').type('form').send({ _csrf: h.csrfFrom(lp.text), email: 'otp@test.com', password: 'Slapshot!Goal47' });
  const code = h.lastCodeFor('otp@test.com');
  const page = await agent.get('/mfa');
  const csrf = h.csrfFrom(page.text);
  for (let i = 0; i < 5; i++) {
    const r = await agent.post('/mfa').type('form').send({ _csrf: csrf, code: code === '000000' ? '111111' : '000000' });
    assert.strictEqual(r.status, 401);
  }
  // Even the right code fails after too many attempts
  const r = await agent.post('/mfa').type('form').send({ _csrf: csrf, code });
  assert.strictEqual(r.status, 401);
});

test('seasons: re-rate each season, closed seasons, roster copy and history', async () => {
  await h.createUser({ email: 'sadmin@test.com', name: 'Season Admin', role: 'admin' });
  await h.createUser({ email: 'srater@test.com', name: 'Season Rater' });
  const admin = await h.login(app, 'sadmin@test.com');
  const rater = await h.login(app, 'srater@test.com');
  const s1 = await h.db.one('SELECT * FROM seasons WHERE is_current');

  await h.post(admin, '/admin/players', { first_name: 'Sid', last_name: 'Season', jersey_number: '87', team: 'Penguins', position: 'F' }, '/admin/players/new');
  const sid = await h.db.one(`SELECT id FROM players WHERE last_name = 'Season'`);
  assert.strictEqual((await h.post(rater, `/players/${sid.id}/rate`, fullRating({ score_1: '5', score_2: '5', score_3: '5', score_4: '5', score_5: '5', score_6: '5', final_level: 'C2', independent_level: 'C2' }))).status, 302);

  // New season copying the roster, made current
  const create = await h.post(admin, '/admin/seasons', { name: 'Next Season', copy_from: String(s1.id), ratings_open: 'on', make_current: 'on' }, '/admin/seasons');
  assert.strictEqual(create.status, 302);
  const s2 = await h.db.one(`SELECT * FROM seasons WHERE name = 'Next Season'`);
  assert.ok(s2.is_current);
  assert.ok(!(await h.db.one('SELECT is_current FROM seasons WHERE id = $1', [s1.id])).is_current);
  const copied = await h.db.one(
    `${h.SPOTS} WHERE sp.season_id = $1 AND p.id = $2`, [s2.id, sid.id]);
  assert.deepStrictEqual([copied.jersey_number, copied.name], ['87', 'Penguins']);

  // The rater (whose session still points at season 1) switches to season 2 and can rate again
  await h.post(rater, '/season', { season_id: String(s2.id), return_to: '/players' });
  const rerate = await h.post(rater, `/players/${sid.id}/rate`, fullRating({ season_id: String(s2.id), score_1: '8', score_2: '8', score_3: '8', score_4: '8', score_5: '8', score_6: '8', final_level: 'B2', independent_level: 'B2' }));
  assert.strictEqual(rerate.status, 302);
  // …but only once per season
  const dup = await h.post(rater, `/players/${sid.id}/rate`, fullRating({ season_id: String(s2.id) }));
  assert.strictEqual(dup.status, 409);
  assert.ok(dup.text.includes(ALREADY));

  // History shows both seasons and the improvement
  const page = await rater.get(`/players/${sid.id}`);
  assert.match(page.text, /Season history/);
  assert.match(page.text, /Next Season/);
  assert.match(page.text, /▲ 3\.00/);

  // Season list filters ratings by season
  await h.post(rater, '/season', { season_id: String(s1.id), return_to: '/players' });
  const s1page = await rater.get(`/players/${sid.id}`);
  assert.match(s1page.text, /5\.00/);

  // Closing ratings blocks new ratings for that season
  await h.post(admin, `/admin/seasons/${s1.id}`, { name: s1.name }, `/admin/seasons/${s1.id}`);
  assert.strictEqual((await h.db.one('SELECT ratings_open FROM seasons WHERE id = $1', [s1.id])).ratings_open, false);
  await h.post(admin, '/admin/players', { first_name: 'Late', last_name: 'Addition', team: 'Penguins' }, '/admin/players/new');
  const late = await h.db.one(`SELECT id FROM players WHERE last_name = 'Addition'`);
  await h.post(admin, '/season', { season_id: String(s1.id) });
  await h.post(admin, `/admin/players/${late.id}`, { first_name: 'Late', last_name: 'Addition', active: 'on', on_roster: 'on', team: 'Penguins' }, `/admin/players/${late.id}/edit`);
  assert.strictEqual((await rater.get(`/players/${late.id}/rate`)).status, 403);

  // Seasons with ratings can't be deleted
  await h.post(admin, `/admin/seasons/${s2.id}/delete`, {}, '/admin/seasons');
  assert.ok(await h.db.one('SELECT id FROM seasons WHERE id = $1', [s2.id]));
});

test('duplicates: merge combines rosters and IDs, keeps one rating per rater per season', async () => {
  await h.createUser({ email: 'm-admin@test.com', name: 'Merge Admin', role: 'admin' });
  const r1 = await h.createUser({ email: 'm-r1@test.com', name: 'Rater One' });
  const r2 = await h.createUser({ email: 'm-r2@test.com', name: 'Rater Two' });
  const admin = await h.login(app, 'm-admin@test.com');
  const season = await h.db.one('SELECT * FROM seasons WHERE is_current');
  const { upsertPlayers } = require('../src/lib/players');
  await h.db.tx((c) => upsertPlayers([
    { first_name: 'Robert', last_name: 'Merge', team: 'Hawks', jersey_number: '4', birth_date: '1980-02-02', external_id: 'se:1001' },
    { first_name: 'Bobby', last_name: 'Merge', team: 'Owls', jersey_number: '44', is_sub: 'yes', birth_date: '1980-02-02', external_id: 'se:2002' },
    { first_name: 'Dana', last_name: 'Twin', birth_date: '1990-01-01', team: 'Hawks' },
    { first_name: 'Dana', last_name: 'Twin', birth_date: '2001-01-01', team: 'Owls' }, // different person
    { first_name: 'Dana', last_name: 'Twin' }, // which one? ambiguous → new record, flagged
  ], 'import', season.id, c));
  assert.strictEqual((await h.db.one(`SELECT count(*)::int AS n FROM players WHERE last_name = 'Twin'`)).n, 3);
  const robert = await h.db.one(`SELECT ${h.byExt('se:1001')} AS id`);
  const bobby = await h.db.one(`SELECT ${h.byExt('se:2002')} AS id`);
  assert.notStrictEqual(robert.id, bobby.id, 'different first names are not auto-merged');

  // Both records rated by Rater One; only Bobby by Rater Two
  const R = require('../src/lib/ratings');
  const cats = await R.getCategories();
  const scores = (n) => cats.map((c) => ({ category_id: c.id, score: n, comment: null }));
  const data = { independent_level: 'C2', game_performance: 'usually', final_level: 'C2', age_areas: [], injury_affects: [] };
  await h.db.tx((c) => R.createRating(c, season.id, robert.id, r1.id, data, scores(5)));
  await h.db.query(`UPDATE ratings SET created_at = now() - interval '1 day'`); // Robert's is older
  await h.db.tx((c) => R.createRating(c, season.id, bobby.id, r1.id, data, scores(9)));
  await h.db.tx((c) => R.createRating(c, season.id, bobby.id, r2.id, data, scores(7)));

  // Duplicates page suggests the pair (same last name + DOB) and the Dana Twin pair (missing DOB)
  const dups = await admin.get('/admin/duplicates');
  assert.match(dups.text, /Same last name and date of birth/);
  assert.match(dups.text, /Same name, a date of birth is missing/);

  const merged = await h.post(admin, '/admin/players/merge', { keep_id: String(robert.id), drop_id: String(bobby.id) }, '/admin/duplicates');
  assert.strictEqual(merged.status, 302);
  assert.strictEqual(await h.db.one('SELECT id FROM players WHERE id = $1', [bobby.id]), null);
  const ratings = await h.db.many('SELECT rater_id, (SELECT min(score) FROM rating_scores rs WHERE rs.rating_id = r.id) AS score FROM ratings r WHERE player_id = $1 ORDER BY rater_id', [robert.id]);
  assert.deepStrictEqual(ratings.map((r) => [r.rater_id, r.score]), [[r1.id, 5], [r2.id, 7]], 'earlier rating kept for the clash, other rater moved over');
  const spots = await h.db.many(`${h.SPOTS} WHERE p.id = $1 ORDER BY t.name`, [robert.id]);
  assert.deepStrictEqual(spots.map((s) => `${s.team} #${s.jersey_number}${s.is_sub ? ' sub' : ''}`), ['Hawks #4', 'Owls #44 sub']);
  assert.deepStrictEqual(spots[0].external_ids, ['se:1001', 'se:2002']);
  const log = await h.db.one(`SELECT details FROM audit_log WHERE action = 'players_merged'`);
  assert.strictEqual(log.details.ratingsDropped.length, 1);

  // A later import with Bobby's registration ID lands on Robert
  const again = await h.db.tx((c) => upsertPlayers([{ first_name: 'Bobby', last_name: 'Merge', external_id: 'se:2002', team: 'Owls' }], 'import', season.id, c));
  assert.strictEqual(again.updated, 1);

  // "Different people" hides a pair
  const pairsWithTwin = async () => ((await admin.get('/admin/duplicates')).text.match(/class="card dup-pair"[\s\S]*?Dana Twin/g) || []).length;
  assert.strictEqual(await pairsWithTwin(), 2);
  const twins = await h.db.many(`SELECT id FROM players WHERE last_name = 'Twin' ORDER BY id`);
  await h.post(admin, '/admin/duplicates/distinct', { a: String(twins[0].id), b: String(twins[2].id) }, '/admin/duplicates');
  assert.strictEqual(await pairsWithTwin(), 1);
});

test('bulk merge of exact matches cleans up records created before identity matching', async () => {
  await h.createUser({ email: 'b-admin@test.com', name: 'Bulk Admin', role: 'admin' });
  const admin = await h.login(app, 'b-admin@test.com');
  // Simulate the old import: two records for one person, one with "(Sub)" in the stored name.
  const a = await h.db.one(`INSERT INTO players (first_name, last_name, birth_date, source) VALUES ('Raza', 'Hassan', '1960-10-12', 'sportsengine') RETURNING id`);
  const b = await h.db.one(`INSERT INTO players (first_name, last_name, birth_date, source) VALUES ('Raza', 'Hassan (Sub)', '1960-10-12', 'sportsengine') RETURNING id`);
  await h.db.query(`INSERT INTO player_external_ids (player_id, external_id) VALUES ($1, 'se:79249232'), ($2, 'se:79380718')`, [a.id, b.id]);
  await require('../src/lib/identity').backfillNameKeys();

  const page = await admin.get('/admin/duplicates');
  assert.match(page.text, /Merge all exact matches/);
  await h.post(admin, '/admin/duplicates/merge-exact', {}, '/admin/duplicates');
  const left = await h.db.many(`SELECT p.id, p.last_name, array_agg(x.external_id ORDER BY x.external_id) AS ids
                                   FROM players p JOIN player_external_ids x ON x.player_id = p.id
                                  WHERE p.first_name = 'Raza' GROUP BY p.id`);
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].id, a.id, 'keeps the record without the (Sub) tag');
  assert.strictEqual(left[0].last_name, 'Hassan');
  assert.deepStrictEqual(left[0].ids, ['se:79249232', 'se:79380718']);
});

test('viewer role: request, approve, browse everything, but never rate or modify', async () => {
  await h.createUser({ email: 'v-admin@test.com', name: 'View Admin', role: 'admin' });
  const admin = await h.login(app, 'v-admin@test.com');

  // A season with a rated player, so there is something to view
  await h.post(admin, '/admin/players', { first_name: 'Vic', last_name: 'Viewable', team: 'Owls', division: 'D2', jersey_number: '8' }, '/admin/players/new');
  const vic = await h.db.one(`SELECT id FROM players WHERE last_name = 'Viewable'`);
  await h.post(admin, `/players/${vic.id}/rate`, fullRating());

  // Request access: role choice required
  const anon = h.request.agent(app);
  const reg = await anon.get('/register');
  assert.match(reg.text, /name="requested_role" value="rater"/);
  assert.match(reg.text, /name="requested_role" value="viewer"/);
  const noRole = await anon.post('/register').type('form').send({
    _csrf: h.csrfFrom(reg.text), name: 'Val Viewer', email: 'val@test.com', password: 'Slapshot!Goal47', password_confirm: 'Slapshot!Goal47',
  });
  assert.strictEqual(noRole.status, 422);
  assert.match(noRole.text, /Choose Rater or Viewer access/);
  await anon.post('/register').type('form').send({
    _csrf: h.csrfFrom(reg.text), name: 'Val Viewer', email: 'val@test.com', password: 'Slapshot!Goal47', password_confirm: 'Slapshot!Goal47', requested_role: 'viewer',
  });
  const val = await h.db.one(`SELECT * FROM users WHERE email = 'val@test.com'`);
  assert.deepStrictEqual([val.role, val.requested_role, val.status], ['viewer', 'viewer', 'pending']);
  const alert = [...h.mailer.outbox].reverse().find((m) => /Access request: Val Viewer/.test(m.subject));
  assert.match(alert.text, /requested Viewer \(view only\) access/);

  // Admin sees the request and approves as a viewer
  const users = await admin.get('/admin/users');
  assert.match(users.text, /Requested:<\/strong> Viewer access/);
  assert.match(users.text, /Approve as Viewer/);
  await h.post(admin, `/admin/users/${val.id}/approve-viewer`, {}, '/admin/users');
  assert.strictEqual((await h.db.one('SELECT role, status FROM users WHERE id = $1', [val.id])).status, 'approved');
  const approved = [...h.mailer.outbox].reverse().find((m) => m.to === 'val@test.com' && /approved/.test(m.subject));
  assert.match(approved.text, /Viewer access/);

  // Viewer can browse leagues, teams, players and ratings
  const viewer = await h.login(app, 'val@test.com', 'Slapshot!Goal47');
  const leagues = await viewer.get('/players');
  assert.strictEqual(leagues.status, 200);
  assert.match(leagues.text, /league-crest">D2</);
  assert.doesNotMatch(leagues.text, /By you|You've rated|haven't rated/);
  const owls = await h.db.one(`SELECT id FROM teams WHERE name = 'Owls'`);
  const team = await viewer.get(`/teams/${owls.id}`);
  assert.match(team.text, /Viewable, Vic/);
  assert.doesNotMatch(team.text, /\/rate"/, 'no Rate buttons');
  const playerPage = await viewer.get(`/players/${vic.id}`);
  assert.match(playerPage.text, /Submitted ratings/);
  assert.match(playerPage.text, /6\.80/, 'sees the average');
  assert.doesNotMatch(playerPage.text, /Rate this player|Edit player|Edit rating/);
  assert.match((await viewer.get('/players?q=vic')).text, /Viewable, Vic/);
  assert.strictEqual((await viewer.get(`/reports/teams?team=${owls.id}`)).status, 200);

  // …but can't rate or reach admin
  const rateForm = await viewer.get(`/players/${vic.id}/rate`);
  assert.strictEqual(rateForm.status, 403);
  assert.match(rateForm.text, /Viewer access/);
  assert.strictEqual((await h.post(viewer, `/players/${vic.id}/rate`, fullRating())).status, 403);
  assert.strictEqual((await h.db.one('SELECT count(*)::int AS n FROM ratings WHERE player_id = $1', [vic.id])).n, 1);
  assert.strictEqual((await viewer.get('/admin')).status, 403);
  assert.strictEqual((await h.post(viewer, '/admin/players', { first_name: 'X', last_name: 'Y' })).status, 403);
  const account = await viewer.get('/account');
  assert.match(account.text, /Viewer \(view only\)/);
  assert.doesNotMatch(account.text, /My ratings/);

  // Admin can switch roles both ways
  await h.post(admin, `/admin/users/${val.id}/make-rater`, {}, '/admin/users');
  assert.strictEqual((await viewer.get(`/players/${vic.id}/rate`)).status, 200, 'takes effect on the next request');
  await h.post(admin, `/admin/users/${val.id}/make-viewer`, {}, '/admin/users');
  assert.strictEqual((await viewer.get(`/players/${vic.id}/rate`)).status, 403);
});
