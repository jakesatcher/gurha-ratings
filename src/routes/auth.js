'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');

const config = require('../config');
const db = require('../db');
const mailer = require('../lib/mailer');
const emails = require('../lib/emails');
const emailOtp = require('../lib/emailOtp');
const totp = require('../lib/totp');
const { encrypt, decrypt, sha256, randomToken } = require('../lib/crypto');
const { audit } = require('../lib/audit');
const { loginLimiter, mfaLimiter, registerLimiter, resetLimiter } = require('../lib/limits');
const passwordPolicy = require('../../public/js/password-policy');

const router = express.Router();

const MFA_PENDING_TTL_MS = 15 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Dummy hash so failed lookups take as long as a real bcrypt compare.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// Everything wrong with a new password (empty when it meets the policy and matches its confirmation).
function passwordProblems(pw, confirm) {
  const problems = passwordPolicy.check(pw);
  if (confirm !== undefined && pw !== confirm) problems.push('Passwords do not match.');
  return problems;
}

function regenerate(req) {
  return new Promise((resolve, reject) => {
    const keep = { flash: req.session.flash };
    req.session.regenerate((err) => {
      if (err) return reject(err);
      Object.assign(req.session, keep);
      resolve();
    });
  });
}

// The user who has passed the password step but not yet the second factor.
async function pendingUser(req) {
  const p = req.session.mfaPending;
  if (!p || Date.now() - p.at > MFA_PENDING_TTL_MS) return null;
  return db.one('SELECT * FROM users WHERE id = $1 AND status = $2', [p.userId, 'approved']);
}

// The user configuring MFA: either mid-login (first-time setup) or signed in (changing method).
async function setupUser(req) {
  if (req.user) return db.one('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const u = await pendingUser(req);
  if (u && !u.mfa_method) return u;
  return null;
}

async function completeLogin(req, res, user) {
  const returnTo = req.session.returnTo;
  const weakPassword = Boolean(req.session.mfaPending && req.session.mfaPending.weakPassword);
  await regenerate(req);
  req.session.userId = user.id;
  if (weakPassword) {
    // Signed in with a password that predates the current policy: must choose a new one first.
    req.session.mustChangePassword = true;
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await audit(user.id, 'login', 'user', user.id, { password_update_required: true });
    return res.redirect('/account/new-password');
  }
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await audit(user.id, 'login', 'user', user.id);
  res.redirect(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/players');
}

// ---------- Registration (access request) ----------

async function notifyAdminsOfRequest(requester, note, { repeat = false, previousStatus = null } = {}) {
  const admins = await db.many(`SELECT id, email FROM users WHERE role = 'admin' AND status = 'approved' AND notify_access_requests`);
  if (!admins.length) {
    console.warn(`[email] Access request from ${requester.email}, but no approved admin has access-request alerts turned on.`);
    return;
  }
  const { n: pendingCount } = await db.one(`SELECT count(*)::int AS n FROM users WHERE status = 'pending'`);
  for (const a of admins) {
    mailer.sendQuietly({
      to: a.email,
      userId: a.id,
      ...emails.accessRequested({ name: requester.name, email: requester.email, note, pendingCount, repeat, previousStatus }),
    });
  }
}

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/players');
  res.render('auth/register', { title: 'Request access', values: {}, errors: [] });
});

router.post('/register', registerLimiter, async (req, res) => {
  const values = {
    name: String(req.body.name || '').trim().slice(0, 100),
    email: String(req.body.email || '').trim().toLowerCase().slice(0, 200),
    request_note: String(req.body.request_note || '').trim().slice(0, 1000),
  };
  const errors = [];
  if (!values.name) errors.push('Name is required.');
  if (!EMAIL_RE.test(values.email)) errors.push('Enter a valid email address.');
  errors.push(...passwordProblems(req.body.password, req.body.password_confirm));
  if (errors.length) return res.status(422).render('auth/register', { title: 'Request access', values, errors });

  const existing = await db.one('SELECT id, name, email, status, request_note FROM users WHERE lower(email) = $1', [values.email]);
  let requester = null;
  let repeat = false;
  if (!existing) {
    requester = await db.one(
      `INSERT INTO users (email, name, password_hash, request_note) VALUES ($1, $2, $3, $4) RETURNING id, name, email`,
      [values.email, values.name, await bcrypt.hash(req.body.password, 12), values.request_note || null]
    );
    await audit(requester.id, 'access_requested', 'user', requester.id);
  } else if (['pending', 'rejected'].includes(existing.status)) {
    // Someone asking again (still waiting, or previously not approved): nudge the admins.
    // Nothing about the account changes, and the requester sees the same page as everyone else.
    requester = existing;
    repeat = true;
    await audit(existing.id, 'access_requested_again', 'user', existing.id, { status: existing.status });
  }
  if (requester) await notifyAdminsOfRequest(requester, values.request_note || requester.request_note, { repeat, previousStatus: existing && existing.status });
  // Same response whether or not the email already exists, to avoid account enumeration.
  res.render('auth/registered', { title: 'Request submitted' });
});

