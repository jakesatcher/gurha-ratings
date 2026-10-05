'use strict';

// Every email the app sends: subject, plain text and branded HTML (inline styles for email clients).
const config = require('../config');
const { escapeHtml: esc } = require('./mailer');

const NAVY = '#0a1f44';
const RED = '#c8102e';
const GOLD = '#f2c200';

function layout({ preheader, heading, body, footer }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#e7f0f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e7f0f7"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
    <tr><td style="background:${NAVY};border-top:4px solid ${GOLD};border-bottom:4px solid ${RED};border-radius:12px 12px 0 0;padding:16px 22px">
      <span style="display:inline-block;width:18px;height:12px;border-radius:50%;background:#000;box-shadow:0 2px 0 #000;vertical-align:middle;margin-right:8px"></span>
      <span style="color:#fff;font-weight:800;font-size:20px;letter-spacing:2px;vertical-align:middle">GURHA</span>
      <span style="color:#9fb7e0;font-weight:600;font-size:13px;letter-spacing:2px;vertical-align:middle;margin-left:4px">RATINGS</span>
    </td></tr>
    <tr><td style="background:#ffffff;padding:24px 22px 8px;border-radius:0 0 12px 12px;line-height:1.55;font-size:15px">
      <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:${NAVY};text-transform:uppercase;letter-spacing:.5px">${esc(heading)}</h1>
      ${body}
      <div style="height:6px;background:${GOLD};border-radius:3px;margin:22px 0 14px"></div>
      <p style="margin:0 0 14px;font-size:12px;color:#64748b">${footer || `Greer Upstate Recreational Hockey League · <a href="${config.appUrl}" style="color:#64748b">${esc(config.appUrl.replace(/^https?:\/\//, ''))}</a>`}</p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

const p = (html) => `<p style="margin:0 0 14px">${html}</p>`;
const button = (href, label) =>
  `<p style="margin:18px 0"><a href="${href}" style="display:inline-block;background:${RED};color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;text-transform:uppercase;letter-spacing:1px">${esc(label)}</a></p>`;
const codeBox = (code) =>
  `<div style="margin:18px 0;padding:14px;background:#0b1426;border-radius:10px;text-align:center"><span style="font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:#ffb000">${esc(code)}</span></div>`;
const securityFooter = `You're receiving this because of activity on your GURHA Ratings account. If this wasn't you, reset your password at <a href="${config.appUrl}/forgot" style="color:#64748b">${esc(config.appUrl.replace(/^https?:\/\//, ''))}/forgot</a> and tell an admin.`;

// ---------- Sign-in codes ----------

function code({ code: c, purpose, minutes }) {
  const enrolling = purpose === 'enroll';
  return {
    kind: enrolling ? 'code_enroll' : 'code_login',
    subject: `${c} is your GURHA Ratings code`,
    text: `Your GURHA Ratings ${enrolling ? 'setup' : 'sign-in'} code is ${c}\n\nIt expires in ${minutes} minutes. Never share it — admins will never ask for it.\nIf you didn't try to sign in, you can ignore this email.`,
    html: layout({
      preheader: `Your code expires in ${minutes} minutes.`,
      heading: enrolling ? 'Confirm your email' : 'Your sign-in code',
      body:
        p(enrolling ? 'Enter this code to turn on email codes for two-step verification:' : 'Enter this code to finish signing in:') +
        codeBox(c) +
        p(`It expires in <strong>${minutes} minutes</strong>. Never share it; admins will never ask for it.`) +
        p('<span style="color:#64748b;font-size:13px">Didn\'t try to sign in? You can ignore this email. Your password is still required.</span>'),
      footer: securityFooter,
    }),
  };
}

// ---------- Access requests ----------

function accessRequested({ name, email, note, pendingCount, repeat = false, previousStatus = null }) {
  const again = repeat ? (previousStatus === 'rejected' ? ' again (previously not approved)' : ' again (still waiting)') : '';
  return {
    kind: 'access_requested',
    subject: `Access request${repeat ? ' (repeat request)' : ''}: ${name}`,
    text: `${name} (${email}) requested rater access${again}.${note ? `\n\n"${note}"` : ''}\n\n${pendingCount} request(s) waiting. Review: ${config.appUrl}/admin/users\n\nTurn these alerts off on your account page.`,
    html: layout({
      preheader: `${name} wants to become a rater.`,
      heading: 'New access request',
      body:
        p(`<strong>${esc(name)}</strong> (${esc(email)}) requested rater access${esc(again)}.`) +
        (note ? `<blockquote style="margin:0 0 14px;padding:10px 14px;background:#f1f5f9;border-left:4px solid ${NAVY};border-radius:6px">${esc(note)}</blockquote>` : '') +
        p(`${pendingCount} request${pendingCount === 1 ? ' is' : 's are'} waiting for review.`) +
        button(`${config.appUrl}/admin/users`, 'Review requests'),
      footer: `You get these because you're a GURHA Ratings admin. Turn them off on <a href="${config.appUrl}/account" style="color:#64748b">your account page</a>.`,
    }),
  };
}

function accessApproved({ name }) {
  return {
    kind: 'access_approved',
    subject: "You're approved for GURHA Ratings",
    text: `Hi ${name},\n\nYour access to GURHA Ratings has been approved. Sign in at ${config.appUrl}/login\n\nOn your first sign-in you'll set up two-step verification (an authenticator app or email codes).\n\nRate what you see — not what you think.`,
    html: layout({
      preheader: 'Your rater access is ready.',
      heading: "You're approved!",
      body:
        p(`Hi ${esc(name)},`) +
        p('Your access to GURHA Ratings has been approved. Welcome to the rater bench.') +
        button(`${config.appUrl}/login`, 'Sign in') +
        p("On your first sign-in you'll set up two-step verification with an authenticator app or email codes.") +
        p('<em>Rate what you see — not what you think.</em>'),
    }),
  };
}

function accessRejected({ name }) {
  return {
    kind: 'access_rejected',
    subject: 'Your GURHA Ratings access request',
    text: `Hi ${name},\n\nYour request for access to GURHA Ratings wasn't approved. If you think this is a mistake, contact a GURHA admin.`,
    html: layout({
      preheader: 'An update on your access request.',
      heading: 'Access request update',
      body: p(`Hi ${esc(name)},`) + p("Your request for access to GURHA Ratings wasn't approved. If you think this is a mistake, contact a GURHA admin."),
    }),
  };
}

// ---------- Password & security ----------

function passwordReset({ link }) {
  return {
    kind: 'password_reset',
    subject: 'Reset your GURHA Ratings password',
    text: `Use this link to choose a new password (valid for 1 hour):\n${link}\n\nIf you didn't ask for this, ignore this email; your password won't change.`,
    html: layout({
      preheader: 'This link is valid for 1 hour.',
      heading: 'Reset your password',
      body:
        p('Someone (hopefully you) asked to reset your GURHA Ratings password.') +
        button(link, 'Choose a new password') +
        p('This link is valid for <strong>1 hour</strong> and can be used once.') +
        p(`<span style="color:#64748b;font-size:13px">If the button doesn't work, paste this into your browser:<br>${esc(link)}</span>`) +
        p("<span style=\"color:#64748b;font-size:13px\">Didn't ask for this? Ignore this email; your password won't change.</span>"),
    }),
  };
}

function securityNotice({ name, what }) {
  return {
    kind: 'security_notice',
    subject: `GURHA Ratings: ${what}`,
    text: `Hi ${name},\n\n${what} on your GURHA Ratings account.\n\nIf this was you, there's nothing to do. If it wasn't, reset your password now: ${config.appUrl}/forgot and tell an admin.`,
    html: layout({
      preheader: what,
      heading: 'Account security notice',
      body:
        p(`Hi ${esc(name)},`) +
        p(`<strong>${esc(what)}</strong> on your GURHA Ratings account.`) +
        p("If this was you, there's nothing to do. If it wasn't, reset your password right away and tell an admin.") +
        button(`${config.appUrl}/forgot`, 'Reset password'),
      footer: securityFooter,
    }),
  };
}

function test({ name }) {
  return {
    kind: 'test',
    subject: 'GURHA Ratings test email',
    text: `Hi ${name},\n\nThis is a test email from GURHA Ratings. If you're reading it, email delivery works.`,
    html: layout({
      preheader: 'Email delivery works.',
      heading: 'Test email',
      body: p(`Hi ${esc(name)},`) + p("This is a test from GURHA Ratings. If you're reading it, email delivery works. 🏒"),
    }),
  };
}

module.exports = { layout, code, accessRequested, accessApproved, accessRejected, passwordReset, securityNotice, test };
