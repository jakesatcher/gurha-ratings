-- Paper rating forms: printed sheets (several players each), filled in by hand and entered by an admin.

-- "Paper raters" are rater records without a login (name and optional email only).
ALTER TABLE users ADD COLUMN can_login boolean NOT NULL DEFAULT true;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- A printed form: which players appear, in which order, and which categories it scores.
CREATE TABLE paper_forms (
  id            serial PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  season_id     integer NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  team_id       integer REFERENCES teams(id) ON DELETE SET NULL,
  title         text NOT NULL,
  player_ids    integer[] NOT NULL,
  category_ids  integer[] NOT NULL,
  blank_rows    integer NOT NULL DEFAULT 0,
  created_by    integer REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One filled-in copy of a form, entered for a rater, with the optional scan kept as the record.
CREATE TABLE paper_submissions (
  id           serial PRIMARY KEY,
  form_id      integer NOT NULL REFERENCES paper_forms(id) ON DELETE CASCADE,
  rater_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scan_name    text,
  scan_type    text,
  scan_data    bytea,
  entered_by   integer REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX paper_submissions_form_idx ON paper_submissions (form_id);

ALTER TABLE ratings
  ADD COLUMN source text NOT NULL DEFAULT 'online' CHECK (source IN ('online', 'paper')),
  ADD COLUMN paper_submission_id integer REFERENCES paper_submissions(id) ON DELETE SET NULL;
