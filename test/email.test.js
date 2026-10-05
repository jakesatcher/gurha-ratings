'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const h = require('./helpers');
const config = require('../src/config');

// A stand-in for api.resend.com that records requests and can be told to fail.
const resend = { requests: [], plan: [] };
let server;
let app;

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
};

test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      resend.requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      const next = resend.plan.shift() || { status: 200 };
      res.setHeader('Content-Type', 'application/json');
      if (next.retryAfter) res.setHeader('Retry-After', String(next.retryAfter));
      res.statusCode = next.status;
      res.end(JSON.stringify(next.status === 200 ? { id: `re_${resend.requests.length}` } : { statusCode: next.status, message: next.message || 'nope' }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  Object.assign(config.mail, {
    resendApiKey: 're_test_key',
    resendApiUrl: `http://127.0.0.1:${server.address().port}`,
    from: 'GURHA Ratings <ratings@robertmagnusmissesthe.net>',
    replyTo: 'commissioner@robertmagnusmissesthe.net',
    resendWebhookSecret: `whsec_${Buffer.from('super-secret-signing-key').toString('base64')}`,
  });
  await h.resetDb();
  app = h.createApp();
});

test.after(async () => {
  config.mail.resendApiKey = undefined;
  server.closeAllConnections();
  server.close();
  await h.db.pool.end();
});

// Signs in through the email-code flow, reading the code from what was sent to Resend.
async function loginWithResend(email) {
  const agent = h.request.agent(app);
  const page = await agent.get('/login');
  await agent.post('/login').type('form').send({ _csrf: h.csrfFrom(page.text), email, password: 'Slapshot!Goal47' });
  const sent = resend.requests.filter((r) => r.body.to[0] === email).pop();
  const code = /(\d{6})/.exec(sent.body.subject)[1];
  const mfa = await agent.get('/mfa');
  const done = await agent.post('/mfa').type('form').send({ _csrf: h.csrfFrom(mfa.text), code });
  assert.strictEqual(done.status, 302);
  return agent;
}

test('sign-in codes go out through Resend with the right payload, and the log never stores the code', async () => {
  await h.createUser({ email: 'coder@test.com', name: 'Coder' });
  await h.db.query(`UPDATE users SET mfa_method = 'email' WHERE email = 'coder@test.com'`);
  resend.requests.length = 0;
  await loginWithResend('coder@test.com');

  const req = resend.requests[0];
  assert.strictEqual(req.url, '/emails');
  assert.strictEqual(req.headers.authorization, 'Bearer re_test_key');
  assert.ok(req.headers['idempotency-key'], 'idempotency key sent');
  assert.strictEqual(req.body.from, 'GURHA Ratings <ratings@robertmagnusmissesthe.net>');
  assert.deepStrictEqual(req.body.to, ['coder@test.com']);
  assert.strictEqual(req.body.reply_to, 'commissioner@robertmagnusmissesthe.net');
  assert.deepStrictEqual(req.body.tags, [{ name: 'kind', value: 'code_login' }]);
  assert.match(req.body.subject, /^\d{6} is your GURHA Ratings code$/);
  assert.match(req.body.html, /Your sign-in code/);
  assert.match(req.body.text, /expires in 10 minutes/);

  const log = await h.db.one(`SELECT * FROM email_log WHERE kind = 'code_login' ORDER BY id DESC LIMIT 1`);
  assert.strictEqual(log.status, 'sent');
  assert.strictEqual(log.provider, 'resend');
  assert.strictEqual(log.provider_id, 're_1');
  assert.doesNotMatch(log.subject, /\d{6}/);
});

test('retries when Resend rate-limits, then succeeds', async () => {
  await h.createUser({ email: 'retry@test.com', name: 'Retry' });
  await h.db.query(`UPDATE users SET mfa_method = 'email' WHERE email = 'retry@test.com'`);
  resend.requests.length = 0;
  resend.plan.push({ status: 429, retryAfter: 1 });
  await loginWithResend('retry@test.com');
  assert.strictEqual(resend.requests.length, 2);
  assert.strictEqual(resend.requests[0].headers['idempotency-key'], resend.requests[1].headers['idempotency-key'], 'same key on retry');
});

