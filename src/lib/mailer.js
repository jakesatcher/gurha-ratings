'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');

let transport = null;
if (config.mail.smtp) {
  transport = nodemailer.createTransport(config.mail.smtp);
}

// Captured messages when no provider is configured (used in dev and tests).
const outbox = [];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function wrapHtml(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
  <div style="max-width:520px;margin:0 auto;padding:24px">
    <div style="background:#0b1f3a;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;font-weight:700;font-size:18px">${escapeHtml(config.appName)}</div>
    <div style="background:#fff;padding:20px;border-radius:0 0 12px 12px;line-height:1.5">
      <h2 style="margin-top:0;font-size:18px">${escapeHtml(title)}</h2>
      ${bodyHtml}
    </div>
  </div></body></html>`;
}

async function send({ to, subject, text, html }) {
  const msg = { from: config.mail.from, to, subject, text, html: html || undefined };
  if (config.mail.resendApiKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.mail.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: msg.from, to: [to], subject, text, html: msg.html }),
    });
    if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
    return;
  }
  if (transport) {
    await transport.sendMail(msg);
    return;
  }
  outbox.push(msg);
  if (outbox.length > 100) outbox.shift();
  if (process.env.NODE_ENV !== 'test') {
    console.log(`[mail:console] To: ${to} | ${subject}\n${text}\n`);
  }
}

function isConfigured() {
  return Boolean(config.mail.resendApiKey || transport);
}

module.exports = { send, wrapHtml, escapeHtml, outbox, isConfigured };
