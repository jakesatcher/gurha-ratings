-- People vs. registrations.
-- A SportsEngine "SportNgin ID" identifies a registration, not a person: the same player gets a new
-- ID each time they register (e.g. once as a regular, again as a sub on another team). So:
--   * players            = people (rated once per season)
--   * player_external_ids = every registration/external ID seen for a person
--   * team_rosters       = a person's spots on teams in a season (several allowed, e.g. as a sub)
--   * season_players     = the person in a season (holds the season's level override)

CREATE TABLE player_external_ids (
  id           serial PRIMARY KEY,
  player_id    integer NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  external_id  text NOT NULL UNIQUE,
  source       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX player_external_ids_player_idx ON player_external_ids (player_id);
INSERT INTO player_external_ids (player_id, external_id, source)
SELECT id, external_id, source FROM players WHERE external_id IS NOT NULL;
ALTER TABLE players DROP COLUMN external_id;

-- Normalized "first|last" used to recognise the same person across registrations (filled in by the app).
ALTER TABLE players ADD COLUMN name_key text;
CREATE INDEX players_name_key_idx ON players (name_key);
CREATE INDEX players_birth_date_idx ON players (birth_date);

CREATE TABLE team_rosters (
  id                serial PRIMARY KEY,
  season_player_id  integer NOT NULL REFERENCES season_players(id) ON DELETE CASCADE,
  team_id           integer REFERENCES teams(id) ON DELETE CASCADE,
  jersey_number     text,
  position          text CHECK (position IN ('F', 'D', 'G')),
  is_sub            boolean NOT NULL DEFAULT false,
  registration_id   text,
  source            text NOT NULL DEFAULT 'manual',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- One spot per team per person-season; at most one team-less spot.
CREATE UNIQUE INDEX team_rosters_unique_idx ON team_rosters (season_player_id, coalesce(team_id, 0));
CREATE INDEX team_rosters_team_idx ON team_rosters (team_id);

INSERT INTO team_rosters (season_player_id, team_id, jersey_number, position, source)
SELECT id, team_id, jersey_number, position, source FROM season_players;

ALTER TABLE season_players
  DROP COLUMN team_id,
  DROP COLUMN jersey_number,
  DROP COLUMN position;

-- Pairs an admin has confirmed are different people (hidden from the duplicates list).
CREATE TABLE player_distinct_pairs (
  player_a    integer NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  player_b    integer NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_by  integer REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_a, player_b),
  CHECK (player_a < player_b)
);
