-- Viewer role: can see every league, team, player and rating, but can't rate or change anything.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'rater', 'viewer'));
-- What the person asked for when requesting access (kept for the admin's reference).
ALTER TABLE users ADD COLUMN requested_role text CHECK (requested_role IN ('rater', 'viewer'));
