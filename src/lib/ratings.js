'use strict';

const db = require('../db');
const { levelForScore, levelIndex, isLevel, gradeByKey, LEVELS, MAX_POINTS } = require('./levels');

const ALREADY_RATED_MESSAGE =
  'You already rated this player. If you feel this is an error, or would like to change your rating, please contact an Admin';

// Two raters whose levels differ by this many steps or more => flag for a third review.
const REVIEW_FLAG_GAP = 2;

async function getCategories({ includeInactive = false } = {}) {
  return db.many(
    `SELECT * FROM categories ${includeInactive ? '' : 'WHERE active'} ORDER BY sort_order, id`
  );
}

// Weighted overall score (0–15) for a set of {category_id, score} using category weights.
function weightedOverall(scores, categories) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  let total = 0;
  let weightSum = 0;
  for (const s of scores) {
    const cat = byId.get(s.category_id);
    if (!cat || s.score === null || s.score === undefined) continue;
    const w = Number(cat.weight);
    total += Number(s.score) * w;
    weightSum += w;
  }
  if (weightSum === 0) return null;
  return Math.round((total / weightSum) * 100) / 100;
}

function toArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

function cleanText(v, max = 4000) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

// Validates a submitted rating form. Returns { errors, data, scores }.
// Fields: score_{categoryId} = a grade key ("D2:M", "BEG", "A"), comment_{categoryId} (optional),
// final_level = the rater's recommended level, evidence = observation notes.
function parseRatingForm(body, categories) {
  const errors = [];
  const scores = [];
  for (const cat of categories) {
    const grade = gradeByKey(body[`score_${cat.id}`]);
    if (!grade) {
      errors.push(`${cat.name}: choose a level (and Low, Medium or High).`);
      continue;
    }
    scores.push({ category_id: cat.id, grade: grade.key, score: grade.points, comment: cleanText(body[`comment_${cat.id}`], 2000) });
  }

  // Sections dropped from the form are cleared so an admin edit of an older rating leaves nothing stale.
  const data = {
    independent_level: null,
    game_performance: null,
    game_performance_note: null,
    age_limited: null,
    age_areas: [],
    age_comments: null,
    injury: null,
    injury_affects: [],
    injury_temporary: null,
    injury_normal_level: null,
    injury_current_level: null,
    injury_comments: null,
    evidence: cleanText(body.evidence),
    strengths: null,
    improvements: null,
    final_level: isLevel(body.final_level) ? body.final_level : null,
    scale: 2,
  };
  if (!data.final_level) errors.push('Choose your rater recommendation.');

  return { errors, data, scores };
}

const RATING_FIELDS = [
  'independent_level', 'game_performance', 'game_performance_note', 'age_limited', 'age_areas', 'age_comments',
  'injury', 'injury_affects', 'injury_temporary', 'injury_normal_level', 'injury_current_level', 'injury_comments',
  'evidence', 'strengths', 'improvements', 'final_level', 'scale',
];

