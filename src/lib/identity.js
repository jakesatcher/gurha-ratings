'use strict';

// Recognising the same person across registrations.
//
// SportsEngine issues a new "SportNgin ID" per registration, so one person can arrive with
// several IDs (e.g. "Hassan" #50 on one team and "Hassan (Sub)" #23 on another). We match on:
//   1. a registration/external ID we've already linked to someone
//   2. normalized first + last name and date of birth
//   3. normalized name alone when a date of birth is missing on one side and the match is unique
// Different dates of birth always mean different people. Anything ambiguous becomes a new player
// and shows up in Admin → Duplicates for a human to merge or dismiss.
const db = require('../db');

// "Hassan (Sub)" → { name: "Hassan", isSub: true }. Also handles "[sub]", "- Sub", "*sub*",
// and position hints like "(Substitute goalie)".
function positionHint(text) {
  if (/\b(goalie|goaltender|goalkeeper|netminder)\b/i.test(text)) return 'G';
  if (/\b(defen[cs]e|defenseman|dman)\b/i.test(text)) return 'D';
  if (/\b(forward|wing|center|centre)\b/i.test(text)) return 'F';
  return null;
}

function cleanNamePart(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  let isSub = false;
  let position = null;
  s = s.replace(/\s*[([{]([^)\]}]*)[)\]}]\s*/g, (m, inner) => {
    if (/\bsub(stitute)?s?\b/i.test(inner)) isSub = true;
    position = position || positionHint(inner);
    return ' ';
  });
  s = s.replace(/\s*[-–—*]+\s*sub(stitute)?\s*\**$/i, () => {
    isSub = true;
    return '';
  });
  return { name: s.replace(/\s+/g, ' ').trim(), isSub, position };
}

