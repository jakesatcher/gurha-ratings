'use strict';

// Public (signed-out) pages: name search, a player's teams/numbers/rating only, and the contest form.
const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

let app;
let admin;
let OVERALL;
const ids = {};

test.before(async () => {
  await h.resetDb();
  app = h.createApp();
  OVERALL = (await h.db.one(`SELECT id FROM categories WHERE key = 'overall'`)).id;
  await h.createUser({ email: 'pub-admin@test.com', name: 'Pub Admin', role: 'admin' });
  admin = await h.login(app, 'pub-admin@test.com');
  const add = (first, last, team, jersey, extra = {}) =>
    h.post(admin, '/admin/players', { first_name: first, last_name: last, team, division: 'C1', jersey_number: jersey, birth_date: '1980-02-02', email: `${first}@private.test`, notes: 'secret admin note', ...extra }, '/admin/players/new');
  await add('Wayne', 'Gretzky', 'Oilers', '99');
  await add('Mario', 'Lemieux', 'Penguins', '66');
  await add('Hidden', 'Inactive', 'Penguins', '1');
  await add('Under_Score', 'Percent%Name', 'Penguins', '5');
  for (const p of await h.db.many('SELECT id, last_name FROM players')) ids[p.last_name] = p.id;
  await h.db.query('UPDATE players SET active = false WHERE id = $1', [ids.Inactive]);
  // Wayne on a second team as a sub
  const pg = await admin.get(`/admin/players/${ids.Gretzky}/edit`);
  const spot = (await h.db.one(`SELECT tr.id FROM team_rosters tr JOIN season_players sp ON sp.id = tr.season_player_id WHERE sp.player_id = $1`, [ids.Gretzky])).id;
  await admin.post(`/admin/players/${ids.Gretzky}`).type('form').send({
    _csrf: h.csrfFrom(pg.text), first_name: 'Wayne', last_name: 'Gretzky', active: 'on', on_roster: 'on', membership_ids: String(spot), [`m_${spot}_jersey`]: '99',
    team: 'Penguins', jersey_number: '19', is_sub: 'on', birth_date: '1980-02-02',
  });
  await h.post(admin, `/players/${ids.Gretzky}/rate`, { [`score_${OVERALL}`]: 'B1/A2:M', evidence: 'PRIVATE COMMENT from a rater' });
  // A rater-added placeholder is not public
  const team = await h.db.one(`SELECT id FROM teams WHERE name = 'Penguins'`);
  await h.post(admin, `/teams/${team.id}/add-player`, { number: '77', note: 'unknown guy' }, `/teams/${team.id}/add-player`);
});

test.after(async () => {
  await h.db.pool.end();
});

const anon = () => h.request.agent(app);

test('landing page: name search without signing in, and no session is started', async () => {
  const res = await h.request(app).get('/');
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /name="q"/);
  assert.match(res.text, /href="\/login"[^>]*>Sign in/);
  assert.ok(!res.headers['set-cookie'], 'browsing publicly does not create a session');
  const signedIn = await admin.get('/');
  assert.strictEqual(signedIn.headers.location, '/players', 'signed-in users go to the full app');
});

test('search shows only name, teams, jersey numbers and rating', async () => {
  const res = await h.request(app).get('/?q=gretz');
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /Gretzky, Wayne/);
  assert.match(res.text, /Oilers #99 · Penguins #19 \(sub\)/);
  assert.match(res.text, /level-ba">B1\/A2<\/span>\s*<strong>13\.00<\/strong>/);
  for (const leak of [/PRIVATE COMMENT/, /secret admin note/, /private\.test/, /1980/, /Age \d/, /\b1 rating\b|ratings?\)/i, /Rater/, /Low|Medium|High|0–15/, /Ice Dogs/]) {
    assert.doesNotMatch(res.text, leak);
  }
  // Last-name-first and partial matches work; unrated players say so
  assert.match((await h.request(app).get('/?q=lemieux, mar')).text, /Lemieux, Mario[\s\S]*Not rated yet/);
  // Inactive players and rater-added placeholders are not listed
  assert.doesNotMatch((await h.request(app).get('/?q=inactive')).text, /Inactive, Hidden/);
  assert.doesNotMatch((await h.request(app).get('/?q=unlisted')).text, /Unlisted/);
});

test('search text is never SQL: injection attempts and wildcards are treated as literal text', async () => {
  for (const q of ["' OR 1=1 --", "x'; DROP TABLE players; --", "%", "_", "%%", "\\", "' UNION SELECT email, password_hash FROM users --", "\u0000"]) {
    const res = await h.request(app).get('/').query({ q });
    assert.strictEqual(res.status, 200, `q=${JSON.stringify(q)}`);
    assert.doesNotMatch(res.text, /Gretzky|Lemieux/, `q=${JSON.stringify(q)} must not match everyone`);
    assert.doesNotMatch(res.text, /\$2[aby]\$|pub-admin@test\.com/, 'no data from other tables');
  }
  assert.ok(await h.db.one('SELECT count(*) FROM players'), 'players table still there');
  // A literal % or _ in a real name is still findable
  assert.match((await h.request(app).get('/').query({ q: 'percent%' })).text, /Percent%Name, Under_Score/);
  assert.match((await h.request(app).get('/').query({ q: 'under_s' })).text, /Percent%Name, Under_Score/);
  // Search text is HTML-escaped when echoed back
  const xss = await h.request(app).get('/').query({ q: '<script>alert(1)</script>' });
  assert.doesNotMatch(xss.text, /<script>alert\(1\)<\/script>/);
  assert.match(xss.text, /&lt;script&gt;/);
  // Over-long input is cut short, not passed through
  assert.strictEqual((await h.request(app).get('/').query({ q: 'a'.repeat(5000) })).status, 200);
});

