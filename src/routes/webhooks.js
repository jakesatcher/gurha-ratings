'use strict';

// Resend delivery webhooks (Svix-signed). Point a Resend webhook at https://<your domain>/webhooks/resend
// for email.delivered / email.bounced / email.complained / email.delivery_delayed and set
// RESEND_WEBHOOK_SECRET to its signing secret. Updates the status shown on Admin → Email.
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const db = require('../db');

const router = express.Router();
const TOLERANCE_SECONDS = 5 * 60;
const STATUS = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.delivery_delayed': 'delayed',
};
// Later states win; a "delayed" event never overwrites "delivered" or "bounced".
const RANK = { console: 0, sent: 1, delayed: 2, delivered: 3, bounced: 4, complained: 5, failed: 6 };

function verifySvix(secret, headers, rawBody) {
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signatures = headers['svix-signature'];
  if (!id || !timestamp || !signatures) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();
  return String(signatures)
    .split(' ')
    .map((part) => part.split(',')[1])
    .filter(Boolean)
    .some((sig) => {
      const got = Buffer.from(sig, 'base64');
      return got.length === expected.length && crypto.timingSafeEqual(got, expected);
    });
}

router.post('/webhooks/resend', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  const secret = config.mail.resendWebhookSecret;
  if (!secret) return res.status(404).end();
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!verifySvix(secret, req.headers, raw)) return res.status(401).json({ error: 'invalid signature' });
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return res.status(400).json({ error: 'invalid JSON' });
  }
  const status = STATUS[event.type];
  const emailId = event.data && event.data.email_id;
  if (status && emailId) {
    const row = await db.one('SELECT id, status FROM email_log WHERE provider_id = $1 ORDER BY id DESC LIMIT 1', [emailId]);
    if (row && (RANK[status] ?? 0) >= (RANK[row.status] ?? 0)) {
      const detail = event.data.bounce ? [event.data.bounce.type, event.data.bounce.message].filter(Boolean).join(': ') : null;
      await db.query('UPDATE email_log SET status = $1, error = coalesce($2, error), updated_at = now() WHERE id = $3', [status, detail, row.id]);
    }
  }
  res.json({ ok: true });
});

module.exports = router;
module.exports.verifySvix = verifySvix;
