'use strict';

// Admin: possible duplicate people, merging, and "not the same person" dismissals.
const express = require('express');
const db = require('../db');
const { audit } = require('../lib/audit');
const { mergePlayers, duplicateCandidates, mergeExactMatches } = require('../lib/identity');

const router = express.Router();

// Everything an admin needs to decide whether two records are the same person.
async function playerCards(ids) {
  if (!ids.length) return new Map();
  const players = await db.many('SELECT * FROM players WHERE id = ANY($1::int[])', [ids]);
  const extIds = await db.many('SELECT player_id, external_id FROM player_external_ids WHERE player_id = ANY($1::int[]) ORDER BY id', [ids]);
  const seasons = await db.many(
    `SELECT sp.player_id, s.name AS season_name,
            string_agg(coalesce(t.name, 'No team') || coalesce(' #' || tr.jersey_number, '') || CASE WHEN tr.is_sub THEN ' (sub)' ELSE '' END,
                       ', ' ORDER BY tr.is_sub, t.name) AS teams
       FROM season_players sp
       JOIN seasons s ON s.id = sp.season_id
       LEFT JOIN team_rosters tr ON tr.season_player_id = sp.id
       LEFT JOIN teams t ON t.id = tr.team_id
      WHERE sp.player_id = ANY($1::int[])
      GROUP BY sp.player_id, s.id, s.name, s.start_date, s.created_at
      ORDER BY coalesce(s.start_date, s.created_at::date) DESC`,
    [ids]
  );
  const ratings = await db.many('SELECT player_id, count(*)::int AS n FROM ratings WHERE player_id = ANY($1::int[]) GROUP BY player_id', [ids]);
  const map = new Map();
  for (const p of players) {
    map.set(p.id, {
      ...p,
      external_ids: extIds.filter((x) => x.player_id === p.id).map((x) => x.external_id),
      seasons: seasons.filter((x) => x.player_id === p.id),
      rating_count: (ratings.find((x) => x.player_id === p.id) || { n: 0 }).n,
    });
  }
  return map;
}

router.get('/duplicates', async (req, res) => {
  const pairs = await duplicateCandidates();
  const cards = await playerCards([...new Set(pairs.flatMap((p) => [p.a_id, p.b_id]))]);
  res.render('admin/duplicates', { title: 'Possible duplicates', pairs, cards });
});

router.post('/duplicates/distinct', async (req, res) => {
  const [a, b] = [Number(req.body.a), Number(req.body.b)].sort((x, y) => x - y);
  if (a && b && a !== b) {
    await db.query('INSERT INTO player_distinct_pairs (player_a, player_b, created_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [a, b, req.user.id]);
    await audit(req.user.id, 'players_marked_distinct', 'player', a, { other: b });
    req.flash('success', 'Marked as different people.');
  }
  res.redirect('/admin/duplicates');
});

// One click for the unambiguous cases: same name and same date of birth.
router.post('/duplicates/merge-exact', async (req, res) => {
  const results = await db.tx(async (c) => {
    const r = await mergeExactMatches(c);
    for (const m of r) await audit(req.user.id, 'players_merged', 'player', m.keepId, { merged: { id: m.dropId }, bulk: true, ...m }, c);
    return r;
  });
  const dropped = results.reduce((a, r) => a + r.ratingsDropped.length, 0);
  req.flash(
    'success',
    results.length
      ? `Merged ${results.length} duplicate record${results.length === 1 ? '' : 's'} with the same name and date of birth.` +
          (dropped ? ` ${dropped} duplicate rating${dropped === 1 ? ' was' : 's were'} removed (earlier rating kept).` : '')
      : 'No exact matches to merge.'
  );
  res.redirect('/admin/duplicates');
});

// Merge `drop_id` into `keep_id`.
router.post('/players/merge', async (req, res) => {
  const keepId = Number(req.body.keep_id) || 0;
  const dropId = Number(req.body.drop_id) || 0;
  const back = req.body.return_to === 'player' ? `/players/${keepId}` : '/admin/duplicates';
  try {
    const cards = await playerCards([keepId, dropId]);
    const keep = cards.get(keepId);
    const drop = cards.get(dropId);
    if (!keep || !drop) throw new Error('Player not found.');
    const summary = await db.tx(async (c) => {
      const s = await mergePlayers(c, keepId, dropId);
      await audit(req.user.id, 'players_merged', 'player', keepId, {
        merged: { id: dropId, name: `${drop.first_name} ${drop.last_name}`, birth_date: drop.birth_date, external_ids: drop.external_ids },
        ...s,
      }, c);
      return s;
    });
    let msg = `Merged ${drop.first_name} ${drop.last_name} into ${keep.first_name} ${keep.last_name}.`;
    if (summary.ratingsDropped.length) {
      msg += ` ${summary.ratingsDropped.length} duplicate rating${summary.ratingsDropped.length === 1 ? ' was' : 's were'} removed (the same rater had rated both records in the same season; the earlier rating was kept).`;
    }
    req.flash('success', msg);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect(back);
});

module.exports = router;
module.exports.playerCards = playerCards;
