'use strict';

const test = require('node:test');
const assert = require('node:assert');
const totp = require('../src/lib/totp');
const { levelForScore, LEVELS } = require('../src/lib/levels');
const { weightedOverall, summarize } = require('../src/lib/ratings');
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

test('levels map 0–11 to BEG..A1 with rounding', () => {
  assert.strictEqual(LEVELS.length, 12);
  assert.strictEqual(levelForScore(0), 'BEG');
  assert.strictEqual(levelForScore(5.49), 'C2');
  assert.strictEqual(levelForScore(5.5), 'C1');
  assert.strictEqual(levelForScore(11), 'A1');
  assert.strictEqual(levelForScore(null), null);
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
  const s = summarize([mk(6, 'C1'), mk(8, 'B2')], cats);
  assert.strictEqual(s.needsReview, true);
  assert.strictEqual(s.avgOverall, 7);
  assert.strictEqual(s.calculatedLevel, 'B3');
  const s2 = summarize([mk(6, 'C1'), mk(7, 'B3')], cats);
  assert.strictEqual(s2.needsReview, false);
  const s3 = summarize([mk(6, 'C1')], cats, { level_override: 'A2' });
  assert.strictEqual(s3.level, 'A2');
});

test('import normalizes common column names and formats', () => {
  assert.deepStrictEqual(
    { ...normalizePlayer({ 'Player Name': 'Gretzky, Wayne', 'Jersey #': '#99', Pos: 'Center', League: 'A' }) },
    { first_name: 'Wayne', last_name: 'Gretzky', jersey_number: '99', team: null, division: 'A', position: 'F', age: null, email: null, external_id: null, notes: null }
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
