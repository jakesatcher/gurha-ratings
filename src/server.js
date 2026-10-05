'use strict';

const bcrypt = require('bcryptjs');
const config = require('./config');
const db = require('./db');
const { migrate } = require('./db/migrate');
const { createApp } = require('./app');
const { backfillNameKeys } = require('./lib/identity');

async function bootstrapAdmin() {
  const { email, password, name } = config.bootstrapAdmin;
  if (!email) return;
  const existing = await db.one('SELECT id, role, status FROM users WHERE lower(email) = lower($1)', [email]);
  if (existing) {
    if (existing.role !== 'admin' || existing.status !== 'approved') {
      await db.query(`UPDATE users SET role = 'admin', status = 'approved', updated_at = now() WHERE id = $1`, [existing.id]);
      console.log(`Promoted ${email} to approved admin`);
    }
    return;
  }
  if (!password || password.length < 10) {
    console.warn('ADMIN_EMAIL is set but ADMIN_PASSWORD is missing or shorter than 10 characters; skipping admin bootstrap.');
    return;
  }
  await db.query(
    `INSERT INTO users (email, name, password_hash, role, status, approved_at) VALUES ($1, $2, $3, 'admin', 'approved', now())`,
    [email.trim(), name, await bcrypt.hash(password, 12)]
  );
  console.log(`Created bootstrap admin ${email}`);
}

async function main() {
  await migrate();
  await backfillNameKeys();
  await bootstrapAdmin();
  for (const w of require('./lib/mailer').configWarnings()) console.warn(`[email] ${w}`);
  const app = createApp();
  app.listen(config.port, () => console.log(`${config.appName} listening on port ${config.port}`));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { bootstrapAdmin };
