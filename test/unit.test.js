'use strict';

const test = require('node:test');
const assert = require('node:assert');
const totp = require('../src/lib/totp');
const { levelForScore, roundHalfUp, gradeForPoints, normalizeLevel, LEVELS, GRADES } = require('../src/lib/levels');
const { weightedOverall, summarize, parseRatingForm } = require('../src/lib/ratings');
const { normalizePlayer, parseUpload } = require('../src/lib/players');
const { extractPlayers } = require('../src/lib/sportsengine');

test('TOTP matches RFC 6238 test vector and verifies with drift', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.strictEqual(totp.generate(secret, 59000), '287082');
  assert.strictEqual(totp.generate(secret, 1111111109000), '081804');
  const now = Date.now();
  assert.ok(totp.verify(secret, totp.generate(secret, now - 30000), now));
  assert.ok(!totp.verify(secret, totp.generate(secret, now - 120000), now));
  assert.ok(!totp.verify(secret, 'abcdef', now));
});

test('levels: Low/Mid/High grades carry the agreed points and scores map back to levels', () => {
  assert.deepStrictEqual(LEVELS, ['BEG', 'D3', 'D2', 'D1/C2', 'C1/B2', 'B1/A2', 'A']);
  assert.deepStrictEqual(GRADES.map((g) => [g.key, g.points]), [
    ['BEG', 0], ['D3:L', 1], ['D3:M', 1.5], ['D3:H', 2], ['D2:L', 3], ['D2:M', 4], ['D2:H', 5],
    ['D1/C2:L', 6], ['D1/C2:M', 7], ['D1/C2:H', 8], ['C1/B2:L', 9], ['C1/B2:M', 10], ['C1/B2:H', 11],
    ['B1/A2:L', 12], ['B1/A2:M', 13], ['B1/A2:H', 14], ['A', 15],
  ]);
  assert.strictEqual(levelForScore(0), 'BEG');
  assert.strictEqual(levelForScore(0.49), 'BEG');
  assert.strictEqual(levelForScore(2.49), 'D3');
  assert.strictEqual(levelForScore(2.5), 'D2');
  assert.strictEqual(levelForScore(6.8), 'D1/C2');
  assert.strictEqual(levelForScore(14.5), 'A');
  // Standard rounding at every boundary: x.4 stays, x.5 rounds up
  for (const [lo, hi, below, above] of [[0.4, 0.5, 'BEG', 'D3'], [2.4, 2.5, 'D3', 'D2'], [5.4, 5.5, 'D2', 'D1/C2'], [8.4, 8.5, 'D1/C2', 'C1/B2'], [11.4, 11.5, 'C1/B2', 'B1/A2'], [14.4, 14.5, 'B1/A2', 'A']]) {
    assert.strictEqual(levelForScore(lo), below, `${lo}`);
    assert.strictEqual(levelForScore(hi), above, `${hi}`);
  }
  // Floating-point error doesn't push an exact half down
  assert.strictEqual(roundHalfUp(2.4999999999999996), 3);
  assert.strictEqual(roundHalfUp(1.005, 2), 1.01);
  assert.strictEqual(levelForScore(0.1 * 3 + 2.2), 'D2'); // 2.5000000000000004
  assert.strictEqual(levelForScore((1 * 25 + 4 * 25 + 2 * 25 + 3 * 25) / 100), 'D2'); // exactly 2.5
  assert.strictEqual(levelForScore(null), null);
  assert.strictEqual(gradeForPoints('1.5').key, 'D3:M');
  assert.strictEqual(gradeForPoints('2.5'), null);
  assert.deepStrictEqual(['c2', 'D1', 'b', 'beginner', 'x'].map(normalizeLevel), ['D1/C2', 'D1/C2', 'B1/A2', 'BEG', null]);
});

test('rating form takes a grade per category and one comments box', () => {
  const cats = [{ id: 1, name: 'Skating', weight: 50 }, { id: 2, name: 'Passing', weight: 50 }];
  const ok = parseRatingForm({ score_1: 'D3:M', score_2: 'A', evidence: 'Quick' }, cats);
  assert.deepStrictEqual(ok.errors, []);
  assert.deepStrictEqual(ok.scores.map((s) => [s.grade, s.score]), [['D3:M', 1.5], ['A', 15]]);
  assert.strictEqual(weightedOverall(ok.scores, cats), 8.25);
  assert.deepStrictEqual([ok.data.final_level, ok.data.evidence, ok.data.game_performance], [null, 'Quick', null]);
  const bad = parseRatingForm({ score_1: 'BEG:L' }, cats);
  assert.strictEqual(bad.errors.length, 2);
});