// ---------- Login ----------

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/players');
  res.render('auth/login', { title: 'Sign in', email: '', error: null });
});

router.post('/login', loginLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = await db.one('SELECT * FROM users WHERE lower(email) = $1', [email]);
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  const fail = (msg) => res.status(401).render('auth/login', { title: 'Sign in', email, error: msg });

  if (!user || !ok) return fail('Incorrect email or password.');
  if (user.status === 'pending') return fail('Your access request is still awaiting admin approval.');
  if (user.status === 'rejected') return fail('Your access request was not approved. Contact an admin if you think this is a mistake.');
  if (user.status === 'disabled') return fail('This account has been disabled. Contact an admin.');

  const returnTo = req.session.returnTo;
  await regenerate(req);
  req.session.returnTo = returnTo;
  // The plaintext is only available now, so check it against the current policy here.
  req.session.mfaPending = { userId: user.id, at: Date.now(), weakPassword: passwordPolicy.check(password).length > 0 };

  if (!user.mfa_method) return res.redirect('/mfa/setup');
  if (user.mfa_method === 'email') {
    const r = await emailOtp.issue(user, 'login');
    if (r.reason === 'failed') req.flash('error', "We couldn't send your code just now. Wait a moment and tap “Resend code”. If it keeps failing, contact an admin.");
  }
  res.redirect('/mfa');
});

// ---------- Second factor ----------

router.get('/mfa', async (req, res) => {
  const user = await pendingUser(req);
  if (!user) return res.redirect('/login');
  if (!user.mfa_method) return res.redirect('/mfa/setup');
  const method = req.session.mfaPending.useEmail ? 'email' : user.mfa_method;
  res.render('auth/mfa', { title: 'Verify it’s you', method, email: user.email, error: null });
});

router.post('/mfa', mfaLimiter, async (req, res) => {
  const user = await pendingUser(req);
  if (!user || !user.mfa_method) return res.redirect('/login');
  const method = req.session.mfaPending.useEmail ? 'email' : user.mfa_method;
  let ok = false;
  if (method === 'totp') {
    ok = Boolean(user.totp_secret_enc) && totp.verify(decrypt(user.totp_secret_enc), req.body.code);
  } else {
    ok = await emailOtp.verify(user.id, req.body.code, 'login');
  }
  if (!ok) {
    return res.status(401).render('auth/mfa', { title: 'Verify it’s you', method, email: user.email, error: 'That code is invalid or expired.' });
  }
  await completeLogin(req, res, user);
});

// Send (or resend) an email code; also lets authenticator users fall back to email.
router.post('/mfa/email', mfaLimiter, async (req, res) => {
  const user = await pendingUser(req);
  if (!user || !user.mfa_method) return res.redirect('/login');
  req.session.mfaPending.useEmail = true;
  const r = await emailOtp.issue(user, 'login');
  if (r.sent) req.flash('success', `We emailed a code to ${user.email}.`);
  else if (r.reason === 'failed') req.flash('error', "We couldn't send your code just now. Please try again in a moment, or contact an admin.");
  else req.flash('info', 'A code was just sent. Please wait 30 seconds before requesting another.');
  res.redirect('/mfa');
});

// ---------- MFA setup (first login, or changing method from the account page) ----------

router.get('/mfa/setup', async (req, res) => {
  const user = await setupUser(req);
  if (!user) return res.redirect('/login');
  res.render('auth/mfa-setup', { title: 'Set up two-step verification', firstTime: !req.user, current: user.mfa_method });
});

router.get('/mfa/setup/totp', async (req, res) => {
  const user = await setupUser(req);
  if (!user) return res.redirect('/login');
  if (!req.session.totpSetupSecret) req.session.totpSetupSecret = totp.generateSecret();
  const secret = req.session.totpSetupSecret;
  const url = totp.otpauthUrl({ secret, account: user.email, issuer: 'GURHA Ratings' });
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 240 });
  res.render('auth/mfa-totp', { title: 'Authenticator app', qr, secret: secret.match(/.{1,4}/g).join(' '), error: null });
});

router.post('/mfa/setup/totp', mfaLimiter, async (req, res) => {
  const user = await setupUser(req);
  const secret = req.session.totpSetupSecret;
  if (!user || !secret) return res.redirect('/mfa/setup');
  if (!totp.verify(secret, req.body.code)) {
    const url = totp.otpauthUrl({ secret, account: user.email, issuer: 'GURHA Ratings' });
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 240 });
    return res.status(422).render('auth/mfa-totp', {
      title: 'Authenticator app',
      qr,
      secret: secret.match(/.{1,4}/g).join(' '),
      error: 'That code didn’t match. Check the time on your phone and try the newest code.',
    });
  }
  await db.query(`UPDATE users SET mfa_method = 'totp', totp_secret_enc = $1, updated_at = now() WHERE id = $2`, [encrypt(secret), user.id]);
  delete req.session.totpSetupSecret;
  await audit(user.id, 'mfa_enrolled', 'user', user.id, { method: 'totp' });
  return finishSetup(req, res, user);
});

