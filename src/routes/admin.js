'use strict';

const express = require('express');
const multer = require('multer');

const config = require('../config');
const db = require('../db');
const mailer = require('../lib/mailer');
const sportsengine = require('../lib/sportsengine');
const { requireAdmin } = require('../middleware/auth');
const { verifyCsrf } = require('../middleware/security');
const { audit } = require('../lib/audit');
const { parseUpload, upsertPlayers, previewPlayers, normalizePosition, parseDate } = require('../lib/players');
const { parseSportsEngineExport } = require('../lib/seExport');
const { isLevel } = require('../lib/levels');
const R = require('../lib/ratings');
const roster = require('../lib/roster');
const { nameKey } = require('../lib/identity');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

router.use(requireAdmin);
router.use(require('./admin-seasons'));
router.use(require('./admin-people'));

const id = (req) => Number(req.params.id) || 0;

// Most admin pages work on the season selected in the season bar.
function needSeason(req, res) {
  if (req.season) return true;
  req.flash('error', 'Create a season first.');
  res.redirect('/admin/seasons');
  return false;
}

// ---------- Dashboard ----------

router.get('/', async (req, res) => {
  const seasonId = req.season ? req.season.id : 0;
  const stats = await db.one(
    `SELECT
      (SELECT count(*) FROM users WHERE status = 'pending')::int AS pending,
      (SELECT count(*) FROM users WHERE status = 'approved')::int AS users,
      (SELECT count(*) FROM season_players sp JOIN players p ON p.id = sp.player_id WHERE sp.season_id = $1 AND p.active)::int AS players,
      (SELECT count(*) FROM ratings WHERE season_id = $1)::int AS ratings,
      (SELECT count(*) FROM season_players sp JOIN players p ON p.id = sp.player_id
        WHERE sp.season_id = $1 AND p.active AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.player_id = p.id AND r.season_id = $1))::int AS unrated`,
    [seasonId]
  );
  const players = req.season ? await roster.searchRoster(seasonId) : [];
  const summaries = await R.summariesForPlayers(players, seasonId);
  const flagged = players.filter((p) => summaries.get(p.id).needsReview);
  const weights = await db.one('SELECT coalesce(sum(weight), 0)::float AS total FROM categories WHERE active');
  res.render('admin/dashboard', {
    title: 'Admin',
    stats,
    flagged,
    summaries,
    weightTotal: weights.total,
    mailConfigured: mailer.isConfigured(),
    seConfigured: sportsengine.isConfigured(),
  });
});

// ---------- Users ----------

router.get('/users', async (req, res) => {
  const users = await db.many(
    `SELECT u.*, a.name AS approved_by_name, (SELECT count(*) FROM ratings r WHERE r.rater_id = u.id)::int AS rating_count
       FROM users u LEFT JOIN users a ON a.id = u.approved_by
      ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, lower(u.name)`
  );
  res.render('admin/users', { title: 'Users', users });
});

