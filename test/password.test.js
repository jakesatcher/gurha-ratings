'use strict';

const test = require('node:test');
const assert = require('node:assert');
const policy = require('../public/js/password-policy');
const h = require('./helpers');

test('password policy rules', () => {
  const ok = (pw) => assert.deepStrictEqual(policy.check(pw), [], `${pw} should pass`);
  const bad = (pw, re) => assert.match(policy.check(pw).join(' '), re, `${pw} should fail with ${re}`);
  ok('Slapshot!Goal47');
  ok('AAbbCC!!1122xy'); // pairs are fine
  ok('Goalie#12!xQz'); // two in sequence is fine
  bad('Sh0rt!Pw', /at least 12 characters/);
  bad('alllowercase!7x', /capital letter/);
  bad('ALLUPPERCASE!7X', /lowercase letter/);
  bad('NoNumbersHere!x', /at least 1 number/);
  bad('NoSpecial1Zx9Q', /special character/); // 14 characters: special required

  // Browser / password-manager suggestions (15+ characters): special optional, 3-sequences allowed
  ok('Hk7pTq2mWx9ZbRn'); // Chrome-style: 15 letters and digits
  ok('wapcyp-6Fymvu-hakfez'); // Safari / iCloud Keychain style
  ok('Xyz7pTq2mWx9ZbRn'); // a 3-letter run is fine at this length
  bad('Abcd7pTq2mWx9ZbR', /more than 3 letters or numbers in sequence \("abcd"\)/);
  bad('Hk7pTq2mWx91234n', /"1234"/);
  bad('Hk7pTqqq2mWx9ZbR', /"qqq"/); // repeats still limited
  bad('Hk7pTq2mWx9Z<bR1', /aren't allowed/); // blocked characters still blocked
  bad('hk7ptq2mwx9zbrnq', /capital letter/); // upper/lower/digit still required
  assert.match(policy.PASSWORDRULES, /^minlength: 15; maxlength: 128; required: upper; required: lower; required: digit;/);
  assert.match(policy.PASSWORDRULES, /max-consecutive: 2;$/);
  for (const ch of ['<', '>', "'", '"', '`', ';', '\\', '/', '&', '=', '%', '(', ')', '{', '}', '[', ']', '|', ' ']) {
    bad(`Goalie!7xQz${ch}Ab`, /aren't allowed/);
  }
  bad('Goal--Line!9Xz', /two dashes/);
  bad('Puckaaa!Goal7', /more than twice in a row \("aaa"\)/);
  bad('PuckAaA!Goal7', /repeat a character/); // case-insensitive
  bad('Goal!1117xQzw', /"111"/);
  bad('Goalie#abc!9X', /in sequence \("abc"\)/);
  bad('Goalie#CBA!9x', /in sequence \("cba"\)/);
  bad('Goalie#123!xQ', /"123"/);
  bad('Goalie#987!xQ', /"987"/);
  assert.strictEqual(policy.RULES.length, 8);
});

let app;
test.before(async () => {
  await h.resetDb();
  app = h.createApp();
});
test.after(async () => {
  await h.db.pool.end();
});

test('request access shows the requirements and rejects weak passwords', async () => {
  const agent = h.request.agent(app);
  const page = await agent.get('/register');
  assert.match(page.text, /Password requirements/);
  assert.match(page.text, /At least 12 characters/);
  assert.match(page.text, /No more than 2 letters or numbers in sequence/);
  assert.match(page.text, /password-policy\.js/);
  assert.match(page.text, /autocomplete="new-password"[^>]*passwordrules="minlength: 15;/, 'browsers get the rules for generated passwords');
  const res = await agent.post('/register').type('form').send({
    _csrf: h.csrfFrom(page.text), name: 'Weak', email: 'weak@test.com', password: "Rob<script>123", password_confirm: "Rob<script>123",
  });
  assert.strictEqual(res.status, 422);
  assert.match(res.text, /aren(&#39;|')t allowed: &lt; &gt;/, 'blocked characters are named (escaped)');
  assert.match(res.text, /special character/);
  assert.match(res.text, /in sequence \(&#34;123&#34;\)|in sequence \("123"\)/);
  assert.strictEqual(await h.db.one(`SELECT id FROM users WHERE email = 'weak@test.com'`), null);
});

test('existing users with a weak password must choose a new one after signing in', async () => {
  await h.createUser({ email: 'legacy@test.com', name: 'Legacy', password: 'password1234' });
  const agent = h.request.agent(app);
  const lp = await agent.get('/login');
  await agent.post('/login').type('form').send({ _csrf: h.csrfFrom(lp.text), email: 'legacy@test.com', password: 'password1234' });
  // first-time MFA setup via email code
  const setup = await agent.get('/mfa/setup');
  await agent.post('/mfa/setup/email').type('form').send({ _csrf: h.csrfFrom(setup.text) });
  const verify = await agent.get('/mfa/setup/email');
  const done = await agent.post('/mfa/setup/email/verify').type('form').send({ _csrf: h.csrfFrom(verify.text), code: h.lastCodeFor('legacy@test.com') });
  assert.strictEqual(done.headers.location, '/account/new-password');

  // Everything else redirects until the password is updated
  assert.strictEqual((await agent.get('/players')).headers.location, '/account/new-password');
  const form = await agent.get('/account/new-password');
  assert.match(form.text, /requires stronger passwords/);
  assert.match(form.text, /Password requirements/);
  const weak = await agent.post('/account/new-password').type('form').send({ _csrf: h.csrfFrom(form.text), password: 'stillweak', password_confirm: 'stillweak' });
  assert.strictEqual(weak.status, 422);
  const good = await agent.post('/account/new-password').type('form').send({ _csrf: h.csrfFrom(form.text), password: 'Breakaway!Goal58', password_confirm: 'Breakaway!Goal58' });
  assert.strictEqual(good.headers.location, '/players');
  assert.strictEqual((await agent.get('/players')).status, 200);

  // The new password works; the old one doesn't
  const again = h.request.agent(app);
  const lp2 = await again.get('/login');
  assert.strictEqual((await again.post('/login').type('form').send({ _csrf: h.csrfFrom(lp2.text), email: 'legacy@test.com', password: 'password1234' })).status, 401);
  assert.strictEqual((await again.post('/login').type('form').send({ _csrf: h.csrfFrom(lp2.text), email: 'legacy@test.com', password: 'Breakaway!Goal58' })).status, 302);
});

test('password change and reset enforce the policy', async () => {
  await h.createUser({ email: 'changer@test.com', name: 'Changer' });
  const agent = await h.login(app, 'changer@test.com');
  await h.post(agent, '/account/password', { current_password: 'Slapshot!Goal47', password: 'Goalie#abc!9X', password_confirm: 'Goalie#abc!9X' }, '/account');
  assert.match((await agent.get('/account')).text, /in sequence/);

  const anon = h.request.agent(app);
  const f = await anon.get('/forgot');
  await anon.post('/forgot').type('form').send({ _csrf: h.csrfFrom(f.text), email: 'changer@test.com' });
  const msg = [...h.mailer.outbox].reverse().find((m) => m.to === 'changer@test.com' && /Reset/.test(m.subject));
  const link = /\/reset\/[A-Za-z0-9_-]+/.exec(msg.text)[0];
  const page = await anon.get(link);
  assert.match(page.text, /Password requirements/);
  const res = await anon.post(link).type('form').send({ _csrf: h.csrfFrom(page.text), password: 'short', password_confirm: 'short' });
  assert.strictEqual(res.status, 422);
  assert.match(res.text, /at least 12 characters/);
});
