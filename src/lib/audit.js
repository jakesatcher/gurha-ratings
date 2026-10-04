'use strict';

const db = require('../db');

async function audit(actorId, action, entity, entityId, details, client = db) {
  await client.query(
    'INSERT INTO audit_log (actor_id, action, entity, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
    [actorId || null, action, entity || null, entityId || null, details ? JSON.stringify(details) : null]
  );
}

module.exports = { audit };