async function adminCount() {
  return (await db.one(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'approved'`)).n;
}

router.post('/users/:id/:action', async (req, res) => {
  const target = await db.one('SELECT * FROM users WHERE id = $1', [id(req)]);
  if (!target) return res.redirect('/admin/users');
  const { action } = req.params;
  const self = target.id === req.user.id;
  const isLastAdmin = target.role === 'admin' && target.status === 'approved' && (await adminCount()) <= 1;

  switch (action) {
    case 'approve':
      await db.query(`UPDATE users SET status = 'approved', approved_by = $1, approved_at = now(), updated_at = now() WHERE id = $2`, [
        req.user.id,
        target.id,
      ]);
      mailer
        .send({
          to: target.email,
          subject: 'Your GURHA Ratings access was approved',
          text: `Hi ${target.name},\n\nYour access to GURHA Ratings has been approved. Sign in at ${config.appUrl}/login\n\nYou'll be asked to set up two-step verification on your first sign-in.`,
          html: mailer.wrapHtml(
            'You’re approved!',
            `<p>Hi ${mailer.escapeHtml(target.name)},</p><p>Your access to GURHA Ratings has been approved.</p>
             <p><a href="${config.appUrl}/login" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Sign in</a></p>
             <p>You'll be asked to set up two-step verification on your first sign-in.</p>`
          ),
        })
        .catch((err) => console.error('Failed to send approval email', err));
      req.flash('success', `${target.name} approved.`);
      break;
    case 'reject':
      if (self) break;
      await db.query(`UPDATE users SET status = 'rejected', updated_at = now() WHERE id = $1`, [target.id]);
      req.flash('success', `${target.name}'s request rejected.`);
      break;
    case 'disable':
      if (self || isLastAdmin) {
        req.flash('error', 'You cannot disable yourself or the last admin.');
        break;
      }
      await db.query(`UPDATE users SET status = 'disabled', updated_at = now() WHERE id = $1`, [target.id]);
      await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId') = $1::text`, [target.id]);
      req.flash('success', `${target.name} disabled.`);
      break;
    case 'enable':
      await db.query(`UPDATE users SET status = 'approved', updated_at = now() WHERE id = $1`, [target.id]);
      req.flash('success', `${target.name} re-enabled.`);
      break;
    case 'make-admin':
      await db.query(`UPDATE users SET role = 'admin', updated_at = now() WHERE id = $1`, [target.id]);
      req.flash('success', `${target.name} is now an admin.`);
      break;
    case 'make-rater':
      if (self || isLastAdmin) {
        req.flash('error', 'You cannot remove your own admin role or the last admin.');
        break;
      }
      await db.query(`UPDATE users SET role = 'rater', updated_at = now() WHERE id = $1`, [target.id]);
      req.flash('success', `${target.name} is now a rater.`);
      break;
    case 'reset-mfa':
      await db.query(`UPDATE users SET mfa_method = NULL, totp_secret_enc = NULL, updated_at = now() WHERE id = $1`, [target.id]);
      await db.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId') = $1::text`, [target.id]);
      req.flash('success', `${target.name} will set up two-step verification again at next sign-in.`);
      break;
    default:
      return res.redirect('/admin/users');
  }
  await audit(req.user.id, `user_${action.replace('-', '_')}`, 'user', target.id, { email: target.email });
  res.redirect('/admin/users');
});

// ---------- Players ----------

router.get('/players', async (req, res) => {
  if (!needSeason(req, res)) return;
  const q = String(req.query.q || '').trim().slice(0, 100);
  const view = req.query.view === 'all' ? 'all' : 'season';
  let players;
  if (view === 'all') {
    // Every player, with their roster entry for the selected season if they have one.
    const params = [req.season.id];
    let where = '';
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where = `WHERE lower(p.first_name || ' ' || p.last_name) LIKE $2 OR lower(p.last_name || ', ' || p.first_name) LIKE $2`;
    }
    players = await db.many(
      `SELECT p.*, r.season_player_id, r.jersey_number, r.position, r.level_override, r.team, r.division, r.memberships,
              (SELECT count(DISTINCT season_id) FROM season_players x WHERE x.player_id = p.id)::int AS season_count
         FROM players p
         LEFT JOIN (${roster.ROSTER_SELECT} WHERE sp.season_id = $1) r ON r.id = p.id
         ${where}
        ORDER BY lower(p.last_name), lower(p.first_name) LIMIT 2000`,
      params
    );
  } else {
    players = await roster.searchRoster(req.season.id, { q, includeInactive: true });
  }
  const summaries = await R.summariesForPlayers(players, req.season.id);
  res.render('admin/players', { title: 'Manage players', players, summaries, q, view });
});

function playerFromBody(body) {
  const age = Number(body.age);
  return {
    first_name: String(body.first_name || '').trim().slice(0, 100),
    last_name: String(body.last_name || '').trim().slice(0, 100),
    age: Number.isInteger(age) && age > 0 && age < 120 ? age : null,
    birth_date: parseDate(String(body.birth_date || '').trim()),
    email: String(body.email || '').trim().slice(0, 200) || null,
    notes: String(body.notes || '').trim().slice(0, 2000) || null,
    active: body.active === undefined ? true : body.active === 'on' || body.active === 'true',
  };
}

