'use strict';

// Admin → Paper forms: print multi-player rating sheets for raters without accounts, then enter the
// filled-in sheets (optionally attaching the scan). Mounted inside the admin router, so admin-only.
const express = require('express');
const multer = require('multer');

const db = require('../db');
const R = require('../lib/ratings');
const roster = require('../lib/roster');
const paper = require('../lib/paper');
const { audit } = require('../lib/audit');
const { verifyCsrf } = require('../middleware/security');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: paper.MAX_SCAN_BYTES, files: 1 } });
const id = (req) => Number(req.params.id) || 0;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function needSeason(req, res) {
  if (req.season) return true;
  req.flash('error', 'Create a season first.');
  res.redirect('/admin/seasons');
  return false;
}

// Everyone who can be credited with a paper rating: paper raters first, then account raters/admins.
async function raterChoices() {
  return db.many(
    `SELECT id, name, email, role, can_login,
            (SELECT count(*) FROM ratings r WHERE r.rater_id = u.id)::int AS rating_count
       FROM users u
      WHERE status = 'approved' AND role IN ('rater', 'admin')
      ORDER BY can_login, lower(name)`
  );
}

// ---------- Forms list & builder ----------

router.get('/paper', async (req, res) => {
  if (!needSeason(req, res)) return;
  const forms = await db.many(
    `SELECT f.*, t.name AS team_name,
            (SELECT count(*) FROM paper_submissions s WHERE s.form_id = f.id)::int AS submissions,
            (SELECT count(*) FROM ratings r JOIN paper_submissions s ON s.id = r.paper_submission_id WHERE s.form_id = f.id)::int AS ratings
       FROM paper_forms f LEFT JOIN teams t ON t.id = f.team_id
      WHERE f.season_id = $1 ORDER BY f.id DESC`,
    [req.season.id]
  );
  const teams = await roster.seasonTeams(req.season.id);
  const paperRaters = (await raterChoices()).filter((u) => !u.can_login);
  res.render('admin/paper', { title: 'Paper forms', forms, teams, paperRaters });
});

// Creates one form per selected team (its whole roster, regulars first).
router.post('/paper/forms', async (req, res) => {
  if (!needSeason(req, res)) return;
  const teamIds = [].concat(req.body.team_ids || []).map(Number).filter(Boolean);
  const blankRows = Math.max(0, Math.min(10, Number(req.body.blank_rows) || 0));
  if (!teamIds.length) {
    req.flash('error', 'Choose at least one team.');
    return res.redirect('/admin/paper');
  }
  const categories = await R.getCategories();
  const created = await db.tx(async (c) => {
    const out = [];
    for (const teamId of teamIds) {
      const team = (await c.query('SELECT * FROM teams WHERE id = $1 AND season_id = $2', [teamId, req.season.id])).rows[0];
      if (!team) continue;
      const players = await roster.teamRoster(team.id);
      const f = await paper.createForm(c, {
        seasonId: req.season.id,
        teamId: team.id,
        title: team.name,
        playerIds: players.map((p) => p.id),
        categoryIds: categories.map((cat) => cat.id),
        blankRows,
        userId: req.user.id,
      });
      await audit(req.user.id, 'paper_form_created', 'paper_form', f.id, { code: f.code, team: team.name, players: players.length }, c);
      out.push(f);
    }
    return out;
  });
  if (created.length === 1) return res.redirect(`/admin/paper/forms/${created[0].id}/print${req.body.guide ? '?guide=1' : ''}`);
  req.flash('success', `Created ${created.length} forms: ${created.map((f) => f.code).join(', ')}. Open each one to print it.`);
  res.redirect('/admin/paper');
});

// ---------- Printing ----------

router.get('/paper/forms/:id/print', async (req, res) => {
  const form = await paper.loadForm(id(req));
  if (!form) return res.redirect('/admin/paper');
  const rows = [...form.players, ...Array.from({ length: form.blank_rows }, () => null)];
  const pages = [];
  for (let i = 0; i < rows.length || i === 0; i += paper.ROWS_PER_PAGE) pages.push(rows.slice(i, i + paper.ROWS_PER_PAGE).map((p, j) => ({ n: i + j + 1, p })));
  res.render('admin/paper-print', { form, pages, guide: req.query.guide === '1' });
});

