'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://localhost/gurha_test';
if (!/test/i.test(new URL(process.env.DATABASE_URL).pathname)) {
  throw new Error('Refusing to run tests: TEST_DATABASE_URL database name must contain "test" (the schema is dropped).');
}
process.env.SESSION_SECRET = 'test-secret';
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const request = require('supertest');
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { createApp } = require('../src/app');
const mailer = require('../src/lib/mailer');
const totp = require('../src/lib/totp');

async function resetDb() {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
}

function csrfFrom(html) {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error('No CSRF token in page');
  return m[1];
}

function lastCodeFor(email) {
  const msg = [...mailer.outbox].reverse().find((m) => m.to === email && /code/i.test(m.subject));
  if (!msg) throw new Error(`No code email for ${email}`);
  return /(\d{6})/.exec(msg.subject)[1];
}

async function createUser({ email, name = 'User', password = 'password1234', role = 'rater', status = 'approved' }) {
  return db.one(
    `INSERT INTO users (email, name, password_hash, role, status) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [email, name, await bcrypt.hash(password, 4), role, status]
  );
}

// Signs in with password + email code (enrolling in email MFA on first sign-in).
async function login(app, email, password = 'password1234') {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrfFrom(page.text), email, password });
  if (res.status !== 302) throw new Error(`Login failed: ${res.status}`);
  if (res.headers.location === '/mfa/setup') {
    const setup = await agent.get('/mfa/setup');
    await agent.post('/mfa/setup/email').type('form').send({ _csrf: csrfFrom(setup.text) });
    const verifyPage = await agent.get('/mfa/setup/email');
    const done = await agent.post('/mfa/setup/email/verify').type('form').send({ _csrf: csrfFrom(verifyPage.text), code: lastCodeFor(email) });
    if (done.status !== 302) throw new Error(`MFA enrol failed: ${done.status}`);
  } else {
    const mfaPage = await agent.get('/mfa');
    const done = await agent.post('/mfa').type('form').send({ _csrf: csrfFrom(mfaPage.text), code: lastCodeFor(email) });
    if (done.status !== 302) throw new Error(`MFA failed: ${done.status}`);
  }
  return agent;
}

async function post(agent, url, data, getUrl = '/players') {
  const page = await agent.get(getUrl);
  return agent.post(url).type('form').send({ _csrf: csrfFrom(page.text), ...data });
}

module.exports = { db, request, createApp, resetDb, csrfFrom, lastCodeFor, createUser, login, post, mailer, totp };
