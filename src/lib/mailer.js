'use strict';

// Outgoing email. Resend (HTTPS API) is preferred: it works on Railway, where outbound SMTP is
// blocked on some plans. SMTP is a fallback; with neither configured, messages are printed to the
// log (and kept in `outbox` for tests). Every send is recorded in email_log with codes redacted.
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const config = require('../config');
const db = require('../db');

let transport = null;
if (config.mail.smtp) transport = nodemailer.createTransport(config.mail.smtp);

const outbox = [];
const TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;

class MailError extends Error {
  constructor(message, { status, retryable } = {}) {
    super(message);
    this.name = 'MailError';
    this.status = status;
    this.retryable = retryable;
  }
}

function provider() {
  if (config.mail.resendApiKey) return 'resend';
  if (transport) return 'smtp';
  return 'console';
}

function isConfigured() {
  return provider() !== 'console';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Six-digit codes never go into the log.
const redact = (s) => String(s || '').replace(/\b\d{6}\b/g, '••••••');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendViaResend(msg, idempotencyKey) {
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${config.mail.resendApiUrl}/emails`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.mail.resendApiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          from: msg.from,
          to: [msg.to],
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
          reply_to: msg.replyTo || undefined,
          tags: [{ name: 'kind', value: msg.kind.replace(/[^a-zA-Z0-9_-]/g, '_') }],
        }),
      });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(400 * attempt);
        continue;
      }
      throw new MailError(err.name === 'AbortError' ? 'Resend did not respond in time' : `Could not reach Resend: ${err.message}`, { retryable: true });
    }
    clearTimeout(timer);
    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON error page */
    }
    if (res.ok) return body.id || null;
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < MAX_ATTEMPTS) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 5) * 1000 : 600 * attempt);
      continue;
    }
    throw new MailError(`Resend ${res.status}: ${body.message || text.slice(0, 200) || res.statusText}`, { status: res.status, retryable });
  }
}

async function log(entry) {
  try {
    const row = await db.one(
      `INSERT INTO email_log (to_address, kind, subject, status, provider, provider_id, error, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [entry.to, entry.kind, redact(entry.subject).slice(0, 300), entry.status, entry.provider, entry.providerId || null,
        entry.error ? redact(entry.error).slice(0, 1000) : null, entry.userId || null]
    );
    return row.id;
  } catch (err) {
    console.error('Failed to write email_log', err.message);
    return null;
  }
}

// Sends one message. Throws MailError if it couldn't be sent (after retries); callers decide
// whether that's fatal (sign-in codes) or just logged (admin notifications).
async function send({ to, subject, text, html, kind = 'other', userId = null, idempotencyKey = null }) {
  const msg = { from: config.mail.from, replyTo: config.mail.replyTo, to, subject, text, html, kind };
  const via = provider();
  try {
    let providerId = null;
    if (via === 'resend') {
      providerId = await sendViaResend(msg, idempotencyKey || crypto.randomUUID());
    } else if (via === 'smtp') {
      const info = await transport.sendMail({ from: msg.from, replyTo: msg.replyTo || undefined, to, subject, text, html });
      providerId = info && info.messageId;
    } else {
      outbox.push(msg);
      if (outbox.length > 100) outbox.shift();
      if (process.env.NODE_ENV !== 'test') console.log(`[mail:console] To: ${to} | ${subject}\n${text}\n`);
    }
    await log({ to, kind, subject, status: via === 'console' ? 'console' : 'sent', provider: via, providerId, userId });
    return { provider: via, id: providerId };
  } catch (err) {
    await log({ to, kind, subject, status: 'failed', provider: via, error: err.message, userId });
    console.error(`Email "${kind}" to ${to} failed: ${err.message}`);
    throw err instanceof MailError ? err : new MailError(err.message);
  }
}

// Fire-and-forget for non-critical mail (failures are logged, never thrown).
function sendQuietly(message) {
  send(message).catch(() => {});
}

// Problems an admin should know about (shown on Admin → Email and logged at startup).
function configWarnings() {
  const warnings = [];
  if (!isConfigured()) warnings.push('No email provider is configured, so codes are only printed to the server log. Set RESEND_API_KEY.');
  const m = /@([^>\s]+)>?\s*$/.exec(config.mail.from || '');
  const domain = m ? m[1].toLowerCase() : null;
  if (!domain) warnings.push(`MAIL_FROM "${config.mail.from}" isn't a valid address.`);
  else if (config.mail.expectedDomain && domain !== config.mail.expectedDomain && !domain.endsWith(`.${config.mail.expectedDomain}`)) {
    warnings.push(`MAIL_FROM uses ${domain}, not ${config.mail.expectedDomain}. Resend only sends from domains verified in your Resend account.`);
  }
  return warnings;
}

module.exports = { send, sendQuietly, escapeHtml, outbox, isConfigured, provider, configWarnings, redact, MailError };