// ---------- Form detail & entry ----------

router.get('/paper/forms/:id', async (req, res) => {
  const form = await paper.loadForm(id(req));
  if (!form) return res.redirect('/admin/paper');
  const submissions = await db.many(
    `SELECT s.id, s.created_at, s.scan_name, s.scan_type, (s.scan_data IS NOT NULL) AS has_scan,
            u.name AS rater_name, u.can_login, e.name AS entered_by_name,
            (SELECT count(*) FROM ratings r WHERE r.paper_submission_id = s.id)::int AS ratings
       FROM paper_submissions s JOIN users u ON u.id = s.rater_id LEFT JOIN users e ON e.id = s.entered_by
      WHERE s.form_id = $1 ORDER BY s.created_at DESC`,
    [form.id]
  );
  res.render('admin/paper-form', { title: form.code, form, submissions });
});

async function renderEntry(req, res, form, { values = {}, errors = [], status = 200 } = {}) {
  const roster2 = await roster.searchRoster(form.season_id, { includeInactive: true });
  res.status(status).render('admin/paper-enter', {
    title: `Enter ${form.code}`,
    form,
    raters: await raterChoices(),
    seasonRoster: roster2,
    values,
    errors,
  });
}

router.get('/paper/forms/:id/enter', async (req, res) => {
  const form = await paper.loadForm(id(req));
  if (!form) return res.redirect('/admin/paper');
  await renderEntry(req, res, form);
});

