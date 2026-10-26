'use strict';

const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

const ALREADY = 'You already rated this player. If you feel this is an error, or would like to change your rating, please contact an Admin';

function fullRating(overrides = {}) {
  return {
    // One overall rating: D1/C2 Medium = 7 points
    [S]: 'D1/C2:M',
    evidence: 'Good skater',
    ...overrides,
  };
}

let app;
// The single "Overall rating" category (the six old categories are inactive).
let OVERALL;
let S;

test.before(async () => {
  await h.resetDb();
  app = h.createApp();
  OVERALL = (await h.db.one(`SELECT id FROM categories WHERE key = 'overall'`)).id;
  S = `score_${OVERALL}`;
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
  const outOfRange = await h.post(raterAgent, `/players/${player.id}/rate`, fullRating({ [S]: 'D1/C2:X' }));
  assert.strictEqual(outOfRange.status, 422);

  // Rate
  const rate = await h.post(raterAgent, `/players/${player.id}/rate`, fullRating());
  assert.strictEqual(rate.status, 302);

  // Duplicate submission → exact error message
  const dup = await h.post(raterAgent, `/players/${player.id}/rate`, fullRating({ [S]: 'A' }));
  assert.strictEqual(dup.status, 409);
  assert.ok(dup.text.includes(ALREADY), 'duplicate POST shows required message');
  const dupGet = await raterAgent.get(`/players/${player.id}/rate`);
  assert.strictEqual(dupGet.status, 409);
  assert.ok(dupGet.text.includes(ALREADY), 'revisiting the form shows required message');
  assert.strictEqual((await h.db.one('SELECT count(*)::int AS n FROM ratings')).n, 1);

  // Player page shows the average (7.00 → D1/C2), the chosen grade, and no separate categories
  const show = await raterAgent.get(`/players/${player.id}`);
  assert.match(show.text, /7\.00/);
  assert.match(show.text, /level-dc[^>]*>D1\/C2</);
  assert.match(show.text, /D1\/C2<\/span>\s*Medium/);
  assert.doesNotMatch(show.text, /Skating|Puck Skills/);
  assert.match(show.text, /Comments/);
  assert.match(show.text, /Good skater/);
  assert.doesNotMatch(show.text, /Rater recommendation|Observation notes/);
  assert.doesNotMatch(show.text, /Game performance|Independent level/);

  // Rater cannot edit ratings
  const rating = await h.db.one('SELECT id FROM ratings');
  assert.strictEqual((await h.post(raterAgent, `/admin/ratings/${rating.id}`, fullRating({ [S]: 'C1/B2:H' }))).status, 403);

  // Admin can edit; audit is recorded
  const edit = await h.post(adminAgent, `/admin/ratings/${rating.id}`, fullRating({ [S]: 'C1/B2:M', admin_reason: 'Rater asked' }), `/admin/ratings/${rating.id}/edit`);
  assert.strictEqual(edit.status, 302);
  const edited = await h.db.one('SELECT score, grade FROM rating_scores WHERE rating_id = $1 AND category_id = $2', [rating.id, OVERALL]);
  assert.deepStrictEqual([Number(edited.score), edited.grade], [10, 'C1/B2:M']);
  const log = await h.db.one(`SELECT details FROM audit_log WHERE action = 'rating_updated'`);
  assert.strictEqual(log.details.reason, 'Rater asked');

  // Second rater differs by 2+ levels → flagged for third review
  await h.createUser({ email: 'second@test.com', name: 'Second' });
  const second = await h.login(app, 'second@test.com');
  const r2 = await h.post(second, `/players/${player.id}/rate`, fullRating({ [S]: 'D3:M' }));
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
  assert.match(csv.text, /avg_overall/);

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
  assert.strictEqual((await h.post(rater, `/players/${sid.id}/rate`, fullRating({ [S]: 'D2:H' }))).status, 302);

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
  const rerate = await h.post(rater, `/players/${sid.id}/rate`, fullRating({ season_id: String(s2.id), [S]: 'D1/C2:H' }));
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
  const data = { final_level: 'D2', age_areas: [], injury_affects: [] };
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
  assert.deepStrictEqual(ratings.map((r) => [r.rater_id, Number(r.score)]), [[r1.id, 5], [r2.id, 7]], 'earlier rating kept for the clash, other rater moved over');
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
  assert.match(playerPage.text, /7\.00/, 'sees the average');
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

test('paper forms: admin prints a multi-player sheet and enters it; paper raters cannot sign in', async () => {
  await h.createUser({ email: 'pf-admin@test.com', name: 'Paper Admin', role: 'admin' });
  const admin = await h.login(app, 'pf-admin@test.com');
  for (const [first, last, jersey] of [['Pat', 'Paperson', '4'], ['Quinn', 'Quill', '9'], ['Rae', 'Ream', '12']]) {
    await h.post(admin, '/admin/players', { first_name: first, last_name: last, team: 'Pens', division: 'C1', jersey_number: jersey }, '/admin/players/new');
  }
  await h.post(admin, '/admin/players', { first_name: 'Sam', last_name: 'Subber', team: 'Other', division: 'C1' }, '/admin/players/new');
  const pens = await h.db.one(`SELECT id FROM teams WHERE name = 'Pens'`);
  const ids = Object.fromEntries((await h.db.many(`SELECT id, last_name FROM players WHERE last_name IN ('Paperson', 'Quill', 'Ream', 'Subber')`)).map((p) => [p.last_name, p.id]));

  // Raters and viewers can't reach paper forms
  await h.createUser({ email: 'pf-rater@test.com', name: 'Online Rater' });
  const rater = await h.login(app, 'pf-rater@test.com');
  assert.strictEqual((await rater.get('/admin/paper')).status, 403);
  assert.strictEqual((await h.post(rater, '/admin/paper/forms', { team_ids: String(pens.id) })).status, 403);

  // Team page offers admins a print button; creating a form for one team goes straight to the print view
  assert.match((await admin.get(`/teams/${pens.id}`)).text, /Print paper form/);
  const created = await h.post(admin, '/admin/paper/forms', { team_ids: String(pens.id), blank_rows: '2', guide: '1' }, '/admin/paper');
  assert.strictEqual(created.status, 302);
  const form = await h.db.one('SELECT * FROM paper_forms ORDER BY id DESC LIMIT 1');
  assert.strictEqual(created.headers.location, `/admin/paper/forms/${form.id}/print?guide=1`);
  assert.match(form.code, /^PF-\d{4}$/);
  const print = await admin.get(created.headers.location);
  assert.strictEqual(print.status, 200);
  for (const name of ['Paperson, Pat', 'Quill, Quinn', 'Ream, Rae']) assert.ok(print.text.includes(name), name);
  assert.strictEqual((print.text.match(/write in name/g) || []).length, 2);
  assert.match(print.text, new RegExp(`${form.code}<small>Page 1 of 2`));
  assert.match(print.text, /Rating guide/);
  assert.match((await admin.get('/admin/paper')).text, new RegExp(form.code));

  // Online rating already exists for Ream by the online rater (paper copy for them is skipped)
  await h.post(rater, `/players/${ids.Ream}/rate`, fullRating());

  const enterUrl = `/admin/paper/forms/${form.id}/enter`;
  const enterPage = await admin.get(enterUrl);
  assert.strictEqual(enterPage.status, 200);
  assert.match(enterPage.text, /New paper rater/);
  const row = (i, o = {}) => {
    const out = { [`r${i}_s${OVERALL}`]: '7', [`r${i}_notes`]: 'Solid' };
    for (const [k, v] of Object.entries(o)) out[k === 's' ? `r${i}_s${OVERALL}` : `r${i}_${k}`] = v;
    return out;
  };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const send = (agent, fields, file) => {
    let req = agent.post(enterUrl);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    if (file) req = req.attach('scan', file.buf, { filename: file.name, contentType: file.type });
    return req;
  };

  // Errors: no rater, a partial row, and a number that isn't on the scale; nothing is saved
  const bad = await send(admin, { _csrf: h.csrfFrom(enterPage.text), rater_id: 'new', new_rater_name: '', ...row(0, { s: '' }), ...row(1, { s: '2.5' }) });
  assert.strictEqual(bad.status, 422);
  assert.match(bad.text, /Enter the new paper rater&#39;s name/);
  assert.match(bad.text, /Row 1 \(Pat Paperson\): Overall rating: choose a level/);
  assert.match(bad.text, /Row 2 \(Quinn Quill\): Overall rating: .*2\.5.* isn&#39;t a scale value/);
  assert.strictEqual((await h.db.one('SELECT count(*)::int AS n FROM paper_submissions')).n, 0);

  // Missing CSRF on the multipart form is rejected
  assert.strictEqual((await send(admin, { rater_id: 'new', new_rater_name: 'X', ...row(0) })).status, 403);

  // A bad scan type is rejected
  const badScan = await send(admin, { _csrf: h.csrfFrom(enterPage.text), rater_id: 'new', new_rater_name: 'Paula Pen', ...row(0) }, { buf: Buffer.from('<script>alert(1)</script>'), name: 'x.png', type: 'image/png' });
  assert.strictEqual(badScan.status, 422);
  assert.match(badScan.text, /PDF or a photo/);

  // Good entry for a new paper rater: rows 1, 2 and a write-in (row 4); row 3 left blank
  const ok = await send(admin, {
    _csrf: h.csrfFrom(enterPage.text), rater_id: 'new', new_rater_name: 'Paula Pen', new_rater_email: 'paula@test.com',
    ...row(0), ...row(1, { notes: 'Fades late' }), ...row(3, { player: String(ids.Subber), s: '1.5' }),
  }, { buf: png, name: 'sheet.png', type: 'image/png' });
  assert.strictEqual(ok.status, 302, ok.text);
  const paula = await h.db.one(`SELECT * FROM users WHERE email = 'paula@test.com'`);
  assert.deepStrictEqual([paula.role, paula.status, paula.can_login], ['rater', 'approved', false]);
  const saved = await h.db.many(`SELECT id, player_id, source, evidence, final_level FROM ratings WHERE rater_id = $1 ORDER BY player_id`, [paula.id]);
  assert.deepStrictEqual(saved.map((r) => r.player_id).sort(), [ids.Paperson, ids.Quill, ids.Subber].sort());
  assert.ok(saved.every((r) => r.source === 'paper'));
  const quill = saved.find((r) => r.player_id === ids.Quill);
  assert.deepStrictEqual([quill.evidence, quill.final_level], ['Fades late', null]);
  const subGrade = await h.db.one('SELECT grade, score FROM rating_scores WHERE rating_id = $1 AND category_id = $2', [saved.find((r) => r.player_id === ids.Subber).id, OVERALL]);
  assert.deepStrictEqual([subGrade.grade, Number(subGrade.score)], ['D3:M', 1.5]);
  const sub = await h.db.one('SELECT * FROM paper_submissions WHERE rater_id = $1', [paula.id]);
  assert.strictEqual(sub.scan_type, 'image/png');

  // Detail page lists the entry; scan is served to admins only
  const detail = await admin.get(`/admin/paper/forms/${form.id}`);
  assert.match(detail.text, /Paula Pen/);
  const scan = await admin.get(`/admin/paper/submissions/${sub.id}/scan`);
  assert.strictEqual(scan.status, 200);
  assert.strictEqual(scan.headers['content-type'], 'image/png');
  assert.strictEqual((await rater.get(`/admin/paper/submissions/${sub.id}/scan`)).status, 403);

  // Player page shows it came from paper
  const pat = await admin.get(`/players/${ids.Paperson}`);
  assert.match(pat.text, new RegExp(`paper · <a href="/admin/paper/forms/${form.id}">${form.code}`));

  // Entering the online rater's sheet: Ream is skipped (already rated), Paperson saved
  const page2 = await admin.get(enterUrl);
  const second = await send(admin, { _csrf: h.csrfFrom(page2.text), rater_id: String((await h.db.one(`SELECT id FROM users WHERE email = 'pf-rater@test.com'`)).id), ...row(0), ...row(2) });
  assert.strictEqual(second.status, 302);
  const flashPage = await admin.get(second.headers.location);
  assert.match(flashPage.text, /Saved 1 rating/);
  assert.match(flashPage.text, /Skipped 1 row.*Rae Ream \(row 3\)/);

  // Paper raters can't sign in or reset a password, and don't appear in Users
  const anon = h.request.agent(app);
  const lp = await anon.get('/login');
  const login = await anon.post('/login').type('form').send({ _csrf: h.csrfFrom(lp.text), email: 'paula@test.com', password: '!' });
  assert.notStrictEqual(login.headers.location, '/mfa');
  assert.doesNotMatch((await admin.get('/admin/users')).text, /Paula Pen/);
  assert.match((await admin.get('/admin/paper')).text, /Paula Pen/);

  // A form with entries can't be deleted
  await h.post(admin, `/admin/paper/forms/${form.id}/delete`, {}, '/admin/paper');
  assert.ok(await h.db.one('SELECT id FROM paper_forms WHERE id = $1', [form.id]));

  // The paper rater later requests an account with the same email: same record, ratings kept
  const reg = await anon.get('/register');
  const r = await anon.post('/register').type('form').send({
    _csrf: h.csrfFrom(reg.text), name: 'Paula Pen', email: 'paula@test.com', password: 'Slapshot!Goal47', password_confirm: 'Slapshot!Goal47', requested_role: 'rater',
  });
  assert.strictEqual(r.status, 200);
  const after = await h.db.one(`SELECT id, can_login, status FROM users WHERE email = 'paula@test.com'`);
  assert.deepStrictEqual([after.id, after.can_login, after.status], [paula.id, true, 'pending']);
  assert.strictEqual((await h.db.one('SELECT count(*)::int AS n FROM ratings WHERE rater_id = $1', [paula.id])).n, 3);
});

test('admins change or disqualify ratings only with a reason; disqualified ratings are not counted', async () => {
  await h.createUser({ email: 'dq-admin@test.com', name: 'DQ Admin', role: 'admin' });
  const admin = await h.login(app, 'dq-admin@test.com');
  await h.post(admin, '/admin/players', { first_name: 'Dee', last_name: 'Queue', team: 'Gulls', division: 'D2' }, '/admin/players/new');
  const dee = await h.db.one(`SELECT id FROM players WHERE last_name = 'Queue'`);
  await h.createUser({ email: 'dq-rater@test.com', name: 'Over Rater' });
  const rater = await h.login(app, 'dq-rater@test.com');

  const form = await rater.get(`/players/${dee.id}/rate`);
  assert.match(form.text, /<strong>Ratings should reflect where you think the player is in relation to the league/);
  // One combined rating: a single level scale, no Skating / Puck Skills / … sections
  assert.strictEqual((form.text.match(/class="grade-scale"/g) || []).length, 1);
  assert.match(form.text, /Overall rating/);
  assert.doesNotMatch(form.text, /category-title">[^<]*(Skating|Puck Skills|Shooting)/);
  await h.post(rater, `/players/${dee.id}/rate`, fullRating());
  const rating = await h.db.one('SELECT id FROM ratings WHERE player_id = $1', [dee.id]);

  // Changing a rating needs a reason
  const editUrl = `/admin/ratings/${rating.id}`;
  const noReason = await h.post(admin, editUrl, fullRating({ [S]: 'A' }), `${editUrl}/edit`);
  assert.strictEqual(noReason.status, 422);
  assert.match(noReason.text, /Enter a reason for changing this rating/);
  assert.strictEqual((await h.db.one('SELECT grade FROM rating_scores WHERE rating_id = $1 AND category_id = $2', [rating.id, OVERALL])).grade, 'D1/C2:M');

  // Raters can't disqualify
  assert.strictEqual((await h.post(rater, `${editUrl}/disqualify`, { reason: 'x' })).status, 403);

  // Disqualifying needs a reason
  await h.post(admin, `${editUrl}/disqualify`, { reason: '  ' }, `/players/${dee.id}`);
  assert.strictEqual((await h.db.one('SELECT disqualified_at FROM ratings WHERE id = $1', [rating.id])).disqualified_at, null);

  await h.post(admin, `${editUrl}/disqualify`, { reason: 'Rated a beginner as an A player' }, `/players/${dee.id}`);
  const dq = await h.db.one('SELECT disqualified_at, disqualified_reason FROM ratings WHERE id = $1', [rating.id]);
  assert.ok(dq.disqualified_at);
  assert.strictEqual(dq.disqualified_reason, 'Rated a beginner as an A player');
  const adminView = await admin.get(`/players/${dee.id}`);
  assert.match(adminView.text, /No ratings yet/);
  assert.match(adminView.text, /1 rating was disqualified/);
  assert.match(adminView.text, /Rated a beginner as an A player/);
  assert.match(adminView.text, /Reinstate/);
  const raterView = await rater.get(`/players/${dee.id}`);
  assert.match(raterView.text, /disqualified/);
  assert.doesNotMatch(raterView.text, /Rated a beginner as an A player/, 'reason is admin-only');
  // Still counts as rated, so the rater can't just submit again
  assert.strictEqual((await h.post(rater, `/players/${dee.id}/rate`, fullRating())).status, 409);

  // Reinstating needs a reason too
  await h.post(admin, `${editUrl}/reinstate`, { reason: '' }, `/players/${dee.id}`);
  assert.ok((await h.db.one('SELECT disqualified_at FROM ratings WHERE id = $1', [rating.id])).disqualified_at);
  await h.post(admin, `${editUrl}/reinstate`, { reason: 'Talked to the rater; it was a mix-up' }, `/players/${dee.id}`);
  assert.strictEqual((await h.db.one('SELECT disqualified_at FROM ratings WHERE id = $1', [rating.id])).disqualified_at, null);
  assert.match((await admin.get(`/players/${dee.id}`)).text, /7\.00/);

  const actions = (await h.db.many(`SELECT action, details->>'reason' AS reason FROM audit_log WHERE entity = 'rating' AND entity_id = $1 AND action <> 'rating_created' ORDER BY id`, [rating.id]));
  assert.deepStrictEqual(actions.map((a) => [a.action, a.reason]), [
    ['rating_disqualified', 'Rated a beginner as an A player'],
    ['rating_reinstated', 'Talked to the rater; it was a mix-up'],
  ]);
});

test('migration 011 removes ratings made with separate categories, logging each one', async () => {
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrations', '011_remove_category_ratings.sql'), 'utf8');
  const season = await h.db.one(`INSERT INTO seasons (name) VALUES ('Cleanup Season') RETURNING id`);
  const player = await h.db.one(`INSERT INTO players (first_name, last_name) VALUES ('Clean', 'Up') RETURNING id`);
  const raters = [];
  for (const e of ['c1', 'c2', 'c3']) raters.push((await h.createUser({ email: `${e}@cleanup.test`, name: e })).id);
  const skating = (await h.db.one(`SELECT id FROM categories WHERE key = 'skating'`)).id;
  const mk = async (rater, scale, cat, score, grade) => {
    const r = await h.db.one('INSERT INTO ratings (season_id, player_id, rater_id, scale, evidence) VALUES ($1, $2, $3, $4, $5) RETURNING id', [season.id, player.id, rater, scale, 'note']);
    await h.db.query('INSERT INTO rating_scores (rating_id, category_id, score, grade) VALUES ($1, $2, $3, $4)', [r.id, cat, score, grade]);
    return r.id;
  };
  const oldScale = await mk(raters[0], 1, skating, 9, null); // 0–11 scale
  const oldCats = await mk(raters[1], 2, skating, 8, 'D1/C2:H'); // level scale, by category
  await h.db.query('INSERT INTO rating_scores (rating_id, category_id, score) VALUES ($1, $2, 8)', [oldCats, OVERALL]); // carried-over overall
  const current = await mk(raters[2], 2, OVERALL, 7, 'D1/C2:M');

  await h.db.query(sql);
  const left = (await h.db.many('SELECT id FROM ratings WHERE player_id = $1', [player.id])).map((r) => r.id);
  assert.deepStrictEqual(left, [current]);
  const logged = await h.db.many(`SELECT entity_id, details FROM audit_log WHERE action = 'rating_deleted' AND entity_id = ANY($1::int[]) ORDER BY entity_id`, [[oldScale, oldCats]]);
  assert.deepStrictEqual(logged.map((l) => [l.entity_id, l.details.scale, l.details.player_id]), [[oldScale, '0-11', player.id], [oldCats, 'levels', player.id]]);
  assert.strictEqual(logged[0].details.scores[0].category, 'Skating');
  // Running it again changes nothing
  await h.db.query(sql);
  assert.strictEqual((await h.db.one('SELECT count(*)::int AS n FROM ratings WHERE player_id = $1', [player.id])).n, 1);
});

test('Teams tab: league → team summary with a Score coloured against the league allowance', async () => {
  await h.createUser({ email: 'cap-admin@test.com', name: 'Cap Admin', role: 'admin' });
  const admin = await h.login(app, 'cap-admin@test.com');
  for (const [first, last, sub] of [['Ann', 'One', false], ['Bob', 'Two', false], ['Cal', 'Three', false]]) {
    await h.post(admin, '/admin/players', { first_name: first, last_name: last, team: 'Capitals', division: 'Cap League', is_sub: sub ? 'on' : '' }, '/admin/players/new');
  }
  const caps = await h.db.one(`SELECT id FROM teams WHERE name = 'Capitals'`);
  const ids = Object.fromEntries((await h.db.many(`SELECT id, last_name FROM players WHERE last_name IN ('One', 'Two', 'Three')`)).map((p) => [p.last_name, p.id]));
  // Ann 13 (B1/A2 Medium), Bob 10 (C1/B2 Medium); Cal unrated → Score 23
  await h.post(admin, `/players/${ids.One}/rate`, fullRating({ [S]: 'B1/A2:M' }));
  await h.post(admin, `/players/${ids.Two}/rate`, fullRating({ [S]: 'C1/B2:M' }));

  // Teams tab starts with leagues, like the Players tab
  const leagues = await admin.get('/reports/teams');
  assert.match(leagues.text, /href="\/reports\/leagues\/Cap%20League"/);
  assert.match(leagues.text, /No points limit set/);
  const league = await admin.get('/reports/leagues/Cap%20League');
  assert.match(league.text, /href="\/reports\/teams\?team=\d+"/);
  assert.match(league.text, /team-score score-none[\s\S]*?23\.00/);

  const setCap = async (v) => h.post(admin, '/admin/league-caps', { division: 'Cap League', max_points: v }, '/reports/leagues/Cap%20League');
  const statusAt = async () => /team-score score-(\w+) team-score-big/.exec((await admin.get(`/reports/teams?team=${caps.id}`)).text)[1];
  // Cap = allowance × 1.36
  await setCap('17'); // cap 23.12
  assert.strictEqual(await statusAt(), 'green');
  await setCap('15'); // cap 20.40, 2.60 over
  assert.strictEqual(await statusAt(), 'yellow');
  await setCap('10'); // cap 13.60, 9.40 over
  assert.strictEqual(await statusAt(), 'orange');
  await setCap('8'); // cap 10.88, 12.12 over
  assert.strictEqual(await statusAt(), 'red');
  assert.match((await admin.get('/reports/leagues/Cap%20League')).text, /name="max_points"[^>]*value="8"[\s\S]*Cap: <strong>10\.88/);
  assert.match((await admin.get('/reports/leagues/Cap%20League')).text, /score-red[\s\S]*?23\.00<\/strong><span class="ts-cap"> \/ 10\.88/);
  const summary = await admin.get(`/reports/teams?team=${caps.id}`);
  assert.match(summary.text, /<strong>23\.00<\/strong><span class="ts-cap"> \/ 10\.88/);
  assert.match(summary.text, /12\.12 points over the 10\.88 cap/);
  assert.match(summary.text, /1 unrated count as 0/);
  assert.match(summary.text, /href="\/reports\/leagues\/Cap%20League"/, 'crumbs back to the league');

  // Clearing the limit; only admins can set it
  await setCap('');
  assert.strictEqual(await statusAt(), 'none');
  await h.createUser({ email: 'cap-rater@test.com', name: 'Cap Rater' });
  const rater = await h.login(app, 'cap-rater@test.com');
  assert.strictEqual((await h.post(rater, '/admin/league-caps', { division: 'Cap League', max_points: '99' })).status, 403);
  assert.doesNotMatch((await rater.get('/reports/leagues/Cap%20League')).text, /Allowed points per team<\/strong>/);
});