async function createRating(client, seasonId, playerId, raterId, data, scores) {
  const cols = ['season_id', 'player_id', 'rater_id', 'updated_by', ...RATING_FIELDS];
  const vals = [seasonId, playerId, raterId, raterId, ...RATING_FIELDS.map((f) => (f === 'scale' ? data.scale || 2 : data[f]))];
  const { rows } = await client.query(
    `INSERT INTO ratings (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    vals
  );
  const ratingId = rows[0].id;
  await insertScores(client, ratingId, scores);
  return ratingId;
}

async function updateRating(client, ratingId, actorId, data, scores) {
  const sets = RATING_FIELDS.map((f, i) => `${f} = $${i + 1}`);
  await client.query(
    `UPDATE ratings SET ${sets.join(', ')}, updated_at = now(), updated_by = $${RATING_FIELDS.length + 1}
     WHERE id = $${RATING_FIELDS.length + 2}`,
    [...RATING_FIELDS.map((f) => data[f]), actorId, ratingId]
  );
  await client.query('DELETE FROM rating_scores WHERE rating_id = $1 AND category_id = ANY($2::int[])', [
    ratingId,
    scores.map((s) => s.category_id),
  ]);
  await insertScores(client, ratingId, scores);
}

async function insertScores(client, ratingId, scores) {
  for (const s of scores) {
    await client.query('INSERT INTO rating_scores (rating_id, category_id, score, grade, comment) VALUES ($1, $2, $3, $4, $5)', [
      ratingId,
      s.category_id,
      s.score,
      s.grade,
      s.comment,
    ]);
  }
}

// Loads ratings (with scores) and computes per-rating overall/level.
// Filter by ratingId, or by playerIds and optionally seasonId (omit seasonId for all seasons).
async function loadRatings({ playerIds, ratingId, seasonId } = {}) {
  const categories = await getCategories();
  const where = [];
  const params = [];
  if (ratingId) {
    params.push(ratingId);
    where.push(`r.id = $${params.length}`);
  } else {
    params.push(playerIds);
    where.push(`r.player_id = ANY($${params.length}::int[])`);
    if (seasonId) {
      params.push(seasonId);
      where.push(`r.season_id = $${params.length}`);
    }
  }
  const ratings = await db.many(
    `SELECT r.*, u.name AS rater_name, u.email AS rater_email, ub.name AS updated_by_name, s.name AS season_name,
            pf.code AS paper_form_code, pf.id AS paper_form_id
       FROM ratings r
       JOIN users u ON u.id = r.rater_id
       JOIN seasons s ON s.id = r.season_id
       LEFT JOIN users ub ON ub.id = r.updated_by
       LEFT JOIN paper_submissions ps ON ps.id = r.paper_submission_id
       LEFT JOIN paper_forms pf ON pf.id = ps.form_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.created_at`,
    params
  );
  if (!ratings.length) return { ratings, categories };
  const scoreRows = await db.many('SELECT * FROM rating_scores WHERE rating_id = ANY($1::int[])', [ratings.map((r) => r.id)]);
  const byRating = new Map();
  for (const s of scoreRows) {
    s.score = s.score === null ? null : Number(s.score); // numeric comes back as a string
    s.gradeInfo = gradeByKey(s.grade);
    if (!byRating.has(s.rating_id)) byRating.set(s.rating_id, []);
    byRating.get(s.rating_id).push(s);
  }
  for (const r of ratings) {
    r.scores = byRating.get(r.id) || [];
    r.scoreMap = Object.fromEntries(r.scores.map((s) => [s.category_id, s]));
    // Ratings from the old 0–11 scale are shown for reference but kept out of every average.
    r.legacy = r.scale === 1;
    r.overall = weightedOverall(r.scores, categories);
    r.calculated_level = r.legacy ? null : levelForScore(r.overall);
    r.effective_level = r.final_level || r.calculated_level;
  }
  return { ratings, categories };
}

// Aggregates a player's ratings into averages, level and review flag.
function summarize(allRatings, categories, player = {}) {
  const ratings = allRatings.filter((r) => !r.legacy);
  const legacyCount = allRatings.length - ratings.length;
  const count = ratings.length;
  const categoryAverages = {};
  for (const cat of categories) {
    const vals = ratings.map((r) => r.scoreMap[cat.id]).filter(Boolean).map((s) => s.score);
    categoryAverages[cat.id] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null;
  }
  const overalls = ratings.map((r) => r.overall).filter((v) => v !== null);
  const avgOverall = overalls.length ? Math.round((overalls.reduce((a, b) => a + b, 0) / overalls.length) * 100) / 100 : null;

  const finalIdx = ratings.map((r) => levelIndex(r.effective_level)).filter((v) => v !== null);
  const avgFinalIdx = finalIdx.length ? finalIdx.reduce((a, b) => a + b, 0) / finalIdx.length : null;
  const levelSpread = finalIdx.length > 1 ? Math.max(...finalIdx) - Math.min(...finalIdx) : 0;

  const calculatedLevel = levelForScore(avgOverall);
  const recommendedLevel = avgFinalIdx === null ? null : LEVELS[Math.round(avgFinalIdx)];
  return {
    count,
    legacyCount,
    categoryAverages,
    avgOverall,
    calculatedLevel,
    recommendedLevel,
    level: player.level_override || calculatedLevel,
    overridden: Boolean(player.level_override),
    levelSpread,
    needsReview: levelSpread >= REVIEW_FLAG_GAP,
  };
}

// players: roster rows for one season (level_override comes from the season entry).
async function summariesForPlayers(players, seasonId) {
  if (!players.length) return new Map();
  const { ratings, categories } = await loadRatings({ playerIds: players.map((p) => p.id), seasonId });
  const grouped = new Map(players.map((p) => [p.id, []]));
  for (const r of ratings) grouped.get(r.player_id).push(r);
  const out = new Map();
  for (const p of players) out.set(p.id, summarize(grouped.get(p.id), categories, p));
  return out;
}

// One summary per season the player was rostered or rated in, newest first.
async function playerHistory(playerId) {
  const entries = await db.many(
    `SELECT s.id AS season_id, s.name AS season_name, s.start_date, sp.level_override,
            (SELECT string_agg(coalesce(t.name, 'No team') || CASE WHEN tr.is_sub THEN ' (sub)' ELSE '' END, ', ' ORDER BY tr.is_sub, t.name)
               FROM team_rosters tr LEFT JOIN teams t ON t.id = tr.team_id WHERE tr.season_player_id = sp.id) AS teams,
            (SELECT tr.jersey_number FROM team_rosters tr WHERE tr.season_player_id = sp.id AND tr.jersey_number IS NOT NULL
              ORDER BY tr.is_sub, tr.id LIMIT 1) AS jersey_number
       FROM seasons s
       LEFT JOIN season_players sp ON sp.season_id = s.id AND sp.player_id = $1
      WHERE sp.id IS NOT NULL OR EXISTS (SELECT 1 FROM ratings r WHERE r.season_id = s.id AND r.player_id = $1)
      ORDER BY coalesce(s.start_date, s.created_at::date) DESC, s.id DESC`,
    [playerId]
  );
  const { ratings, categories } = await loadRatings({ playerIds: [playerId] });
  return {
    categories,
    seasons: entries.map((e) => ({
      ...e,
      summary: summarize(ratings.filter((r) => r.season_id === e.season_id), categories, e),
    })),
  };
}

module.exports = {
  playerHistory,
  ALREADY_RATED_MESSAGE,
  MAX_POINTS,
  REVIEW_FLAG_GAP,
  getCategories,
  weightedOverall,
  parseRatingForm,
  createRating,
  updateRating,
  loadRatings,
  summarize,
  summariesForPlayers,
};
