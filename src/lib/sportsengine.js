'use strict';

// SportsEngine roster sync.
//
// SportsEngine exposes its API (GraphQL) to organizations that request developer access.
// The OAuth client-credentials flow and the GraphQL endpoint/query are configurable via
// environment variables because the exact schema available depends on your organization's
// API access. The response normalizer below walks whatever JSON comes back and collects any
// person-like nodes (objects with first/last name), so it tolerates schema differences.
const config = require('../config');

const DEFAULT_QUERY = `
query GurhaRoster($organizationId: ID!, $seasonId: ID) {
  teams(organizationId: $organizationId, seasonId: $seasonId) {
    results {
      id
      name
      division { name }
      roster {
        results {
          id
          firstName
          lastName
          jerseyNumber
          position
          email
        }
      }
    }
  }
}`;

function isConfigured() {
  const se = config.sportsEngine;
  return Boolean(se.clientId && se.clientSecret && se.organizationId);
}

async function getAccessToken() {
  const se = config.sportsEngine;
  const res = await fetch(se.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: se.clientId, client_secret: se.clientSecret }),
  });
  if (!res.ok) throw new Error(`SportsEngine auth failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('SportsEngine auth response did not include an access_token');
  return json.access_token;
}

async function runQuery(token) {
  const se = config.sportsEngine;
  const res = await fetch(se.graphqlUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      query: se.rosterQuery || DEFAULT_QUERY,
      variables: { organizationId: se.organizationId, seasonId: se.seasonId || null },
    }),
  });
  if (!res.ok) throw new Error(`SportsEngine API error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error(`SportsEngine API error: ${json.errors.map((e) => e.message).join('; ').slice(0, 500)}`);
  }
  return json.data;
}

const first = (o, keys) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return null;
};

// Recursively collects player records, carrying team/division context down from parent nodes.
function extractPlayers(node, ctx = {}, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) extractPlayers(item, ctx, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;

  const firstName = first(node, ['firstName', 'first_name', 'givenName']);
  const lastName = first(node, ['lastName', 'last_name', 'familyName', 'surname']);
  if (firstName && lastName) {
    out.push({
      first_name: String(firstName),
      last_name: String(lastName),
      jersey_number: first(node, ['jerseyNumber', 'jersey_number', 'number']),
      position: first(node, ['position', 'positionName']),
      email: first(node, ['email', 'emailAddress']),
      external_id: node.id ? `se:${node.id}` : null,
      team: ctx.team || null,
      division: ctx.division || null,
    });
    return out;
  }

  const next = { ...ctx };
  const looksLikeTeam = node.name && (node.roster || node.players || node.members || node.rosterPlayers);
  if (looksLikeTeam) {
    next.team = node.name;
    const div = node.division || node.league || node.program;
    if (div) next.division = typeof div === 'string' ? div : div.name || next.division;
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') extractPlayers(v, next, out);
  }
  return out;
}

async function fetchRoster() {
  if (!isConfigured()) {
    throw new Error('SportsEngine is not configured. Set SPORTSENGINE_CLIENT_ID, SPORTSENGINE_CLIENT_SECRET and SPORTSENGINE_ORG_ID.');
  }
  const token = await getAccessToken();
  const data = await runQuery(token);
  return extractPlayers(data);
}

module.exports = { isConfigured, fetchRoster, extractPlayers, DEFAULT_QUERY };
