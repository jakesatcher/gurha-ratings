'use strict';

// Team "Score": the sum of the team's players' final ratings (average points), compared with the
// league's allowed points for the season.
const db = require('../db');
const { roundHalfUp } = require('./levels');

// Regular roster players only (subs fill in and don't count against a team). Unrated players add 0.
function teamScore(players, summaries, isSub) {
  const regulars = players.filter((p) => !isSub(p));
  const total = regulars.reduce((sum, p) => sum + (summaries.get(p.id).avgOverall || 0), 0);
  return {
    score: roundHalfUp(total, 2),
    counted: regulars.length,
    unrated: regulars.filter((p) => summaries.get(p.id).avgOverall === null).length,
  };
}

// green: at or under; yellow: up to 5 over; orange: over 5 up to 10; red: more than 10 over.
function capStatus(score, cap) {
  if (cap === null || cap === undefined) return { status: 'none', over: null };
  const over = roundHalfUp(score - Number(cap), 2);
  const status = over <= 0 ? 'green' : over <= 5 ? 'yellow' : over <= 10 ? 'orange' : 'red';
  return { status, over };
}

const capKey = (division) => division || '';

async function leagueCaps(seasonId) {
  const rows = await db.many('SELECT division, max_points FROM league_caps WHERE season_id = $1', [seasonId]);
  return new Map(rows.map((r) => [r.division, Number(r.max_points)]));
}

module.exports = { teamScore, capStatus, capKey, leagueCaps };
