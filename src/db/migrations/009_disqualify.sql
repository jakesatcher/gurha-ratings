-- Admins can disqualify a rating that's unrealistic for the player. It stays on record (with who,
-- when and why) but no longer counts toward any average.
ALTER TABLE ratings ADD COLUMN disqualified_at timestamptz;
ALTER TABLE ratings ADD COLUMN disqualified_by integer REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ratings ADD COLUMN disqualified_reason text;
