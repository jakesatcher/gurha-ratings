'use strict';

// GURHA rating scale: score (0–11) -> level
const LEVELS = ['BEG', 'D3', 'D2', 'D1', 'C3', 'C2', 'C1', 'B3', 'B2', 'B1', 'A2', 'A1'];
const LEVEL_NAMES = { BEG: 'BEG – Beginner' };

function levelForScore(score) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return null;
  const idx = Math.min(LEVELS.length - 1, Math.max(0, Math.round(Number(score))));
  return LEVELS[idx];
}

function levelIndex(level) {
  const idx = LEVELS.indexOf(level);
  return idx === -1 ? null : idx;
}

function isLevel(v) {
  return LEVELS.includes(v);
}

function levelLabel(level) {
  return LEVEL_NAMES[level] || level;
}

// Letter tier used for colour coding (A/B/C/D/BEG)
function levelTier(level) {
  if (!level) return 'none';
  return level === 'BEG' ? 'beg' : level[0].toLowerCase();
}

module.exports = { LEVELS, levelForScore, levelIndex, isLevel, levelLabel, levelTier };
