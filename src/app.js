'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const helmet = require('helmet');

const config = require('./config');
const db = require('./db');
const { csrf, flash } = require('./middleware/security');
const { loadUser } = require('./middleware/auth');
const { loadSeason } = require('./lib/roster');
const levels = require('./lib/levels');
const ads = require('./lib/ads');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1); // Railway terminates TLS at its proxy
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          fontSrc: ["'self'"],
          styleSrcAttr: ["'unsafe-inline'"], // numeric bar widths only
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.isProd ? [] : null,
        },
      },
    })
  );

  app.get('/healthz', async (req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '7d' : 0 }));
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/favicon.svg'));

  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));

  app.use(
    session({
      store: new PgStore({ pool: db.pool, tableName: 'user_sessions', createTableIfMissing: false }),
      name: 'gurha.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProd,
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      },
    })
  );

  app.use((req, res, next) => {
    res.locals.appName = config.appName;
    res.locals.path = req.path;
    res.locals.url = req.originalUrl;
    res.locals.levels = levels;
    res.locals.title = null;
    res.locals.tz = config.timeZone;
    res.locals.ads = ads;
    res.locals.currentUser = null;
    res.locals.csrfToken = '';
    res.locals.flash = [];
    res.locals.fmt = (n, d = 2) => (n === null || n === undefined ? '—' : Number(n).toFixed(d));
    // Age from date of birth when known, otherwise the manually entered age.
    res.locals.ageOf = (p) => {
      if (!p || !p.birth_date) return p && p.age ? p.age : null;
      const b = new Date(p.birth_date);
      const now = new Date();
      let age = now.getUTCFullYear() - b.getUTCFullYear();
      if (now.getUTCMonth() < b.getUTCMonth() || (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate())) age--;
      return age;
    };
    // Date-only values ('YYYY-MM-DD') are shown as-is; timestamps in the league's time zone.
    res.locals.fmtDate = (d) => {
      if (!d) return '';
      const dateOnly = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
      return new Date(d).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', timeZone: dateOnly ? 'UTC' : config.timeZone,
      });
    };
    next();
  });

  app.use(flash);
  app.use(csrf);
  app.use(loadUser);
  app.use(loadSeason);

  app.use(require('./routes/auth'));
  app.use(require('./routes/account'));
  app.use(require('./routes/players'));
  app.use('/admin', require('./routes/admin'));

  app.get('/', (req, res) => res.redirect(req.user ? '/players' : '/login'));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: "That page doesn't exist." });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    const status = err.status || err.statusCode || 500;
    res.status(status).render('error', {
      title: status === 413 ? 'File too large' : 'Something went wrong',
      message: status === 413 ? 'That upload is too large.' : 'An unexpected error occurred. Please try again.',
    });
  });

  return app;
}

module.exports = { createApp };
