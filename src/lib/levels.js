'use strict';

// GURHA rating scale. Each category is rated by level, and most levels have a Low / Medium / High
// step; Beginner and A are single values. Each choice ("grade") is worth a fixed number of points,
// and the weighted average of those points (0–15) maps back to a level.
const MAX_POINTS = 15;
const STEP_NAMES = { L: 'Low', M: 'Medium', H: 'High' };
const STEP_SHORT = { L: 'Low', M: 'Med', H: 'High' };

const BANDS = [
  { level: 'BEG', name: 'Beginner', tier: 'beg', points: { '': 0 } },
  { level: 'D3', tier: 'd3', points: { L: 1, M: 1.5, H: 2 } },
  { level: 'D2', tier: 'd2', points: { L: 3, M: 4, H: 5 } },
  { level: 'D1/C2', tier: 'dc', points: { L: 6, M: 7, H: 8 } },
  { level: 'C1/B2', tier: 'cb', points: { L: 9, M: 10, H: 11 } },
  { level: 'B1/A2', tier: 'ba', points: { L: 12, M: 13, H: 14 } },
  { level: 'A', tier: 'a', points: { '': 15 } },
];
const LEVELS = BANDS.map((b) => b.level);

// Every selectable grade: key "D2:M" (or just "BEG" / "A"), its level, step and points.
const GRADES = BANDS.flatMap((b) =>
  Object.entries(b.points).map(([step, points]) => ({
    key: step ? `${b.level}:${step}` : b.level,
    level: b.level,
    step: step || null,
    points,
    label: step ? `${b.level} ${STEP_NAMES[step]}` : b.name || b.level,
  }))
);
const GRADE_BY_KEY = new Map(GRADES.map((g) => [g.key, g]));

// A score below `upper` belongs to the band: halfway between this band's top and the next band's bottom.
const BOUNDS = BANDS.map((b, i) => {
  const next = BANDS[i + 1];
  const top = Math.max(...Object.values(b.points));
  return { level: b.level, tier: b.tier, upper: next ? (top + Math.min(...Object.values(next.points))) / 2 : Infinity };
});

function gradeByKey(key) {
  return GRADE_BY_KEY.get(key) || null;
}

// The grade worth exactly these points (paper forms record points), or null.
function gradeForPoints(points) {
  const n = Number(points);
  return GRADES.find((g) => g.points === n) || null;
}

function levelForScore(score) {
  if (score === null || score === undefined || score === '' || Number.isNaN(Number(score))) return null;
  return BOUNDS.find((b) => Number(score) < b.upper).level;
}

function levelIndex(level) {
  const idx = LEVELS.indexOf(level);
  return idx === -1 ? null : idx;
}

function isLevel(v) {
  return LEVELS.includes(v);
}

// Accepts typed levels loosely (paper entry): "d1/c2", "C2", "D1", "b", "beginner" → canonical level.
function normalizeLevel(input) {
  const s = String(input || '').trim().toUpperCase().replace(/\s+/g, '').replace(/[-–]/g, '/');
  if (!s) return null;
  if (s === 'BEGINNER') return 'BEG';
  if (s === 'B') return 'B1/A2';
  const exact = LEVELS.find((l) => l === s);
  if (exact) return exact;
  const part = LEVELS.find((l) => l.split('/').includes(s));
  return part || null;
}

function levelLabel(level) {
  const band = BANDS.find((b) => b.level === level);
  return (band && band.name) || level;
}

// Colour tier: beg, d3, d2, dc, cb, ba, a. Older level names (C3, B2…) fall back to their letter.
function levelTier(level) {
  if (!level) return 'none';
  const band = BANDS.find((b) => b.level === level);
  if (band) return band.tier;
  return level === 'BEG' ? 'beg' : /^[abcd]/i.test(level) ? level[0].toLowerCase() : 'none';
}

module.exports = {
  MAX_POINTS, STEP_NAMES, STEP_SHORT, BANDS, LEVELS, GRADES, BOUNDS,
  gradeByKey, gradeForPoints, levelForScore, levelIndex, isLevel, normalizeLevel, levelLabel, levelTier,
};
