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
const { parseUpload, upsertPlayers, normalizePosition } = require('../lib/players');
const { isLevel } = require('../lib/levels');
const R = require('../lib/ratings');
const { searchPlayers } = require('./players');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

router.use(requireAdmin);

const id = (req) => Number(req.params.id) || 0;

// ---------- Dashboard ----------

router.get('/', async (req, res) => {
  const stats = await db.one(`SELECT
      (SELECT count(*) FROM users WHERE status = 'pending')::int AS pending,
      (SELECT count(*) FROM users WHERE status = 'approved')::int AS users,
      (SELECT count(*) FROM players WHERE active)::int AS players,
      (SELECT count(*) FROM ratings)::int AS ratings,
      (SELECT count(*) FROM players p WHERE active AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.player_id = p.id))::int AS unrated`);
  const players = await db.many('SELECT * FROM players WHERE active');
  const summaries = await R.summariesForPlayers(players);
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
  const q = String(req.query.q || '').trim();
  const players = await searchPlayers({ q, includeInactive: true });
  const summaries = await R.summariesForPlayers(players);
  res.render('admin/players', { title: 'Manage players', players, summaries, q });
});

function playerFromBody(body) {
  const age = Number(body.age);
  return {
    first_name: String(body.first_name || '').trim().slice(0, 100),
    last_name: String(body.last_name || '').trim().slice(0, 100),
    jersey_number: String(body.jersey_number || '').trim().replace(/^#/, '').slice(0, 10) || null,
    team: String(body.team || '').trim().slice(0, 100) || null,
    division: String(body.division || '').trim().slice(0, 100) || null,
    position: normalizePosition(body.position),
    age: Number.isInteger(age) && age > 0 && age < 120 ? age : null,
    email: String(body.email || '').trim().slice(0, 200) || null,
    notes: String(body.notes || '').trim().slice(0, 2000) || null,
    active: body.active === undefined ? true : body.active === 'on' || body.active === 'true',
  };
}

const PLAYER_COLS = ['first_name', 'last_name', 'jersey_number', 'team', 'division', 'position', 'age', 'email', 'notes', 'active'];

router.get('/players/new', (req, res) => {
  res.render('admin/player-form', { title: 'Add player', player: { active: true }, errors: [] });
});

router.post('/players', async (req, res) => {
  const p = playerFromBody(req.body);
  if (!p.first_name || !p.last_name) {
    return res.status(422).render('admin/player-form', { title: 'Add player', player: p, errors: ['First and last name are required.'] });
  }
  const row = await db.one(
    `INSERT INTO players (${PLAYER_COLS.join(', ')}, source) VALUES (${PLAYER_COLS.map((_, i) => `$${i + 1}`).join(', ')}, 'manual') RETURNING id`,
    PLAYER_COLS.map((c) => p[c])
  );
  await audit(req.user.id, 'player_created', 'player', row.id, { name: `${p.first_name} ${p.last_name}` });
  req.flash('success', `${p.first_name} ${p.last_name} added.`);
  res.redirect(req.body.add_another ? '/admin/players/new' : `/players/${row.id}`);
});

router.get('/players/:id/edit', async (req, res) => {
  const player = await db.one('SELECT * FROM players WHERE id = $1', [id(req)]);
  if (!player) return res.redirect('/admin/players');
  res.render('admin/player-form', { title: 'Edit player', player, errors: [] });
});

router.post('/players/:id', async (req, res) => {
  const existing = await db.one('SELECT * FROM players WHERE id = $1', [id(req)]);
  if (!existing) return res.redirect('/admin/players');
  const p = playerFromBody({ ...req.body, active: req.body.active || 'off' });
  if (!p.first_name || !p.last_name) {
    return res.status(422).render('admin/player-form', { title: 'Edit player', player: { ...existing, ...p }, errors: ['First and last name are required.'] });
  }
  await db.query(
    `UPDATE players SET ${PLAYER_COLS.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${PLAYER_COLS.length + 1}`,
    [...PLAYER_COLS.map((c) => p[c]), existing.id]
  );
  await audit(req.user.id, 'player_updated', 'player', existing.id);
  req.flash('success', 'Player updated.');
  res.redirect(`/players/${existing.id}`);
});

router.post('/players/:id/delete', async (req, res) => {
  const player = await db.one('SELECT * FROM players WHERE id = $1', [id(req)]);
  if (player) {
    await db.query('DELETE FROM players WHERE id = $1', [player.id]);
    await audit(req.user.id, 'player_deleted', 'player', player.id, { name: `${player.first_name} ${player.last_name}` });
    req.flash('success', `${player.first_name} ${player.last_name} and their ratings were deleted.`);
  }
  res.redirect('/admin/players');
});

router.post('/players/:id/override', async (req, res) => {
  const player = await db.one('SELECT * FROM players WHERE id = $1', [id(req)]);
  if (!player) return res.redirect('/admin/players');
  const level = isLevel(req.body.level_override) ? req.body.level_override : null;
  const note = String(req.body.level_override_note || '').trim().slice(0, 1000) || null;
  await db.query('UPDATE players SET level_override = $1, level_override_note = $2, updated_at = now() WHERE id = $3', [
    level,
    level ? note : null,
    player.id,
  ]);
  await audit(req.user.id, level ? 'level_override_set' : 'level_override_cleared', 'player', player.id, { level, note });
  req.flash('success', level ? `Final level set to ${level}.` : 'Level override cleared.');
  res.redirect(`/players/${player.id}`);
});

// ---------- Import ----------

router.get('/import', (req, res) => {
  res.render('admin/import', { title: 'Import players', result: null, seConfigured: sportsengine.isConfigured() });
});

router.post('/import', upload.single('file'), verifyCsrf, async (req, res) => {
  let rows;
  try {
    if (req.file) rows = parseUpload(req.file.buffer, req.file.originalname);
    else if (req.body.pasted && req.body.pasted.trim()) rows = parseUpload(Buffer.from(req.body.pasted), '');
    else throw new Error('Choose a CSV or JSON file, or paste data.');
  } catch (err) {
    req.flash('error', `Could not read import: ${err.message}`);
    return res.redirect('/admin/import');
  }
  const result = await db.tx((c) => upsertPlayers(rows, 'import', c));
  await audit(req.user.id, 'players_imported', 'player', null, { created: result.created, updated: result.updated, skipped: result.skipped });
  res.render('admin/import', { title: 'Import players', result, seConfigured: sportsengine.isConfigured() });
});

router.post('/sportsengine/sync', async (req, res) => {
  try {
    const rows = await sportsengine.fetchRoster();
    if (!rows.length) throw new Error('No players were found in the SportsEngine response. Check the org/season IDs and query.');
    const result = await db.tx((c) => upsertPlayers(rows, 'sportsengine', c));
    await audit(req.user.id, 'sportsengine_sync', 'player', null, { created: result.created, updated: result.updated, skipped: result.skipped });
    res.render('admin/import', { title: 'Import players', result, seConfigured: true });
  } catch (err) {
    console.error(err);
    req.flash('error', err.message);
    res.redirect('/admin/import');
  }
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
  const player = await db.one('SELECT * FROM players WHERE id = $1', [rating.player_id]);
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
    const player = await db.one('SELECT * FROM players WHERE id = $1', [rating.player_id]);
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
  const players = await db.many('SELECT * FROM players ORDER BY lower(team), lower(last_name), lower(first_name)');
  const categories = await R.getCategories();
  const summaries = await R.summariesForPlayers(players);
  const header = ['player_id', 'first_name', 'last_name', 'jersey_number', 'team', 'division', 'position', 'active', 'ratings_count',
    ...categories.map((c) => `avg_${c.key}`), 'avg_overall', 'calculated_level', 'avg_recommended_level', 'level_override', 'final_level', 'needs_third_review'];
  const lines = [header.join(',')];
  for (const p of players) {
    const s = summaries.get(p.id);
    lines.push([
      p.id, p.first_name, p.last_name, p.jersey_number, p.team, p.division, p.position, p.active, s.count,
      ...categories.map((c) => s.categoryAverages[c.id]), s.avgOverall, s.calculatedLevel, s.recommendedLevel, p.level_override, s.level,
      s.needsReview,
    ].map(csvCell).join(','));
  }
  res.type('text/csv').attachment(`gurha-ratings-${new Date().toISOString().slice(0, 10)}.csv`);
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
