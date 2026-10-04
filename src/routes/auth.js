'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');

const config = require('../config');
const db = require('../db');
const mailer = require('../lib/mailer');
const emailOtp = require('../lib/emailOtp');
const totp = require('../lib/totp');
const { encrypt, decrypt, sha256, randomToken } = require('../lib/crypto');
const { audit } = require('../lib/audit');
const { loginLimiter, mfaLimiter, registerLimiter, resetLimiter } = require('../lib/limits');

const router = express.Router();

const MFA_PENDING_TTL_MS = 15 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 10;

// Dummy hash so failed lookups take as long as a real bcrypt compare.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

function passwordProblem(pw) {
  if (!pw || pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return 'Password is too long.';
  return null;
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
  await regenerate(req);
  req.session.userId = user.id;
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await audit(user.id, 'login', 'user', user.id);
  res.redirect(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/players');
}

// ---------- Registration (access request) ----------

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
  const pwErr = passwordProblem(req.body.password);
  if (pwErr) errors.push(pwErr);
  if (req.body.password !== req.body.password_confirm) errors.push('Passwords do not match.');
  if (errors.length) return res.status(422).render('auth/register', { title: 'Request access', values, errors });

  const existing = await db.one('SELECT id FROM users WHERE lower(email) = $1', [values.email]);
  if (!existing) {
    const user = await db.one(
      `INSERT INTO users (email, name, password_hash, request_note) VALUES ($1, $2, $3, $4) RETURNING id, name, email`,
      [values.email, values.name, await bcrypt.hash(req.body.password, 12), values.request_note || null]
    );
    await audit(user.id, 'access_requested', 'user', user.id);
    const admins = await db.many(`SELECT email FROM users WHERE role = 'admin' AND status = 'approved'`);
    for (const a of admins) {
      mailer
        .send({
          to: a.email,
          subject: `Access request: ${user.name}`,
          text: `${user.name} (${user.email}) requested rater access.\n\n${values.request_note || ''}\n\nReview: ${config.appUrl}/admin/users`,
          html: mailer.wrapHtml(
            'New access request',
            `<p><strong>${mailer.escapeHtml(user.name)}</strong> (${mailer.escapeHtml(user.email)}) requested rater access.</p>
             ${values.request_note ? `<p>${mailer.escapeHtml(values.request_note)}</p>` : ''}
             <p><a href="${config.appUrl}/admin/users">Review pending requests</a></p>`
          ),
        })
        .catch((err) => console.error('Failed to notify admin', err));
    }
  }
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
  req.session.mfaPending = { userId: user.id, at: Date.now() };

  if (!user.mfa_method) return res.redirect('/mfa/setup');
  if (user.mfa_method === 'email') await emailOtp.issue(user, 'login');
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
  req.flash(r.sent ? 'success' : 'info', r.sent ? `We emailed a code to ${user.email}.` : 'A code was just sent. Please wait 30 seconds before requesting another.');
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
    await mailer.send({
      to: user.email,
      subject: 'Reset your GURHA Ratings password',
      text: `Use this link to reset your password (valid for 1 hour):\n${link}\n\nIf you didn't request this, ignore this email.`,
      html: mailer.wrapHtml(
        'Reset your password',
        `<p><a href="${link}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Choose a new password</a></p>
         <p>This link is valid for 1 hour. If you didn't request this, ignore this email.</p>`
      ),
    });
  }
  res.render('auth/forgot', { title: 'Reset password', sent: true });
});

async function findReset(token) {
  return db.one(`SELECT * FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`, [sha256(token)]);
}

router.get('/reset/:token', async (req, res) => {
  const reset = await findReset(req.params.token);
  if (!reset) return res.status(400).render('error', { title: 'Link expired', message: 'This reset link is invalid or has expired.' });
  res.render('auth/reset', { title: 'Choose a new password', error: null });
});

router.post('/reset/:token', resetLimiter, async (req, res) => {
  const reset = await findReset(req.params.token);
  if (!reset) return res.status(400).render('error', { title: 'Link expired', message: 'This reset link is invalid or has expired.' });
  const err = passwordProblem(req.body.password) || (req.body.password !== req.body.password_confirm ? 'Passwords do not match.' : null);
  if (err) return res.status(422).render('auth/reset', { title: 'Choose a new password', error: err });
  await db.tx(async (c) => {
    await c.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [await bcrypt.hash(req.body.password, 12), reset.user_id]);
    await c.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [reset.user_id]);
    // Sign out any existing sessions for this user.
    await c.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId') = $1::text`, [reset.user_id]);
  });
  await audit(reset.user_id, 'password_reset', 'user', reset.user_id);
  req.flash('success', 'Password updated. Please sign in.');
  res.redirect('/login');
});

module.exports = router;
module.exports.passwordProblem = passwordProblem;