const clip = (v, n) => String(v || '').trim().slice(0, n) || null;

// The season section of the player form: edits to existing team spots plus an optional new one.
function entryFromBody(body) {
  const ids = [].concat(body.membership_ids || []).map(Number).filter(Boolean);
  return {
    on_roster: body.on_roster === undefined || body.on_roster === 'on',
    updates: ids.map((mid) => ({
      id: mid,
      jersey_number: clip(body[`m_${mid}_jersey`], 10)?.replace(/^#/, '') || null,
      position: normalizePosition(body[`m_${mid}_position`]),
      is_sub: body[`m_${mid}_sub`] === 'on',
      remove: body[`m_${mid}_remove`] === 'on',
    })),
    add: {
      team: clip(body.team, 100),
      division: clip(body.division, 100),
      jersey_number: clip(body.jersey_number, 10)?.replace(/^#/, '') || null,
      position: normalizePosition(body.position),
      is_sub: body.is_sub === 'on',
    },
  };
}

const PLAYER_COLS = ['first_name', 'last_name', 'name_key', 'age', 'birth_date', 'email', 'notes', 'active'];

// Saves the player's roster for the season. Existing spots are written exactly as entered.
async function saveEntry(client, seasonId, playerId, e) {
  if (!e.on_roster) {
    await client.query('DELETE FROM season_players WHERE season_id = $1 AND player_id = $2', [seasonId, playerId]);
    return;
  }
  const spId = await roster.ensureSeasonPlayer(client, seasonId, playerId);
  for (const u of e.updates) {
    if (u.remove) {
      await client.query('DELETE FROM team_rosters WHERE id = $1 AND season_player_id = $2', [u.id, spId]);
    } else {
      await client.query(
        'UPDATE team_rosters SET jersey_number = $1, position = $2, is_sub = $3, updated_at = now() WHERE id = $4 AND season_player_id = $5',
        [u.jersey_number, u.position, u.is_sub, u.id, spId]
      );
    }
  }
  const team = e.add.team ? await roster.findOrCreateTeam(client, seasonId, { name: e.add.team, division: e.add.division }) : null;
  await roster.upsertMembership(client, spId, { team_id: team && team.id, ...e.add });
}

async function renderPlayerForm(req, res, { player, entry, errors = [], status = 200 }) {
  // Other records that could be the same person (same name, or same last name + date of birth).
  const similar = player.id
    ? await db.many(
        `SELECT p.id, p.first_name, p.last_name, p.birth_date FROM players p
          WHERE p.id <> $1 AND (p.name_key = $2 OR (split_part(p.name_key, '|', 2) = split_part($2, '|', 2)))
          ORDER BY (p.name_key = $2) DESC, p.last_name, p.first_name LIMIT 20`,
        [player.id, player.name_key || '']
      )
    : [];
  const externalIds = player.id
    ? (await db.many('SELECT external_id FROM player_external_ids WHERE player_id = $1 ORDER BY id', [player.id])).map((r) => r.external_id)
    : [];
  res.status(status).render('admin/player-form', {
    title: player.id ? 'Edit player' : 'Add player',
    player,
    entry,
    errors,
    similar,
    externalIds,
    teams: await roster.seasonTeams(req.season.id),
  });
}

router.get('/players/new', async (req, res) => {
  if (!needSeason(req, res)) return;
  await renderPlayerForm(req, res, { player: { active: true }, entry: { on_roster: true, memberships: [] } });
});

router.post('/players', async (req, res) => {
  if (!needSeason(req, res)) return;
  const p = playerFromBody(req.body);
  p.name_key = nameKey(p.first_name, p.last_name);
  const e = entryFromBody({ ...req.body, on_roster: 'on' });
  if (!p.first_name || !p.last_name) {
    return renderPlayerForm(req, res, { player: p, entry: { on_roster: true, memberships: [], ...e.add }, errors: ['First and last name are required.'], status: 422 });
  }
  const row = await db.tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO players (${PLAYER_COLS.join(', ')}, source) VALUES (${PLAYER_COLS.map((_, i) => `$${i + 1}`).join(', ')}, 'manual') RETURNING id`,
      PLAYER_COLS.map((col) => p[col])
    );
    await saveEntry(c, req.season.id, rows[0].id, e);
    await audit(req.user.id, 'player_created', 'player', rows[0].id, { name: `${p.first_name} ${p.last_name}`, season_id: req.season.id }, c);
    return rows[0];
  });
  req.flash('success', `${p.first_name} ${p.last_name} added to ${req.season.name}.`);
  res.redirect(req.body.add_another ? '/admin/players/new' : `/players/${row.id}`);
});

router.get('/players/:id/edit', async (req, res) => {
  if (!needSeason(req, res)) return;
  const player = await db.one('SELECT * FROM players WHERE id = $1', [id(req)]);
  if (!player) return res.redirect('/admin/players');
  const entry = await roster.seasonPlayer(req.season.id, player.id);
  await renderPlayerForm(req, res, { player, entry: entry ? { ...entry, on_roster: true } : { on_roster: false, memberships: [] } });
});

router.post('/players/:id', async (req, res) => {
  if (!needSeason(req, res)) return;
  const existing = await db.one('SELECT * FROM players WHERE id = $1', [id(req)]);
  if (!existing) return res.redirect('/admin/players');
  const p = playerFromBody({ ...req.body, active: req.body.active || 'off' });
  p.name_key = nameKey(p.first_name, p.last_name);
  const e = entryFromBody({ ...req.body, on_roster: req.body.on_roster || 'off' });
  if (!p.first_name || !p.last_name) {
    const entry = await roster.seasonPlayer(req.season.id, existing.id);
    return renderPlayerForm(req, res, { player: { ...existing, ...p }, entry: entry ? { ...entry, on_roster: true } : { on_roster: false, memberships: [] }, errors: ['First and last name are required.'], status: 422 });
  }
  await db.tx(async (c) => {
    await c.query(
      `UPDATE players SET ${PLAYER_COLS.map((col, i) => `${col} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${PLAYER_COLS.length + 1}`,
      [...PLAYER_COLS.map((col) => p[col]), existing.id]
    );
    await saveEntry(c, req.season.id, existing.id, e);
    await audit(req.user.id, 'player_updated', 'player', existing.id, { season_id: req.season.id, on_roster: e.on_roster }, c);
  });
  req.flash('success', 'Player updated.');
  res.redirect(`/players/${existing.id}`);
});

router.post('/players/:id/delete', async (req, res) => {
  const player = await db.one('SELECT * FROM players WHERE id = $1', [id(req)]);
  if (player) {
    await db.query('DELETE FROM players WHERE id = $1', [player.id]);
    await audit(req.user.id, 'player_deleted', 'player', player.id, { name: `${player.first_name} ${player.last_name}` });
    req.flash('success', `${player.first_name} ${player.last_name} and all of their ratings were deleted.`);
  }
  res.redirect('/admin/players');
});

router.post('/players/:id/override', async (req, res) => {
  if (!needSeason(req, res)) return;
  const entry = await roster.seasonPlayer(req.season.id, id(req));
  if (!entry) {
    req.flash('error', `That player isn't on the ${req.season.name} roster.`);
    return res.redirect(`/players/${id(req)}`);
  }
  const level = isLevel(req.body.level_override) ? req.body.level_override : null;
  const note = String(req.body.level_override_note || '').trim().slice(0, 1000) || null;
  await db.query('UPDATE season_players SET level_override = $1, level_override_note = $2, updated_at = now() WHERE id = $3', [
    level,
    level ? note : null,
    entry.season_player_id,
  ]);
  await audit(req.user.id, level ? 'level_override_set' : 'level_override_cleared', 'player', entry.id, { level, note, season_id: req.season.id });
  req.flash('success', level ? `${req.season.name} final level set to ${level}.` : 'Level override cleared.');
  res.redirect(`/players/${entry.id}`);
});

// ---------- Import ----------

router.get('/import', (req, res) => {
  if (!needSeason(req, res)) return;
  res.render('admin/import', { title: 'Import players', result: null, seConfigured: sportsengine.isConfigured() });
});

router.post('/import', upload.single('file'), verifyCsrf, async (req, res) => {
  if (!needSeason(req, res)) return;
  if (Number(req.body.season_id) !== req.season.id) {
    req.flash('error', 'The selected season changed. Please check the season and import again.');
    return res.redirect('/admin/import');
  }
  let rows;
  try {
    if (req.file) rows = parseUpload(req.file.buffer, req.file.originalname);
    else if (req.body.pasted && req.body.pasted.trim()) rows = parseUpload(Buffer.from(req.body.pasted), '');
    else throw new Error('Choose a CSV or JSON file, or paste data.');
  } catch (err) {
    req.flash('error', `Could not read import: ${err.message}`);
    return res.redirect('/admin/import');
  }
  const result = await db.tx((c) => upsertPlayers(rows, 'import', req.season.id, c));
  await audit(req.user.id, 'players_imported', 'season', req.season.id, { created: result.created, updated: result.updated, skipped: result.skipped });
  res.render('admin/import', { title: 'Import players', result, seConfigured: sportsengine.isConfigured() });
});

// ---------- SportsEngine roster export (.xls) ----------
// Upload → review (pick teams and the target season) → import. The parsed file is held in the
// session between steps (it never touches disk) and cleared once imported or cancelled.

const SE_EXPORT_TTL_MS = 60 * 60 * 1000;

function pendingExport(req) {
  const p = req.session.seExport;
  if (!p || Date.now() - p.at > SE_EXPORT_TTL_MS) {
    delete req.session.seExport;
    return null;
  }
  return p;
}

router.post('/import/sportsengine', upload.single('file'), verifyCsrf, async (req, res) => {
  if (!req.file) {
    req.flash('error', 'Choose the SportsEngine .xls export to upload.');
    return res.redirect('/admin/import');
  }
  try {
    const parsed = parseSportsEngineExport(req.file.buffer);
    req.session.seExport = { filename: String(req.file.originalname || 'export.xls').slice(0, 200), at: Date.now(), parsed };
  } catch (err) {
    req.flash('error', `Could not read the SportsEngine export: ${err.message}`);
    return res.redirect('/admin/import');
  }
  res.redirect('/admin/import/sportsengine');
});

router.get('/import/sportsengine', async (req, res) => {
  const pending = pendingExport(req);
  if (!pending) {
    req.flash('info', 'Upload a SportsEngine export to start.');
    return res.redirect('/admin/import');
  }
  const localSeasons = await roster.listSeasons();
  const suggested = pending.parsed.suggestedSeasonName;
  const match = localSeasons.find((s) => suggested && s.name.toLowerCase() === suggested.toLowerCase()) || null;

  // Show how every row will be matched: existing person, same person as another row, or new.
  const rows = pending.parsed.teams.flatMap((t) =>
    t.players.map((pl) => ({ ...pl, team: t.team, __label: `${t.team}${pl.jersey_number ? ` #${pl.jersey_number}` : ''}` }))
  );
  const statuses = await previewPlayers(rows, match ? match.id : null);
  let i = 0;
  const preview = pending.parsed.teams.map((t) => t.players.map(() => statuses[i++]));
  const counts = statuses.reduce((acc, st) => ((acc[st.status] = (acc[st.status] || 0) + 1), acc), {});
  // Distinct people: each existing player once, plus every new row (in-file repeats already excluded).
  counts.people = new Set(statuses.filter((st) => st.status === 'existing').map((st) => st.player_id)).size + (counts.new || 0) + (counts['new-ambiguous'] || 0);
  counts.multiTeam = rows.length - counts.people - (counts.error || 0);
  res.render('admin/se-export', { title: 'Review SportsEngine export', pending, localSeasons, match, preview, counts, result: null });
});

router.post('/import/sportsengine/confirm', async (req, res) => {
  const pending = pendingExport(req);
  if (!pending) {
    req.flash('error', 'That upload expired. Please upload the file again.');
    return res.redirect('/admin/import');
  }
  const picked = new Set([].concat(req.body.sheets || []).map(Number));
  const teams = pending.parsed.teams.filter((t, i) => picked.has(i));
  if (!teams.length) {
    req.flash('error', 'Select at least one team to import.');
    return res.redirect('/admin/import/sportsengine');
  }

  let season;
  if (req.body.target === 'new') {
    const name = String(req.body.new_season_name || '').trim().slice(0, 100);
    if (!name) {
      req.flash('error', 'Enter a name for the new season.');
      return res.redirect('/admin/import/sportsengine');
    }
    if (await db.one('SELECT 1 FROM seasons WHERE lower(name) = lower($1)', [name])) {
      req.flash('error', `A season named "${name}" already exists. Choose it from the list instead.`);
      return res.redirect('/admin/import/sportsengine');
    }
  } else {
    season = await db.one('SELECT * FROM seasons WHERE id = $1', [Number(req.body.target) || 0]);
    if (!season) {
      req.flash('error', 'Choose a season to import into.');
      return res.redirect('/admin/import/sportsengine');
    }
  }

  const result = await db.tx(async (c) => {
    if (!season) {
      season = (await c.query('INSERT INTO seasons (name) VALUES ($1) RETURNING *', [String(req.body.new_season_name).trim().slice(0, 100)])).rows[0];
      if (req.body.make_current === 'on') {
        await c.query('UPDATE seasons SET is_current = false WHERE is_current');
        await c.query('UPDATE seasons SET is_current = true WHERE id = $1', [season.id]);
      }
      await audit(req.user.id, 'season_created', 'season', season.id, { name: season.name, source: 'sportsengine_export' }, c);
    }
    const total = { created: 0, updated: 0, skipped: 0, errors: [], matches: [], ambiguous: [] };
    const seen = new Set(); // people already handled in this import (someone on two sheets counts once)
    for (const t of teams) {
      await roster.findOrCreateTeam(c, season.id, { name: t.team, division: t.division, external_id: t.team_external_id });
      const rows = t.players.map((p) => ({ ...p, team: t.team, division: t.division, team_external_id: t.team_external_id }));
      const r = await upsertPlayers(rows, 'sportsengine', season.id, c, { seen });
      total.created += r.created;
      total.updated += r.updated;
      total.skipped += r.skipped;
      total.errors.push(...r.errors.map((e) => `${t.team}: ${e}`));
      total.matches.push(...r.matches.map((m) => ({ ...m, team: t.team })));
      total.ambiguous.push(...r.ambiguous.map((m) => ({ ...m, team: t.team })));
    }
    await audit(req.user.id, 'sportsengine_export_import', 'season', season.id, {
      file: pending.filename,
      teams: teams.map((t) => t.team),
      created: total.created,
      updated: total.updated,
      skipped: total.skipped,
    }, c);
    return total;
  });

  delete req.session.seExport;
  req.session.seasonId = season.id;
  res.render('admin/se-export', { title: 'SportsEngine export imported', pending: null, result, importSeason: season, teamCount: teams.length });
});

router.post('/import/sportsengine/cancel', (req, res) => {
  delete req.session.seExport;
  req.flash('info', 'Import cancelled. Nothing was saved.');
  res.redirect('/admin/import');
});

router.get('/import/template.csv', (req, res) => {
  res.type('text/csv').attachment('gurha-players-template.csv');
  res.send('first_name,last_name,jersey_number,team,division,position,age,email,external_id\nWayne,Example,99,Blue Liners,C2,F,42,wayne@example.com,\n');
});

// ---------- Ratings (admin edit / delete) ----------

router.get('/ratings/:id/edit', async (req, res) => {
  const { ratings, categories } = await R.loadRatings({ ratingId: id(req) });
  const rating = ratings[0];
  if (!rating) return res.redirect('/players');
  const player = await ratingPlayer(rating);
  res.render('ratings/form', {
    title: `Edit rating – ${player.first_name} ${player.last_name}`,
    player,
    categories,
    values: ratingToValues(rating),
    errors: [],
    mode: 'edit',
    rating,
    R,
  });
});

// The player as rostered in the rating's season (falls back to the bare player record).
async function ratingPlayer(rating) {
  return (await roster.seasonPlayer(rating.season_id, rating.player_id)) || db.one('SELECT * FROM players WHERE id = $1', [rating.player_id]);
}

function ratingToValues(r) {
  const v = { ...r };
  for (const s of r.scores) {
    v[`score_${s.category_id}`] = String(s.score);
    v[`comment_${s.category_id}`] = s.comment || '';
  }
  v.age_limited = r.age_limited === true ? 'yes' : r.age_limited === false ? 'no' : '';
  return v;
}

router.post('/ratings/:id', async (req, res) => {
  const { ratings, categories } = await R.loadRatings({ ratingId: id(req) });
  const rating = ratings[0];
  if (!rating) return res.redirect('/players');
  const { errors, data, scores } = R.parseRatingForm(req.body, categories);
  if (errors.length) {
    const player = await ratingPlayer(rating);
    return res.status(422).render('ratings/form', {
      title: `Edit rating – ${player.first_name} ${player.last_name}`, player, categories, values: req.body, errors, mode: 'edit', rating, R,
    });
  }
  const before = { overall: rating.overall, final_level: rating.final_level, scores: rating.scores.map((s) => [s.category_id, s.score]) };
  await db.tx(async (c) => {
    await R.updateRating(c, rating.id, req.user.id, data, scores);
    await audit(req.user.id, 'rating_updated', 'rating', rating.id, {
      player_id: rating.player_id,
      rater_id: rating.rater_id,
      before,
      after: { final_level: data.final_level, scores: scores.map((s) => [s.category_id, s.score]) },
      reason: String(req.body.admin_reason || '').trim().slice(0, 1000) || null,
    }, c);
  });
  req.flash('success', 'Rating updated.');
  res.redirect(`/players/${rating.player_id}#rating-${rating.id}`);
});

router.post('/ratings/:id/delete', async (req, res) => {
  const rating = await db.one('SELECT * FROM ratings WHERE id = $1', [id(req)]);
  if (!rating) return res.redirect('/players');
  await db.query('DELETE FROM ratings WHERE id = $1', [rating.id]);
  await audit(req.user.id, 'rating_deleted', 'rating', rating.id, { player_id: rating.player_id, rater_id: rating.rater_id });
  req.flash('success', 'Rating deleted. That rater can now submit a new rating for this player.');
  res.redirect(`/players/${rating.player_id}`);
});

// ---------- Categories ----------

router.get('/categories', async (req, res) => {
  const categories = await R.getCategories({ includeInactive: true });
  const total = categories.filter((c) => c.active).reduce((a, c) => a + Number(c.weight), 0);
  res.render('admin/categories', { title: 'Rating categories', categories, total });
});

function categoryFromBody(body) {
  const lines = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const guide = lines(body.guide).map((line) => {
    // Format: "0–3 | D Level | description"
    const [range, label, ...rest] = line.split('|').map((x) => x.trim());
    return { range: range || '', label: label || '', text: rest.join(' | ') };
  });
  return {
    name: String(body.name || '').trim().slice(0, 100),
    weight: Math.max(0, Math.min(100, Number(body.weight) || 0)),
    min_score: Number.isInteger(Number(body.min_score)) ? Number(body.min_score) : 0,
    max_score: Number.isInteger(Number(body.max_score)) ? Number(body.max_score) : 11,
    considerations: lines(body.considerations),
    key_question: String(body.key_question || '').trim() || null,
    note: String(body.note || '').trim() || null,
    guide: JSON.stringify(guide),
    sort_order: Number(body.sort_order) || 0,
    active: body.active === 'on',
  };
}

router.post('/categories', async (req, res) => {
  const c = categoryFromBody({ ...req.body, active: 'on' });
  if (!c.name || c.max_score <= c.min_score) {
    req.flash('error', 'Category needs a name and a valid score range.');
    return res.redirect('/admin/categories');
  }
  const key = `${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}_${Date.now().toString(36)}`;
  const row = await db.one(
    `INSERT INTO categories (key, name, weight, min_score, max_score, considerations, key_question, note, guide, sort_order, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) RETURNING id`,
    [key, c.name, c.weight, c.min_score, c.max_score, c.considerations, c.key_question, c.note, c.guide, c.sort_order]
  );
  await audit(req.user.id, 'category_created', 'category', row.id, { name: c.name, weight: c.weight });
  req.flash('success', `Category "${c.name}" added. Existing ratings won't have a score for it until edited.`);
  res.redirect('/admin/categories');
});

router.post('/categories/:id', async (req, res) => {
  const existing = await db.one('SELECT * FROM categories WHERE id = $1', [id(req)]);
  if (!existing) return res.redirect('/admin/categories');
  const c = categoryFromBody(req.body);
  if (!c.name || c.max_score <= c.min_score) {
    req.flash('error', 'Category needs a name and a valid score range.');
    return res.redirect('/admin/categories');
  }
  await db.query(
    `UPDATE categories SET name=$1, weight=$2, min_score=$3, max_score=$4, considerations=$5, key_question=$6, note=$7,
            guide=$8, sort_order=$9, active=$10, updated_at=now() WHERE id=$11`,
    [c.name, c.weight, c.min_score, c.max_score, c.considerations, c.key_question, c.note, c.guide, c.sort_order, c.active, existing.id]
  );
  await audit(req.user.id, 'category_updated', 'category', existing.id, {
    before: { name: existing.name, weight: Number(existing.weight), active: existing.active },
    after: { name: c.name, weight: c.weight, active: c.active },
  });
  req.flash('success', `Category "${c.name}" saved.`);
  res.redirect('/admin/categories');
});

// ---------- Export ----------

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

router.get('/export.csv', async (req, res) => {
  if (!needSeason(req, res)) return;
  const players = await roster.searchRoster(req.season.id, { includeInactive: true });
  players.sort((a, b) => (a.team || '').localeCompare(b.team || '') || a.last_name.localeCompare(b.last_name));
  const categories = await R.getCategories();
  const summaries = await R.summariesForPlayers(players, req.season.id);
  const header = ['season', 'player_id', 'first_name', 'last_name', 'jersey_number', 'team', 'division', 'all_teams', 'position', 'active', 'ratings_count',
    ...categories.map((c) => `avg_${c.key}`), 'avg_overall', 'calculated_level', 'avg_recommended_level', 'level_override', 'final_level', 'needs_third_review'];
  const lines = [header.join(',')];
  for (const p of players) {
    const s = summaries.get(p.id);
    lines.push([
      req.season.name, p.id, p.first_name, p.last_name, p.jersey_number, p.team, p.division,
      p.memberships.map((m) => `${m.team || 'No team'}${m.jersey_number ? ` #${m.jersey_number}` : ''}${m.is_sub ? ' (sub)' : ''}`).join('; '),
      p.position, p.active, s.count,
      ...categories.map((c) => s.categoryAverages[c.id]), s.avgOverall, s.calculatedLevel, s.recommendedLevel, p.level_override, s.level,
      s.needsReview,
    ].map(csvCell).join(','));
  }
  const slug = req.season.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  res.type('text/csv').attachment(`gurha-ratings-${slug}-${new Date().toISOString().slice(0, 10)}.csv`);
  res.send(lines.join('\n') + '\n');
});

// ---------- Audit log ----------

router.get('/audit', async (req, res) => {
  const entries = await db.many(
    `SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT 300`
  );
  res.render('admin/audit', { title: 'Audit log', entries });
});

module.exports = router;
