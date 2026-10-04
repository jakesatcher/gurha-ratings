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
    _csrf: h.csrfFrom(reg.text), name: 'Riley Rater', email: 'Riley@Test.com', password: 'password1234', password_confirm: 'password1234',
  });
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /Request submitted/);
  assert.ok(h.mailer.outbox.some((m) => m.to === 'admin@test.com' && /Access request/.test(m.subject)));

  // Pending users can't sign in
  const loginPage = await anon.get('/login');
  const pending = await anon.post('/login').type('form').send({ _csrf: h.csrfFrom(loginPage.text), email: 'riley@test.com', password: 'password1234' });
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
  const lr = await raterAgent.post('/login').type('form').send({ _csrf: h.csrfFrom(lp.text), email: 'riley@test.com', password: 'password1234' });
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
  const report = await raterAgent.get('/reports/teams?team=Blue%20Liners');
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
  const res = await agent.post('/admin/import').field('_csrf', csrf).attach('file', Buffer.from(csv), 'roster.csv');
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /<strong>2<\/strong> created/);
  assert.match(res.text, /<strong>1<\/strong> skipped/);

  // Re-import JSON updates rather than duplicates
  const json = JSON.stringify([{ first_name: 'Jane', last_name: 'Doe', team: 'Ice Dogs', jersey_number: '17' }]);
  const res2 = await agent.post('/admin/import').field('_csrf', csrf).attach('file', Buffer.from(json), 'roster.json');
  assert.match(res2.text, /<strong>1<\/strong> updated/);
  const jane = await h.db.one(`SELECT * FROM players WHERE last_name = 'Doe'`);
  assert.strictEqual(jane.jersey_number, '17');
  assert.strictEqual(jane.position, 'D');

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
  await agent.post('/login').type('form').send({ _csrf: h.csrfFrom(lp.text), email: 'otp@test.com', password: 'password1234' });
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
