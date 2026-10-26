-- The most points a team in a league may add up to (sum of its players' final ratings), per season.
-- division '' means teams with no league.
CREATE TABLE league_caps (
  season_id   integer NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  division    text NOT NULL,
  max_points  numeric(7,2) NOT NULL CHECK (max_points >= 0),
  updated_by  integer REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (season_id, division)
);
