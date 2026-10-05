-- Seasons: players persist across seasons; team, jersey, position and ratings are per season.

CREATE TABLE seasons (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  start_date    date,
  end_date      date,
  external_id   text UNIQUE,
  is_current    boolean NOT NULL DEFAULT false,
  ratings_open  boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX seasons_name_idx ON seasons (lower(name));
CREATE UNIQUE INDEX seasons_one_current_idx ON seasons (is_current) WHERE is_current;

CREATE TABLE teams (
  id           serial PRIMARY KEY,
  season_id    integer NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  name         text NOT NULL,
  division     text,
  external_id  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (season_id, external_id)
);
CREATE UNIQUE INDEX teams_season_name_idx ON teams (season_id, lower(name));

-- A player's roster entry for a season (one primary team per season).
CREATE TABLE season_players (
  id                   serial PRIMARY KEY,
  season_id            integer NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  player_id            integer NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id              integer REFERENCES teams(id) ON DELETE SET NULL,
  jersey_number        text,
  position             text CHECK (position IN ('F', 'D', 'G')),
  level_override       text,
  level_override_note  text,
  source               text NOT NULL DEFAULT 'manual',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (season_id, player_id)
);
CREATE INDEX season_players_team_idx ON season_players (team_id);

-- Move existing data into a starting season (rename it from Admin → Seasons).
INSERT INTO seasons (name, is_current) VALUES ('Current Season', true);

INSERT INTO teams (season_id, name, division)
SELECT s.id, min(p.team), max(p.division)
  FROM players p CROSS JOIN seasons s
 WHERE p.team IS NOT NULL AND p.team <> ''
 GROUP BY s.id, lower(p.team);

INSERT INTO season_players (season_id, player_id, team_id, jersey_number, position, level_override, level_override_note, source)
SELECT s.id, p.id, t.id, p.jersey_number, p.position, p.level_override, p.level_override_note, p.source
  FROM players p
 CROSS JOIN seasons s
  LEFT JOIN teams t ON t.season_id = s.id AND lower(t.name) = lower(p.team);

ALTER TABLE ratings ADD COLUMN season_id integer REFERENCES seasons(id) ON DELETE CASCADE;
UPDATE ratings SET season_id = (SELECT id FROM seasons LIMIT 1);
ALTER TABLE ratings ALTER COLUMN season_id SET NOT NULL;
ALTER TABLE ratings DROP CONSTRAINT ratings_one_per_rater;
ALTER TABLE ratings ADD CONSTRAINT ratings_one_per_rater_per_season UNIQUE (season_id, player_id, rater_id);
CREATE INDEX ratings_player_idx ON ratings (player_id);

ALTER TABLE players
  DROP COLUMN team,
  DROP COLUMN division,
  DROP COLUMN jersey_number,
  DROP COLUMN position,
  DROP COLUMN level_override,
  DROP COLUMN level_override_note;