test('if Resend is down, sign-in shows a friendly error and the user can retry right away', async () => {
  await h.createUser({ email: 'down@test.com', name: 'Down' });
  await h.db.query(`UPDATE users SET mfa_method = 'email' WHERE email = 'down@test.com'`);
  resend.plan.push({ status: 500 }, { status: 500 }, { status: 500 });
  const agent = h.request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: h.csrfFrom(page.text), email: 'down@test.com', password: 'Slapshot!Goal47' });
  assert.strictEqual(res.headers.location, '/mfa');
  const mfa = await agent.get('/mfa');
  assert.strictEqual(mfa.status, 200);
  assert.match(mfa.text, /couldn(&#39;|')t send your code/);
  const failed = await h.db.one(`SELECT * FROM email_log WHERE to_address = 'down@test.com' ORDER BY id DESC LIMIT 1`);
  assert.strictEqual(failed.status, 'failed');
  assert.match(failed.error, /Resend 500/);
  assert.strictEqual((await h.db.one(`SELECT count(*)::int AS n FROM email_otps o JOIN users u ON u.id = o.user_id WHERE u.email = 'down@test.com'`)).n, 0);

  // Resend recovers: "Resend code" works immediately (no cooldown from the failed attempt)
  const resent = await agent.post('/mfa/email').type('form').send({ _csrf: h.csrfFrom(mfa.text) });
  assert.strictEqual(resent.status, 302);
  assert.match((await agent.get('/mfa')).text, /We emailed a code/);
});

test('admin email page, test send, alert opt-out and security notices', async () => {
  await h.createUser({ email: 'boss@test.com', name: 'Boss', role: 'admin' });
  await h.createUser({ email: 'quiet@test.com', name: 'Quiet Admin', role: 'admin' });
  await h.db.query(`UPDATE users SET mfa_method = 'email' WHERE email IN ('boss@test.com', 'quiet@test.com')`);
  const boss = await loginWithResend('boss@test.com');
  const quiet = await loginWithResend('quiet@test.com');

  // Quiet admin turns off access-request alerts
  await h.post(quiet, '/account/notifications', {}, '/account');
  assert.strictEqual((await h.db.one(`SELECT notify_access_requests FROM users WHERE email = 'quiet@test.com'`)).notify_access_requests, false);

  resend.requests.length = 0;
  const anon = h.request.agent(app);
  const reg = await anon.get('/register');
  await anon.post('/register').type('form').send({
    _csrf: h.csrfFrom(reg.text), name: 'New Person', email: 'new@test.com', password: 'Slapshot!Goal47', password_confirm: 'Slapshot!Goal47', request_note: 'I play on the Hawks',
  });
  await until(() => resend.requests.some((r) => r.body.to[0] === 'boss@test.com'));
  const alert = resend.requests.find((r) => r.body.to[0] === 'boss@test.com');
  assert.match(alert.body.subject, /Access request: New Person/);
  assert.match(alert.body.html, /I play on the Hawks/);
  assert.ok(!resend.requests.some((r) => r.body.to[0] === 'quiet@test.com'), 'opted-out admin not emailed');

  // Asking again with the same email still alerts admins (flagged as a repeat), without changing the account
  resend.requests.length = 0;
  const reg2 = await anon.get('/register');
  const again = await anon.post('/register').type('form').send({
    _csrf: h.csrfFrom(reg2.text), name: 'Imposter', email: 'NEW@test.com', password: 'Different!Pass47', password_confirm: 'Different!Pass47',
  });
  assert.match(again.text, /Request submitted/);
  await until(() => resend.requests.some((r) => r.body.to[0] === 'boss@test.com'));
  const repeatAlert = resend.requests.find((r) => r.body.to[0] === 'boss@test.com');
  assert.match(repeatAlert.body.subject, /Access request \(repeat request\): New Person/, 'uses the stored name, not the new form');
  assert.match(repeatAlert.body.text, /again \(still waiting\)/);
  assert.strictEqual((await h.db.one(`SELECT name FROM users WHERE email = 'new@test.com'`)).name, 'New Person');

  // Approval email
  const newUser = await h.db.one(`SELECT id FROM users WHERE email = 'new@test.com'`);
  await h.post(boss, `/admin/users/${newUser.id}/approve`, {}, '/admin/users');
  await until(() => resend.requests.some((r) => r.body.to[0] === 'new@test.com' && /approved/.test(r.body.subject)));

  // Test email from the admin page
  const page = await boss.get('/admin/email');
  assert.match(page.text, /Resend/);
  assert.match(page.text, /ratings@robertmagnusmissesthe\.net/);
  const sentTest = await h.post(boss, '/admin/email/test', { to: '' }, '/admin/email');
  assert.strictEqual(sentTest.status, 302);
  assert.ok(resend.requests.some((r) => r.body.to[0] === 'boss@test.com' && r.body.subject === 'GURHA Ratings test email'));
  const after = await boss.get('/admin/email');
  assert.match(after.text, /Test email sent to boss@test\.com via resend/);
  assert.match(after.text, /GURHA Ratings test email/);
  assert.doesNotMatch(after.text, /\b\d{6} is your/, 'codes are redacted in the log view');

  // Security notice when the password changes
  await h.post(boss, '/account/password', { current_password: 'Slapshot!Goal47', password: 'NewGoalie#Save82', password_confirm: 'NewGoalie#Save82' }, '/account');
  await until(() => resend.requests.some((r) => r.body.to[0] === 'boss@test.com' && /password was changed/.test(r.body.subject)));

  // Raters can't see the email page
  await h.createUser({ email: 'peon@test.com', name: 'Peon' });
  await h.db.query(`UPDATE users SET mfa_method = 'email' WHERE email = 'peon@test.com'`);
  assert.strictEqual((await (await loginWithResend('peon@test.com')).get('/admin/email')).status, 403);
});

