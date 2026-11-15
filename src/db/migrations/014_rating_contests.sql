-- Requests from the public to review a player's rating ("Contest rating").
CREATE TABLE rating_contests (
  id            serial PRIMARY KEY,
  player_id     integer NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season_id     integer REFERENCES seasons(id) ON DELETE SET NULL,
  name          text NOT NULL,
  email         text NOT NULL,
  relationship  text,
  message       text NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  admin_note    text,
  resolved_by   integer REFERENCES users(id) ON DELETE SET NULL,
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rating_contests_status_idx ON rating_contests (status, created_at DESC);