router.post('/mfa/setup/email', mfaLimiter, async (req, res) => {
  const user = await setupUser(req);
  if (!user) return res.redirect('/login');
  const r = await emailOtp.issue(user, 'enroll');
  if (r.reason === 'failed') {
    req.flash('error', "We couldn't send an email to that address just now. Try again in a moment, or use an authenticator app instead.");
    return res.redirect('/mfa/setup');
  }
  if (!r.sent) req.flash('info', 'A code was just sent. Please wait 30 seconds before requesting another.');
  res.redirect('/mfa/setup/email');
});

router.get('/mfa/setup/email', async (req, res) => {
  const user = await setupUser(req);
  if (!user) return res.redirect('/login');
  res.render('auth/mfa-email', { title: 'Email codes', email: user.email, error: null });
});

router.post('/mfa/setup/email/verify', mfaLimiter, async (req, res) => {
  const user = await setupUser(req);
  if (!user) return res.redirect('/login');
  if (!(await emailOtp.verify(user.id, req.body.code, 'enroll'))) {
    return res.status(422).render('auth/mfa-email', { title: 'Email codes', email: user.email, error: 'That code is invalid or expired.' });
  }
  await db.query(`UPDATE users SET mfa_method = 'email', totp_secret_enc = NULL, updated_at = now() WHERE id = $1`, [user.id]);
  await audit(user.id, 'mfa_enrolled', 'user', user.id, { method: 'email' });
  return finishSetup(req, res, user);
});

async function finishSetup(req, res, user) {
  if (req.user) {
    const method = (await db.one('SELECT mfa_method FROM users WHERE id = $1', [user.id])).mfa_method;
    mailer.sendQuietly({
      to: user.email,
      userId: user.id,
      ...emails.securityNotice({ name: user.name, what: `Two-step verification was changed to ${method === 'totp' ? 'an authenticator app' : 'email codes'}` }),
    });
    req.flash('success', 'Two-step verification updated.');
    return res.redirect('/account');
  }
  req.flash('success', 'Two-step verification is set up.');
  return completeLogin(req, res, user);
}

// ---------- Logout ----------

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('gurha.sid');
    res.redirect('/login');
  });
});

// ---------- Password reset ----------

router.get('/forgot', (req, res) => res.render('auth/forgot', { title: 'Reset password', sent: false }));

router.post('/forgot', resetLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await db.one(`SELECT id, email, name FROM users WHERE lower(email) = $1 AND status = 'approved'`, [email]);
  if (user) {
    const token = randomToken(32);
    await db.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [
      user.id,
      sha256(token),
    ]);
    const link = `${config.appUrl}/reset/${token}`;
    // Quiet send: the response is the same either way, so it can't reveal which emails have accounts.
    mailer.sendQuietly({ to: user.email, userId: user.id, ...emails.passwordReset({ link }) });
  }
  res.render('auth/forgot', { title: 'Reset password', sent: true });
});

async function findReset(token) {
  return db.one(`SELECT * FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`, [sha256(token)]);
}

router.get('/reset/:token', async (req, res) => {
  const reset = await findReset(req.params.token);
  if (!reset) return res.status(400).render('error', { title: 'Link expired', message: 'This reset link is invalid or has expired.' });
  res.render('auth/reset', { title: 'Choose a new password', errors: [] });
});

router.post('/reset/:token', resetLimiter, async (req, res) => {
  const reset = await findReset(req.params.token);
  if (!reset) return res.status(400).render('error', { title: 'Link expired', message: 'This reset link is invalid or has expired.' });
  const problems = passwordProblems(req.body.password, req.body.password_confirm);
  if (problems.length) return res.status(422).render('auth/reset', { title: 'Choose a new password', errors: problems });
  await db.tx(async (c) => {
    await c.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [await bcrypt.hash(req.body.password, 12), reset.user_id]);
    await c.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [reset.user_id]);
    // Sign out any existing sessions for this user.
    await c.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId') = $1::text`, [reset.user_id]);
  });
  await audit(reset.user_id, 'password_reset', 'user', reset.user_id);
  const resetUser = await db.one('SELECT id, name, email FROM users WHERE id = $1', [reset.user_id]);
  mailer.sendQuietly({ to: resetUser.email, userId: resetUser.id, ...emails.securityNotice({ name: resetUser.name, what: 'Your password was reset' }) });
  req.flash('success', 'Password updated. Please sign in.');
  res.redirect('/login');
});

module.exports = router;
module.exports.passwordProblems = passwordProblems;