router.post('/paper/forms/:id/enter', (req, res, next) => {
  upload.single('scan')(req, res, (err) => {
    if (err) {
      req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'The scan is larger than 10 MB. Use a smaller photo or PDF.' : 'Could not read the uploaded scan.';
      req.body = req.body || {};
    }
    next();
  });
}, verifyCsrf, async (req, res) => {
  const form = await paper.loadForm(id(req));
  if (!form) return res.redirect('/admin/paper');
  const errors = [];
  if (req.uploadError) errors.push(req.uploadError);

  // Who filled it in
  let raterId = null;
  let newRater = null;
  if (req.body.rater_id === 'new') {
    const name = String(req.body.new_rater_name || '').trim().slice(0, 100);
    const email = String(req.body.new_rater_email || '').trim().toLowerCase().slice(0, 200) || null;
    if (!name) errors.push("Enter the new paper rater's name.");
    if (email && !EMAIL_RE.test(email)) errors.push("The new paper rater's email doesn't look right.");
    if (email) {
      const taken = await db.one('SELECT name FROM users WHERE lower(email) = $1', [email]);
      if (taken) errors.push(`${email} already belongs to ${taken.name}; choose them from the list instead.`);
    }
    newRater = { name, email };
  } else {
    const r = await db.one(`SELECT id FROM users WHERE id = $1 AND status = 'approved' AND role IN ('rater', 'admin')`, [Number(req.body.rater_id) || 0]);
    if (r) raterId = r.id;
    else errors.push('Choose who filled in this sheet.');
  }

  // The scan (optional)
  let scan = null;
  if (req.file && req.file.size) {
    const type = paper.sniffScan(req.file.buffer);
    if (!type) errors.push('The scan must be a PDF or a photo (JPEG, PNG, WebP or HEIC).');
    else scan = { name: String(req.file.originalname || 'scan').slice(0, 200), type, data: req.file.buffer };
  }

  const grid = paper.parseGrid(req.body, form);
  errors.push(...grid.errors);
  // Write-in rows must name someone on this season's roster.
  for (const row of grid.rows) {
    if (!form.players[row.index] && !(await roster.seasonPlayer(form.season_id, row.playerId))) {
      errors.push(`Row ${row.index + 1}: that player isn't on the ${form.season_name} roster.`);
    }
  }
  if (!grid.rows.length && !grid.errors.length) errors.push('Nothing to save: every row on the grid is blank.');
  if (errors.length) {
    if (scan) errors.push('Please attach the scan again; files aren\'t kept when there are errors.');
    return renderEntry(req, res, form, { values: req.body, errors, status: 422 });
  }

  const result = await db.tx(async (c) => {
    if (newRater) {
      const { rows } = await c.query(
        `INSERT INTO users (email, name, password_hash, role, status, can_login, approved_by, approved_at)
         VALUES ($1, $2, '!', 'rater', 'approved', false, $3, now()) RETURNING id`,
        [newRater.email, newRater.name, req.user.id]
      );
      raterId = rows[0].id;
      await audit(req.user.id, 'paper_rater_created', 'user', raterId, { name: newRater.name }, c);
    }
    const sub = (
      await c.query(
        `INSERT INTO paper_submissions (form_id, rater_id, scan_name, scan_type, scan_data, entered_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [form.id, raterId, scan && scan.name, scan && scan.type, scan && scan.data, req.user.id]
      )
    ).rows[0];
    const saved = [];
    const skipped = [];
    for (const row of grid.rows) {
      const exists = (await c.query('SELECT id FROM ratings WHERE season_id = $1 AND player_id = $2 AND rater_id = $3', [form.season_id, row.playerId, raterId])).rows[0];
      if (exists) {
        skipped.push({ row: row.index + 1, playerId: row.playerId, ratingId: exists.id });
        continue;
      }
      const ratingId = await R.createRating(c, form.season_id, row.playerId, raterId, row.data, row.scores);
      await c.query(`UPDATE ratings SET source = 'paper', paper_submission_id = $1 WHERE id = $2`, [sub.id, ratingId]);
      saved.push({ row: row.index + 1, playerId: row.playerId, ratingId });
    }
    await audit(req.user.id, 'paper_ratings_entered', 'paper_form', form.id, {
      code: form.code, submission_id: sub.id, rater_id: raterId, saved: saved.length, skipped: skipped.length, scan: Boolean(scan),
    }, c);
    return { submissionId: sub.id, saved, skipped };
  });

  const names = new Map((await db.many('SELECT id, first_name, last_name FROM players WHERE id = ANY($1::int[])', [[...result.saved, ...result.skipped].map((r) => r.playerId)])).map((p) => [p.id, `${p.first_name} ${p.last_name}`]));
  req.flash('success', `Saved ${result.saved.length} rating${result.saved.length === 1 ? '' : 's'} from ${form.code}.`);
  if (result.skipped.length) {
    req.flash('error', `Skipped ${result.skipped.length} row${result.skipped.length === 1 ? '' : 's'} because this rater already rated ${result.skipped.map((s) => `${names.get(s.playerId)} (row ${s.row})`).join(', ')} this season. Edit those ratings from the player page if they need to change.`);
  }
  res.redirect(`/admin/paper/forms/${form.id}`);
});

// The attached scan, served only to admins.
router.get('/paper/submissions/:id/scan', async (req, res) => {
  const s = await db.one('SELECT scan_name, scan_type, scan_data FROM paper_submissions WHERE id = $1 AND scan_data IS NOT NULL', [id(req)]);
  if (!s) return res.status(404).render('error', { title: 'Not found', message: 'No scan for that entry.' });
  res.set('Content-Type', s.scan_type);
  res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${s.scan_name.replace(/[^\w.\- ]/g, '_')}"`);
  res.set('Cache-Control', 'private, no-store');
  res.send(s.scan_data);
});

router.post('/paper/forms/:id/delete', async (req, res) => {
  const form = await db.one('SELECT f.*, (SELECT count(*) FROM paper_submissions s WHERE s.form_id = f.id)::int AS n FROM paper_forms f WHERE id = $1', [id(req)]);
  if (form && form.n) {
    req.flash('error', `${form.code} has entries and can't be deleted.`);
  } else if (form) {
    await db.query('DELETE FROM paper_forms WHERE id = $1', [form.id]);
    await audit(req.user.id, 'paper_form_deleted', 'paper_form', form.id, { code: form.code });
    req.flash('success', `${form.code} deleted.`);
  }
  res.redirect('/admin/paper');
});

module.exports = router;