function keyPart(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’.`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function splitNames(first, last) {
  let f = cleanNamePart(first).name;
  let l = cleanNamePart(last).name;
  if (!l && /\s/.test(f)) {
    const parts = f.split(' ');
    l = parts.pop();
    f = parts.join(' ');
  }
  return [f, l];
}

function nameKey(first, last) {
  const [f, l] = splitNames(first, last).map(keyPart);
  return f && l ? `${f}|${l}` : null;
}

// Cleans an imported name: strips sub markers and returns the flag (and any position hint).
// If the last name was only a note — e.g. first "John Paul Smith", last "(Substitute goalie)" —
// the last word of the first name becomes the last name.
function normalizeName(first, last) {
  const f = cleanNamePart(first);
  const l = cleanNamePart(last);
  const [firstName, lastName] = splitNames(first, last);
  return {
    first_name: firstName,
    last_name: lastName,
    isSub: f.isSub || l.isSub,
    position: f.position || l.position,
    key: nameKey(firstName, lastName),
  };
}

const q = async (client, sql, params) => (await client.query(sql, params)).rows;

// Finds the existing person for an incoming record. Returns { player, how, ambiguous }.
// `p` has first_name, last_name, and optionally external_id, birth_date, email, team (name), seasonId.
async function matchPlayer(client, p) {
  if (p.external_id) {
    const [row] = await q(client, 'SELECT pl.* FROM player_external_ids x JOIN players pl ON pl.id = x.player_id WHERE x.external_id = $1', [p.external_id]);
    if (row) return { player: row, how: 'registration ID', ambiguous: [] };
  }
  const key = nameKey(p.first_name, p.last_name);
  if (key) {
    const candidates = await q(client, 'SELECT * FROM players WHERE name_key = $1 ORDER BY id', [key]);
    if (candidates.length) {
      if (p.birth_date) {
        const same = candidates.filter((c) => c.birth_date === p.birth_date);
        if (same.length) return { player: same[0], how: 'name + date of birth', ambiguous: same.slice(1).map((c) => c.id) };
        const undated = candidates.filter((c) => !c.birth_date);
        if (undated.length === 1) return { player: undated[0], how: 'name (no date of birth on file)', ambiguous: [] };
        if (undated.length > 1) return { player: null, how: null, ambiguous: undated.map((c) => c.id) };
        // Everyone with this name has a different date of birth: a different person.
      } else if (candidates.length === 1) {
        return { player: candidates[0], how: 'name (no date of birth in file)', ambiguous: [] };
      } else {
        // Several people share this name; prefer the one already on this team this season.
        if (p.team && p.seasonId) {
          const onTeam = await q(
            client,
            `SELECT DISTINCT sp.player_id FROM season_players sp JOIN team_rosters tr ON tr.season_player_id = sp.id
               JOIN teams t ON t.id = tr.team_id
              WHERE sp.season_id = $1 AND lower(t.name) = lower($2) AND sp.player_id = ANY($3::int[])`,
            [p.seasonId, p.team, candidates.map((c) => c.id)]
          );
          if (onTeam.length === 1) return { player: candidates.find((c) => c.id === onTeam[0].player_id), how: 'name + team', ambiguous: [] };
        }
        return { player: null, how: null, ambiguous: candidates.map((c) => c.id) };
      }
    }
  }
  if (p.email) {
    const rows = await q(client, 'SELECT * FROM players WHERE lower(email) = lower($1)', [p.email]);
    const ok = rows.filter((r) => !r.birth_date || !p.birth_date || r.birth_date === p.birth_date);
    if (ok.length === 1) return { player: ok[0], how: 'email', ambiguous: [] };
  }
  return { player: null, how: null, ambiguous: [] };
}

async function linkExternalId(client, playerId, externalId, source) {
  if (!externalId) return;
  await client.query(
    `INSERT INTO player_external_ids (player_id, external_id, source) VALUES ($1, $2, $3) ON CONFLICT (external_id) DO NOTHING`,
    [playerId, externalId, source || null]
  );
}

// Fills name_key for players that don't have one yet (new rows from SQL migrations).
async function backfillNameKeys(client = db) {
  const rows = await q(client, 'SELECT id, first_name, last_name FROM players WHERE name_key IS NULL');
  for (const r of rows) await client.query('UPDATE players SET name_key = $1 WHERE id = $2', [nameKey(r.first_name, r.last_name), r.id]);
  return rows.length;
}

// Merges `dropId` into `keepId`: registrations, season rosters, ratings and overrides move over.
// If both were rated by the same rater in the same season, the earlier rating is kept.
async function mergePlayers(client, keepId, dropId) {
  if (keepId === dropId) throw new Error('Choose two different players.');
  const [keep] = await q(client, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [keepId]);
  const [drop] = await q(client, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [dropId]);
  if (!keep || !drop) throw new Error('Player not found.');
  const summary = { seasonsMerged: 0, rostersMoved: 0, ratingsMoved: 0, ratingsDropped: [] };

  await client.query('UPDATE player_external_ids SET player_id = $1 WHERE player_id = $2', [keepId, dropId]);

  // Season entries and their team rosters.
  const dropSeasons = await q(client, 'SELECT * FROM season_players WHERE player_id = $1', [dropId]);
  for (const dsp of dropSeasons) {
    const [ksp] = await q(client, 'SELECT * FROM season_players WHERE player_id = $1 AND season_id = $2', [keepId, dsp.season_id]);
    if (!ksp) {
      await client.query('UPDATE season_players SET player_id = $1, updated_at = now() WHERE id = $2', [keepId, dsp.id]);
      continue;
    }
    summary.seasonsMerged++;
    const spots = await q(client, 'SELECT * FROM team_rosters WHERE season_player_id = $1', [dsp.id]);
    for (const s of spots) {
      const [existing] = await q(client, 'SELECT * FROM team_rosters WHERE season_player_id = $1 AND coalesce(team_id, 0) = coalesce($2::int, 0)', [ksp.id, s.team_id]);
      if (existing) {
        await client.query(
          `UPDATE team_rosters SET jersey_number = coalesce(jersey_number, $1), position = coalesce(position, $2),
                  is_sub = is_sub AND $3, registration_id = coalesce(registration_id, $4), updated_at = now() WHERE id = $5`,
          [s.jersey_number, s.position, s.is_sub, s.registration_id, existing.id]
        );
      } else {
        await client.query('UPDATE team_rosters SET season_player_id = $1, updated_at = now() WHERE id = $2', [ksp.id, s.id]);
        summary.rostersMoved++;
      }
    }
    // A real team spot makes a team-less placeholder redundant.
    await client.query(
      `DELETE FROM team_rosters WHERE season_player_id = $1 AND team_id IS NULL
         AND EXISTS (SELECT 1 FROM team_rosters x WHERE x.season_player_id = $1 AND x.team_id IS NOT NULL)`,
      [ksp.id]
    );
    await client.query(
      `UPDATE season_players SET level_override = coalesce(level_override, $1), level_override_note = coalesce(level_override_note, $2), updated_at = now()
        WHERE id = $3`,
      [dsp.level_override, dsp.level_override_note, ksp.id]
    );
    await client.query('DELETE FROM season_players WHERE id = $1', [dsp.id]);
  }

  // Ratings: one per rater per season for the merged person.
  const dropRatings = await q(client, 'SELECT * FROM ratings WHERE player_id = $1 ORDER BY created_at', [dropId]);
  for (const r of dropRatings) {
    const [clash] = await q(client, 'SELECT * FROM ratings WHERE player_id = $1 AND season_id = $2 AND rater_id = $3', [keepId, r.season_id, r.rater_id]);
    if (!clash) {
      await client.query('UPDATE ratings SET player_id = $1 WHERE id = $2', [keepId, r.id]);
      summary.ratingsMoved++;
    } else {
      const [older, newer] = new Date(clash.created_at) <= new Date(r.created_at) ? [clash, r] : [r, clash];
      if (older.id === r.id) {
        await client.query('DELETE FROM ratings WHERE id = $1', [clash.id]);
        await client.query('UPDATE ratings SET player_id = $1 WHERE id = $2', [keepId, r.id]);
      } else {
        await client.query('DELETE FROM ratings WHERE id = $1', [r.id]);
      }
      summary.ratingsDropped.push({ rating_id: newer.id, rater_id: r.rater_id, season_id: r.season_id });
    }
  }

  await client.query(
    `UPDATE players SET birth_date = coalesce(birth_date, $1), email = coalesce(email, $2), age = coalesce(age, $3),
            notes = CASE WHEN $4::text IS NULL THEN notes WHEN notes IS NULL THEN $4 ELSE notes || E'\n' || $4 END,
            active = active OR $5, updated_at = now()
      WHERE id = $6`,
    [drop.birth_date, drop.email, drop.age, drop.notes, drop.active, keepId]
  );
  await client.query('DELETE FROM players WHERE id = $1', [dropId]);
  return summary;
}

// Pairs of players who might be the same person, newest evidence first.
async function duplicateCandidates(client = db) {
  return q(
    client,
    `SELECT a.id AS a_id, b.id AS b_id,
            CASE
              WHEN a.name_key = b.name_key AND a.birth_date = b.birth_date THEN 'Same name and date of birth'
              WHEN a.name_key = b.name_key THEN 'Same name, a date of birth is missing'
              WHEN split_part(a.name_key, '|', 2) = split_part(b.name_key, '|', 2) THEN 'Same last name and date of birth'
              ELSE 'Same first name and date of birth'
            END AS reason
       FROM players a
       JOIN players b ON a.id < b.id
      WHERE NOT EXISTS (SELECT 1 FROM player_distinct_pairs d WHERE d.player_a = a.id AND d.player_b = b.id)
        AND (
              (a.name_key = b.name_key AND (a.birth_date IS NULL OR b.birth_date IS NULL OR a.birth_date = b.birth_date))
           OR (a.birth_date = b.birth_date AND (split_part(a.name_key, '|', 2) = split_part(b.name_key, '|', 2)
                                             OR split_part(a.name_key, '|', 1) = split_part(b.name_key, '|', 1)))
        )
      ORDER BY (a.name_key = b.name_key) DESC, a.last_name, a.first_name
      LIMIT 300`
  );
}

// Merges every pair with the same normalized name AND the same date of birth (the strongest signal),
// keeping the record without a "(Sub)"-style tag in its name, then the oldest. Returns merge summaries.
async function mergeExactMatches(client) {
  const groups = await q(
    client,
    `SELECT array_agg(id ORDER BY (first_name || last_name) ~ '[(\\[{]', id) AS ids
       FROM players WHERE name_key IS NOT NULL AND birth_date IS NOT NULL
      GROUP BY name_key, birth_date HAVING count(*) > 1`
  );
  const results = [];
  for (const { ids } of groups) {
    const [keepId, ...rest] = ids;
    for (const dropId of rest) {
      const distinct = await q(client, 'SELECT 1 FROM player_distinct_pairs WHERE player_a = $1 AND player_b = $2', [Math.min(keepId, dropId), Math.max(keepId, dropId)]);
      if (distinct.length) continue;
      results.push({ keepId, dropId, ...(await mergePlayers(client, keepId, dropId)) });
    }
    // Tidy a kept name that still carries a marker like "(Sub)".
    const [kept] = await q(client, 'SELECT first_name, last_name FROM players WHERE id = $1', [keepId]);
    const clean = normalizeName(kept.first_name, kept.last_name);
    if (clean.first_name !== kept.first_name || clean.last_name !== kept.last_name) {
      await client.query('UPDATE players SET first_name = $1, last_name = $2 WHERE id = $3', [clean.first_name, clean.last_name, keepId]);
    }
  }
  return results;
}

module.exports = { mergeExactMatches, cleanNamePart, normalizeName, nameKey, matchPlayer, linkExternalId, backfillNameKeys, mergePlayers, duplicateCandidates };
