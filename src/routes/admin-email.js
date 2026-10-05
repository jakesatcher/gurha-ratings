'use strict';

// Admin → Email: provider status, test sends, who gets access-request alerts, and the delivery log.
const express = require('express');
const config = require('../config');
const db = require('../db');
const mailer = require('../lib/mailer');
const emails = require('../lib/emails');
const { audit } = require('../lib/audit');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/email', async (req, res) => {
  const failedOnly = req.query.status === 'failed';
  const logRows = await db.many(
    `SELECT l.*, u.name AS user_name FROM email_log l LEFT JOIN users u ON u.id = l.user_id
      ${failedOnly ? `WHERE l.status IN ('failed', 'bounced', 'complained')` : ''}
      ORDER BY l.created_at DESC LIMIT 150`
  );
  const stats = await db.one(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week,
            count(*) FILTER (WHERE created_at > now() - interval '7 days' AND status IN ('failed', 'bounced', 'complained'))::int AS problems
       FROM email_log`
  );
  const admins = await db.many(`SELECT id, name, email, notify_access_requests FROM users WHERE role = 'admin' AND status = 'approved' ORDER BY lower(name)`);
  res.render('admin/email', {
    title: 'Email',
    mail: {
      provider: mailer.provider(),
      from: config.mail.from,
      replyTo: config.mail.replyTo,
      webhook: Boolean(config.mail.resendWebhookSecret),
      webhookUrl: `${config.appUrl}/webhooks/resend`,
      warnings: mailer.configWarnings(),
    },
    logRows,
    stats,
    admins,
    failedOnly,
  });
});

router.post('/email/test', async (req, res) => {
  const to = String(req.body.to || '').trim() || req.user.email;
  if (!EMAIL_RE.test(to)) {
    req.flash('error', 'Enter a valid email address.');
    return res.redirect('/admin/email');
  }
  try {
    const r = await mailer.send({ to, userId: req.user.id, ...emails.test({ name: req.user.name }) });
    await audit(req.user.id, 'email_test', 'email', null, { to, provider: r.provider });
    req.flash(
      r.provider === 'console' ? 'info' : 'success',
      r.provider === 'console' ? 'No email provider is set up, so the test was only printed to the server log.' : `Test email sent to ${to} via ${r.provider}.`
    );
  } catch (err) {
    req.flash('error', `Test email failed: ${err.message}`);
  }
  res.redirect('/admin/email');
});

module.exports = router;
