'use strict';

const crypto = require('crypto');
const db = require('../db');
const mailer = require('./mailer');
const emails = require('./emails');
const { sha256 } = require('./crypto');

const TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 30;

function hashCode(userId, code) {
  return sha256(`${userId}:${code}`);
}

async function issue(user, purpose = 'login') {
  const recent = await db.one(
    `SELECT created_at FROM email_otps WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL
     AND created_at > now() - ($3 || ' seconds')::interval ORDER BY created_at DESC LIMIT 1`,
    [user.id, purpose, String(RESEND_COOLDOWN_SECONDS)]
  );
  if (recent) return { sent: false, reason: 'cooldown' };

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.query(`UPDATE email_otps SET consumed_at = now() WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`, [user.id, purpose]);
  const row = await db.one(
    `INSERT INTO email_otps (user_id, code_hash, purpose, expires_at) VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval) RETURNING id`,
    [user.id, hashCode(user.id, code), purpose, String(TTL_MINUTES)]
  );
  try {
    await mailer.send({ to: user.email, userId: user.id, ...emails.code({ code, purpose, minutes: TTL_MINUTES }) });
  } catch (err) {
    // Don't leave an unusable code (or a cooldown) behind if it never left the building.
    await db.query('DELETE FROM email_otps WHERE id = $1', [row.id]);
    return { sent: false, reason: 'failed', error: err.message };
  }
  return { sent: true };
}

async function verify(userId, code, purpose = 'login') {
  const clean = String(code || '').replace(/\s/g, '');
  const row = await db.one(
    `SELECT * FROM email_otps WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [userId, purpose]
  );
  if (!row) return false;
  if (new Date(row.expires_at) < new Date() || row.attempts >= MAX_ATTEMPTS) return false;
  if (!/^\d{6}$/.test(clean) || hashCode(userId, clean) !== row.code_hash) {
    await db.query('UPDATE email_otps SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    return false;
  }
  await db.query('UPDATE email_otps SET consumed_at = now() WHERE id = $1', [row.id]);
  return true;
}

module.exports = { issue, verify, TTL_MINUTES };
