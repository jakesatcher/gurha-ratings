'use strict';

require('dotenv').config({ quiet: true });

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function bool(v, dflt = false) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const sessionSecret = env.SESSION_SECRET || (isProd ? null : 'dev-only-insecure-secret');
if (!sessionSecret) {
  throw new Error('SESSION_SECRET must be set in production');
}

module.exports = {
  isProd,
  port: Number(env.PORT) || 3000,
  appName: env.APP_NAME || 'GURHA Ratings',
  timeZone: env.TIME_ZONE || 'America/New_York',
  appUrl: (env.APP_URL || `http://localhost:${Number(env.PORT) || 3000}`).replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL || 'postgres://localhost/gurha',
  databaseSsl: bool(env.DATABASE_SSL, false),
  sessionSecret,
  // Used to encrypt authenticator (TOTP) secrets at rest. Falls back to SESSION_SECRET.
  encryptionKey: env.ENCRYPTION_KEY || sessionSecret,
  showRaterNamesToRaters: bool(env.SHOW_RATER_NAMES_TO_RATERS, false),
  bootstrapAdmin: {
    email: env.ADMIN_EMAIL,
    password: env.ADMIN_PASSWORD,
    name: env.ADMIN_NAME || 'GURHA Admin',
  },
  mail: {
    from: env.MAIL_FROM || 'GURHA Ratings <no-reply@gurha.hockey>',
    resendApiKey: env.RESEND_API_KEY,
    smtp: env.SMTP_HOST
      ? {
          host: env.SMTP_HOST,
          port: Number(env.SMTP_PORT) || 587,
          secure: bool(env.SMTP_SECURE, Number(env.SMTP_PORT) === 465),
          auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
        }
      : null,
  },
  sportsEngine: {
    clientId: env.SPORTSENGINE_CLIENT_ID,
    clientSecret: env.SPORTSENGINE_CLIENT_SECRET,
    tokenUrl: env.SPORTSENGINE_TOKEN_URL || 'https://user.sportsengine.com/oauth/token',
    graphqlUrl: env.SPORTSENGINE_GRAPHQL_URL || 'https://api.sportsengine.com/graphql',
    organizationId: env.SPORTSENGINE_ORG_ID,
    seasonId: env.SPORTSENGINE_SEASON_ID,
    rosterQuery: env.SPORTSENGINE_ROSTER_QUERY,
  },
};
