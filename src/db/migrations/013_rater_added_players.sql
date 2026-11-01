-- Players a rater added to a team (someone not on the roster, or wearing the wrong number), with
-- the rater's short description so admins can identify and merge them later.
ALTER TABLE players ADD COLUMN added_by integer REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE players ADD COLUMN added_note text;