test('weighted overall follows the GURHA formula', () => {
  const cats = [
    { id: 1, weight: 25 }, { id: 2, weight: 20 }, { id: 3, weight: 15 },
    { id: 4, weight: 10 }, { id: 5, weight: 20 }, { id: 6, weight: 10 },
  ];
  const scores = [[1, 8], [2, 7], [3, 6], [4, 5], [5, 7], [6, 6]].map(([category_id, score]) => ({ category_id, score }));
  // 8*.25 + 7*.2 + 6*.15 + 5*.1 + 7*.2 + 6*.1 = 2 + 1.4 + .9 + .5 + 1.4 + .6 = 6.8
  assert.strictEqual(weightedOverall(scores, cats), 6.8);
});

test('summary flags third review when levels differ by 2+', () => {
  const cats = [{ id: 1, weight: 100, min_score: 0, max_score: 11 }];
  const mk = (score, final_level) => ({ scoreMap: { 1: { score } }, overall: score, effective_level: final_level });
  const s = summarize([mk(6, 'D2'), mk(8, 'C1/B2')], cats);
  assert.strictEqual(s.needsReview, true);
  assert.strictEqual(s.avgOverall, 7);
  assert.strictEqual(s.calculatedLevel, 'D1/C2');
  const s2 = summarize([mk(6, 'D2'), mk(7, 'D1/C2')], cats);
  assert.strictEqual(s2.needsReview, false);
  const s3 = summarize([mk(6, 'D2')], cats, { level_override: 'A' });
  assert.strictEqual(s3.level, 'A');
  // Old 0–11 ratings are shown but not counted
  const s4 = summarize([mk(6, 'D2'), { ...mk(11, 'A1'), legacy: true }], cats);
  assert.deepStrictEqual([s4.count, s4.legacyCount, s4.avgOverall], [1, 1, 6]);
});

test('import normalizes common column names and formats', () => {
  assert.deepStrictEqual(
    { ...normalizePlayer({ 'Player Name': 'Gretzky, Wayne', 'Jersey #': '#99', Pos: 'Center', League: 'A' }) },
    { first_name: 'Wayne', last_name: 'Gretzky', jersey_number: '99', team: null, division: 'A', position: 'F', age: null, email: null, external_id: null, team_external_id: null, birth_date: null, is_sub: false, extra_ids: [], notes: null }
  );
  assert.ok(normalizePlayer({ team: 'x' }).error);
  const rows = parseUpload(Buffer.from('﻿First Name,Last Name,Team\nA,B,C\n'), 'x.csv');
  assert.strictEqual(normalizePlayer(rows[0]).team, 'C');
  const json = parseUpload(Buffer.from('{"players":[{"name":"Bobby Orr","position":"D"}]}'), 'x.json');
  assert.strictEqual(normalizePlayer(json[0]).position, 'D');
});

test('SportsEngine extractor finds players and carries team context', () => {
  const data = {
    teams: { results: [{ id: 't1', name: 'Blue Liners', division: { name: 'C2' }, roster: { results: [
      { id: 'p1', firstName: 'Sam', lastName: 'Skater', jerseyNumber: '12', position: 'Defense' },
    ] } }] },
  };
  const [p] = extractPlayers(data);
  assert.strictEqual(p.team, 'Blue Liners');
  assert.strictEqual(p.division, 'C2');
  assert.strictEqual(p.external_id, 'se:p1');
  assert.strictEqual(normalizePlayer(p).position, 'D');
});

test('team score colour: green at/under the limit, yellow ≤5 over, orange ≤10 over, red beyond', () => {
  const { capStatus, teamScore } = require('../src/lib/teamscore');
  const st = (score, cap) => capStatus(score, cap).status;
  assert.strictEqual(st(50, 50), 'green');
  assert.strictEqual(st(42.5, 50), 'green');
  assert.strictEqual(st(50.01, 50), 'yellow');
  assert.strictEqual(st(55, 50), 'yellow');
  assert.strictEqual(st(55.5, 50), 'orange');
  assert.strictEqual(st(60, 50), 'orange');
  assert.strictEqual(st(60.5, 50), 'red');
  assert.strictEqual(st(80, 50), 'red');
  assert.strictEqual(st(80, null), 'none');
  assert.strictEqual(capStatus(0.1 + 0.2 + 49.7, 50).status, 'green', 'floating-point noise does not tip it over');
  const summaries = new Map([[1, { avgOverall: 7 }], [2, { avgOverall: 4.5 }], [3, { avgOverall: null }], [4, { avgOverall: 15 }]]);
  const players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4, sub: true }];
  assert.deepStrictEqual(teamScore(players, summaries, (p) => p.sub), { score: 11.5, counted: 3, unrated: 1 });
  const { capFor } = require('../src/lib/teamscore');
  assert.strictEqual(capFor(40), 54.4);
  assert.strictEqual(capFor(33), 44.88);
});
