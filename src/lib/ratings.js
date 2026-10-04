'use strict';

const db = require('../db');
const { levelForScore, levelIndex, isLevel, LEVELS } = require('./levels');

const ALREADY_RATED_MESSAGE =
  'You already rated this player. If you feel this is an error, or would like to change your rating, please contact an Admin';

const GAME_PERFORMANCE = ['consistently', 'usually', 'sometimes', 'rarely'];
const AGE_AREAS = ['Speed', 'Acceleration', 'Endurance', 'Recovery', 'Agility', 'Other'];
const INJURY_AFFECTS = ['Skating', 'Speed', 'Agility', 'Shooting', 'Puck Handling', 'Endurance', 'Physical Play', 'Other'];
const INJURY_TEMPORARY = ['yes', 'no', 'unknown'];
// Two raters whose levels differ by this many steps or more => flag for a third review.
const REVIEW_FLAG_GAP = 2;

async function getCategories({ includeInactive = false } = {}) {
  return db.many(
    `SELECT * FROM categories ${includeInactive ? '' : 'WHERE active'} ORDER BY sort_order, id`
  );
}

// Weighted overall score (0–11) for a set of {category_id, score} using category weights.
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
function parseRatingForm(body, categories) {
  const errors = [];
  const scores = [];
  for (const cat of categories) {
    const raw = body[`score_${cat.id}`];
    const n = Number(raw);
    if (raw === undefined || raw === '' || !Number.isInteger(n) || n < cat.min_score || n > cat.max_score) {
      errors.push(`${cat.name}: choose a score from ${cat.min_score} to ${cat.max_score}.`);
      continue;
    }
    scores.push({ category_id: cat.id, score: n, comment: cleanText(body[`comment_${cat.id}`], 2000) });
  }

  const pick = (v, allowed) => (allowed.includes(v) ? v : null);
  const level = (v) => (isLevel(v) ? v : null);

  const data = {
    independent_level: level(body.independent_level),
    game_performance: pick(body.game_performance, GAME_PERFORMANCE),
    game_performance_note: cleanText(body.game_performance_note),
    age_limited: body.age_limited === 'yes' ? true : body.age_limited === 'no' ? false : null,
    age_areas: toArray(body.age_areas).filter((a) => AGE_AREAS.includes(a)),
    age_comments: cleanText(body.age_comments),
    injury: cleanText(body.injury),
    injury_affects: toArray(body.injury_affects).filter((a) => INJURY_AFFECTS.includes(a)),
    injury_temporary: pick(body.injury_temporary, INJURY_TEMPORARY),
    injury_normal_level: level(body.injury_normal_level),
    injury_current_level: level(body.injury_current_level),
    injury_comments: cleanText(body.injury_comments),
    evidence: cleanText(body.evidence),
    strengths: cleanText(body.strengths),
    improvements: cleanText(body.improvements),
    final_level: level(body.final_level),
  };

  if (!data.independent_level) errors.push('Choose your independent level assessment.');
  if (!data.game_performance) errors.push('Complete the game performance check.');
  if (['sometimes', 'rarely'].includes(data.game_performance) && !data.game_performance_note) {
    errors.push('Explain the game performance check when choosing "Sometimes" or "Rarely".');
  }
  if (!data.final_level) errors.push('Choose a final recommended level.');

  return { errors, data, scores };
}

const RATING_FIELDS = [
  'independent_level', 'game_performance', 'game_performance_note', 'age_limited', 'age_areas', 'age_comments',
  'injury', 'injury_affects', 'injury_temporary', 'injury_normal_level', 'injury_current_level', 'injury_comments',
  'evidence', 'strengths', 'improvements', 'final_level',
];

async function createRating(client, playerId, raterId, data, scores) {
  const cols = ['player_id', 'rater_id', 'updated_by', ...RATING_FIELDS];
  const vals = [playerId, raterId, raterId, ...RATING_FIELDS.map((f) => data[f])];
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
    await client.query('INSERT INTO rating_scores (rating_id, category_id, score, comment) VALUES ($1, $2, $3, $4)', [
      ratingId,
      s.category_id,
      s.score,
      s.comment,
    ]);
  }
}

// Loads ratings for players (with scores) and computes per-rating overall/level.
async function loadRatings({ playerIds, ratingId } = {}) {
  const categories = await getCategories();
  const where = ratingId ? 'r.id = $1' : 'r.player_id = ANY($1::int[])';
  const param = ratingId ? ratingId : playerIds;
  const ratings = await db.many(
    `SELECT r.*, u.name AS rater_name, u.email AS rater_email, ub.name AS updated_by_name
       FROM ratings r
       JOIN users u ON u.id = r.rater_id
       LEFT JOIN users ub ON ub.id = r.updated_by
      WHERE ${where}
      ORDER BY r.created_at`,
    [param]
  );
  if (!ratings.length) return { ratings, categories };
  const scoreRows = await db.many('SELECT * FROM rating_scores WHERE rating_id = ANY($1::int[])', [ratings.map((r) => r.id)]);
  const byRating = new Map();
  for (const s of scoreRows) {
    if (!byRating.has(s.rating_id)) byRating.set(s.rating_id, []);
    byRating.get(s.rating_id).push(s);
  }
  for (const r of ratings) {
    r.scores = byRating.get(r.id) || [];
    r.scoreMap = Object.fromEntries(r.scores.map((s) => [s.category_id, s]));
    r.overall = weightedOverall(r.scores, categories);
    r.calculated_level = levelForScore(r.overall);
    r.effective_level = r.final_level || r.calculated_level;
  }
  return { ratings, categories };
}

// Aggregates a player's ratings into averages, level and review flag.
function summarize(ratings, categories, player = {}) {
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

async function summariesForPlayers(players) {
  if (!players.length) return new Map();
  const { ratings, categories } = await loadRatings({ playerIds: players.map((p) => p.id) });
  const grouped = new Map(players.map((p) => [p.id, []]));
  for (const r of ratings) grouped.get(r.player_id).push(r);
  const out = new Map();
  for (const p of players) out.set(p.id, summarize(grouped.get(p.id), categories, p));
  return out;
}

module.exports = {
  ALREADY_RATED_MESSAGE,
  GAME_PERFORMANCE,
  AGE_AREAS,
  INJURY_AFFECTS,
  INJURY_TEMPORARY,
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