test('public player page: teams, numbers, rating and a Contest rating button only', async () => {
  const res = await h.request(app).get(`/player/${ids.Gretzky}`);
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /Wayne Gretzky/);
  assert.match(res.text, /Oilers #99/);
  assert.match(res.text, /href="\/player\/\d+\/contest">Contest rating/);
  assert.doesNotMatch(res.text, /PRIVATE COMMENT|secret admin note|private\.test|1980|Submitted ratings|Season history/);
  assert.ok(!res.headers['set-cookie']);
  for (const bad of [`/player/${ids.Inactive}`, '/player/999999', "/player/1%20OR%201=1", '/player/abc']) {
    assert.strictEqual((await h.request(app).get(bad)).status, 404, bad);
  }
  // The signed-in app is still private
  assert.strictEqual((await h.request(app).get(`/players/${ids.Gretzky}`)).headers.location, '/login');
});

test('contest form: CSRF, validation, header/HTML injection, honeypot, then the admins are emailed', async () => {
  const visitor = anon();
  const url = `/player/${ids.Gretzky}/contest`;
  const form = await visitor.get(url);
  assert.strictEqual(form.status, 200);
  const csrf = h.csrfFrom(form.text);
  const send = (data) => visitor.post(url).type('form').send({ _csrf: csrf, ...data });
  const good = { name: 'Pat Parent', email: 'pat@example.com', relationship: 'I am this player', message: "I've moved down a league and haven't played in two years." };
  const count = async () => (await h.db.one('SELECT count(*)::int AS n FROM rating_contests')).n;

  // No CSRF token
  assert.strictEqual((await h.request(app).post(url).type('form').send(good)).status, 403);
  // Missing fields
  const empty = await send({ name: '', email: '', message: 'short' });
  assert.strictEqual(empty.status, 422);
  assert.match(empty.text, /Enter your name[\s\S]*valid email[\s\S]*at least 20 characters/);
  // Email header injection
  const hdr = await send({ ...good, email: 'pat@example.com\r\nBcc: victim@example.com' });
  assert.strictEqual(hdr.status, 422);
  assert.strictEqual((await send({ ...good, email: 'Pat <pat@example.com>, other@example.com' })).status, 422);
  // Script / HTML injection
  const xss = await send({ ...good, name: '<script>alert(1)</script>' });
  assert.strictEqual(xss.status, 422);
  assert.doesNotMatch(xss.text, /<script>alert\(1\)<\/script>/, 'echoed values are escaped');
  assert.strictEqual((await send({ ...good, message: 'Click <a href="javascript:alert(1)">here</a> please now ok' })).status, 422);
  // Honeypot: looks like success, stores nothing
  const bot = await send({ ...good, website: 'http://spam.example' });
  assert.strictEqual(bot.status, 302);
  assert.strictEqual(await count(), 0);

  const before = h.mailer.outbox.length;
  const ok = await send({ ...good, message: "Robert'); DROP TABLE ratings;-- <b>bold</b> & \"quotes\" — I play D now." });
  assert.strictEqual(ok.status, 302);
  assert.strictEqual(ok.headers.location, `/player/${ids.Gretzky}`);
  assert.match((await visitor.get(ok.headers.location)).text, /sent to the GURHA admins/);
  const row = await h.db.one('SELECT * FROM rating_contests');
  assert.deepStrictEqual([row.player_id, row.name, row.email, row.relationship, row.status], [ids.Gretzky, 'Pat Parent', 'pat@example.com', 'I am this player', 'open']);
  assert.match(row.message, /DROP TABLE ratings;-- <b>bold<\/b>/, 'stored as plain text');
  assert.ok(await h.db.one('SELECT count(*) FROM ratings'), 'ratings table untouched');

  const mail = h.mailer.outbox.slice(before).find((m) => /Rating contest: Wayne Gretzky/.test(m.subject));
  assert.ok(mail, 'admin alerted');
  assert.strictEqual(mail.to, 'pub-admin@test.com');
  assert.strictEqual(mail.replyTo, 'pat@example.com');
  assert.match(mail.html, /&lt;b&gt;bold&lt;\/b&gt;/);
  assert.doesNotMatch(mail.html, /<b>bold<\/b>/);

  // Admin reviews it: content escaped, then resolved
  const page = await admin.get('/admin/contests');
  assert.match(page.text, /Wayne Gretzky/);
  assert.match(page.text, /&lt;b&gt;bold&lt;\/b&gt;/);
  assert.doesNotMatch(page.text, /<b>bold<\/b>/);
  await h.post(admin, `/admin/contests/${row.id}`, { action: 'resolve', admin_note: 'Rating stays; reviewed game footage.' }, '/admin/contests');
  const done = await h.db.one('SELECT status, admin_note FROM rating_contests WHERE id = $1', [row.id]);
  assert.deepStrictEqual([done.status, done.admin_note], ['resolved', 'Rating stays; reviewed game footage.']);
  assert.match((await admin.get('/admin')).text, /Open contests/);
  // Non-admins can't see contests
  await h.createUser({ email: 'pub-rater@test.com', name: 'Pub Rater' });
  assert.strictEqual((await (await h.login(app, 'pub-rater@test.com')).get('/admin/contests')).status, 403);
});

test('cleanText strips control and invisible characters; LIKE text is escaped', () => {
  const { cleanText, likeLiteral } = require('../src/routes/public');
  assert.strictEqual(cleanText('  Pat\u0000\r\nParent‮ ', 100), 'Pat Parent');
  assert.strictEqual(cleanText('line1\r\n\r\n\r\n\r\nline2\u0007', 100, { multiline: true }), 'line1\n\nline2');
  assert.strictEqual(likeLiteral('50%_off\\'), '50\\%\\_off\\\\');
});