test('warns when MAIL_FROM is not on the league domain', () => {
  const mailer = require('../src/lib/mailer');
  const before = config.mail.from;
  config.mail.from = 'GURHA <me@gmail.com>';
  try {
    assert.match(mailer.configWarnings().join(' '), /gmail\.com, not robertmagnusmissesthe\.net/);
  } finally {
    config.mail.from = before;
  }
  assert.deepStrictEqual(mailer.configWarnings(), []);
});

function sign(body, secret = config.mail.resendWebhookSecret, timestamp = Math.floor(Date.now() / 1000)) {
  const id = `msg_${crypto.randomUUID()}`;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${sig}`, 'content-type': 'application/json' };
}

test('Resend webhooks update delivery status (signed requests only)', async () => {
  const row = await h.db.one(`SELECT * FROM email_log WHERE provider_id IS NOT NULL ORDER BY id DESC LIMIT 1`);
  const post = (event, headers) => {
    const body = JSON.stringify(event);
    return h.request(app).post('/webhooks/resend').set(headers || sign(body)).send(body);
  };
  const delivered = { type: 'email.delivered', data: { email_id: row.provider_id } };

  assert.strictEqual((await post(delivered, { ...sign('{}'), 'content-type': 'application/json' })).status, 401, 'signature must match the body');
  assert.strictEqual((await post(delivered, sign(JSON.stringify(delivered), config.mail.resendWebhookSecret, Math.floor(Date.now() / 1000) - 3600))).status, 401, 'stale timestamp rejected');

  assert.strictEqual((await post(delivered)).status, 200);
  assert.strictEqual((await h.db.one('SELECT status FROM email_log WHERE id = $1', [row.id])).status, 'delivered');
  await post({ type: 'email.delivery_delayed', data: { email_id: row.provider_id } });
  assert.strictEqual((await h.db.one('SELECT status FROM email_log WHERE id = $1', [row.id])).status, 'delivered', 'delayed never downgrades delivered');
  await post({ type: 'email.bounced', data: { email_id: row.provider_id, bounce: { type: 'Permanent', message: 'Mailbox does not exist' } } });
  const bounced = await h.db.one('SELECT status, error FROM email_log WHERE id = $1', [row.id]);
  assert.deepStrictEqual([bounced.status, bounced.error], ['bounced', 'Permanent: Mailbox does not exist']);
});
