-- Users (admins and raters)
CREATE TABLE users (
  id                  serial PRIMARY KEY,
  email               text NOT NULL,
  name                text NOT NULL,
  password_hash       text NOT NULL,
  role                text NOT NULL DEFAULT 'rater' CHECK (role IN ('admin', 'rater')),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'disabled')),
  request_note        text,
  mfa_method          text CHECK (mfa_method IN ('email', 'totp')),
  totp_secret_enc     text,
  approved_by         integer REFERENCES users(id) ON DELETE SET NULL,
  approved_at         timestamptz,
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

-- One-time codes sent by email (login second factor / MFA enrollment)
CREATE TABLE email_otps (
  id           serial PRIMARY KEY,
  user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash    text NOT NULL,
  purpose      text NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_otps_user_idx ON email_otps (user_id, purpose, created_at DESC);

CREATE TABLE password_resets (
  id           serial PRIMARY KEY,
  user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Rating categories (admin-editable)
CREATE TABLE categories (
  id             serial PRIMARY KEY,
  key            text NOT NULL UNIQUE,
  name           text NOT NULL,
  weight         numeric(6,2) NOT NULL CHECK (weight >= 0),
  min_score      integer NOT NULL DEFAULT 0,
  max_score      integer NOT NULL DEFAULT 11,
  considerations text[] NOT NULL DEFAULT '{}',
  key_question   text,
  note           text,
  guide          jsonb NOT NULL DEFAULT '[]',
  sort_order     integer NOT NULL DEFAULT 0,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (max_score > min_score)
);

-- Players
CREATE TABLE players (
  id                   serial PRIMARY KEY,
  first_name           text NOT NULL,
  last_name            text NOT NULL,
  jersey_number        text,
  team                 text,
  division             text,
  position             text CHECK (position IN ('F', 'D', 'G')),
  age                  integer CHECK (age IS NULL OR (age > 0 AND age < 120)),
  email                text,
  external_id          text UNIQUE,
  source               text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'sportsengine')),
  notes                text,
  active               boolean NOT NULL DEFAULT true,
  level_override       text,
  level_override_note  text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX players_name_idx ON players (lower(last_name), lower(first_name));
CREATE INDEX players_team_idx ON players (lower(team));

-- Ratings: exactly one per (player, rater)
CREATE TABLE ratings (
  id                     serial PRIMARY KEY,
  player_id              integer NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  rater_id               integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  independent_level      text,
  game_performance       text CHECK (game_performance IN ('consistently', 'usually', 'sometimes', 'rarely')),
  game_performance_note  text,
  age_limited            boolean,
  age_areas              text[] NOT NULL DEFAULT '{}',
  age_comments           text,
  injury                 text,
  injury_affects         text[] NOT NULL DEFAULT '{}',
  injury_temporary       text CHECK (injury_temporary IN ('yes', 'no', 'unknown')),
  injury_normal_level    text,
  injury_current_level   text,
  injury_comments        text,
  evidence               text,
  strengths              text,
  improvements           text,
  final_level            text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             integer REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ratings_one_per_rater UNIQUE (player_id, rater_id)
);

CREATE TABLE rating_scores (
  rating_id    integer NOT NULL REFERENCES ratings(id) ON DELETE CASCADE,
  category_id  integer NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  score        integer NOT NULL,
  comment      text,
  PRIMARY KEY (rating_id, category_id)
);

CREATE TABLE audit_log (
  id          serial PRIMARY KEY,
  actor_id    integer REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity      text,
  entity_id   integer,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);

-- Seed the six GURHA categories from the official Player Rating Form
INSERT INTO categories (key, name, weight, sort_order, considerations, key_question, note, guide) VALUES
('skating', 'Skating', 25, 1,
  ARRAY['Forward skating','Backward skating','Speed and acceleration','Stops and starts','Turns and transitions','Forward and backward crossovers','Agility and edge control','Ability to skate effectively under pressure'],
  NULL, NULL,
  '[{"range":"0–3","label":"D Level","text":"Basic skating ability. May struggle with backward skating, stopping, transitions, speed, balance or agility."},
    {"range":"4–6","label":"C Level","text":"Comfortable skating forward and backward. Can stop, turn and transition effectively in normal game situations."},
    {"range":"7–9","label":"B Level","text":"Strong skater. Good speed, acceleration, agility, edge control and transitions. Uses skating effectively to create space or defend."},
    {"range":"10–11","label":"A Level","text":"Exceptional skating. High-end speed, acceleration, agility and edge control. Can consistently create separation or eliminate it through skating."}]'),
('puck_skills', 'Puck Skills', 20, 2,
  ARRAY['Stickhandling','Puck control while skating','Forehand and backhand control','Receiving difficult passes','Puck protection','Handling pressure','Carrying the puck through traffic','Making plays in limited time and space'],
  'When an opponent is trying to take the puck away, how consistently can this player maintain possession?', NULL,
  '[{"range":"0–3","label":"D Level","text":"Can control the puck but frequently loses possession or struggles when pressured."},
    {"range":"4–6","label":"C Level","text":"Generally controls the puck well during normal play and can protect it against moderate pressure."},
    {"range":"7–9","label":"B Level","text":"Strong puck control under pressure. Can protect, carry and maneuver the puck around opponents."},
    {"range":"10–11","label":"A Level","text":"Exceptional puck control. Can manipulate defenders, make plays in tight spaces and consistently maintain possession against strong pressure."}]'),
('passing', 'Passing & Receiving', 15, 3,
  ARRAY['Passing accuracy','Receiving passes cleanly','Passing while moving','Passing to moving teammates','Backhand passing and receiving','Passing under pressure','Recognizing passing opportunities','Choosing the correct pass'],
  'Can this player consistently make the right pass, accurately, at game speed and under pressure?', NULL,
  '[{"range":"0–3","label":"D Level","text":"Basic passing and receiving. Inconsistent accuracy or difficulty making plays under pressure."},
    {"range":"4–6","label":"C Level","text":"Reliable short and intermediate passing. Usually receives the puck cleanly and makes appropriate passes."},
    {"range":"7–9","label":"B Level","text":"Consistently accurate and timely passing. Can make difficult passes, find moving teammates and execute under pressure."},
    {"range":"10–11","label":"A Level","text":"Exceptional passing vision and execution. Consistently creates opportunities for teammates with difficult or unexpected passes."}]'),
('shooting', 'Shooting', 10, 4,
  ARRAY['Accuracy','Shot power','Release','Shooting while skating','Shooting under pressure','Shot selection','Ability to create scoring opportunities'],
  NULL, 'Do not rate shooting based only on how hard the player shoots. A player with a very hard shot that rarely hits the net should not automatically receive a high shooting rating.',
  '[{"range":"0–3","label":"D Level","text":"Limited accuracy, power or consistency."},
    {"range":"4–6","label":"C Level","text":"Can shoot effectively in normal situations and generally makes reasonable decisions about when to shoot."},
    {"range":"7–9","label":"B Level","text":"Good combination of accuracy, power and release. Can create and finish scoring opportunities."},
    {"range":"10–11","label":"A Level","text":"Exceptional shooter. Accurate, powerful and deceptive, with excellent shot selection and the ability to score from multiple situations."}]'),
('hockey_iq', 'Hockey IQ / Awareness', 20, 5,
  ARRAY['Positioning','Knowing where the puck is','Knowing where teammates are','Knowing where opponents are','Anticipation','Offensive positioning','Defensive positioning','Decision making','Finding open ice','Supporting teammates','Recognizing developing plays'],
  'Does this player understand what is happening on the ice and consistently make good decisions?', NULL,
  '[{"range":"0–3","label":"D Level","text":"Often out of position or reacts late. Needs to follow the play rather than anticipate it."},
    {"range":"4–6","label":"C Level","text":"Generally understands positioning and makes reasonable decisions during normal play."},
    {"range":"7–9","label":"B Level","text":"Usually anticipates plays before they happen. Consistently finds open ice, supports teammates and makes good offensive and defensive decisions."},
    {"range":"10–11","label":"A Level","text":"Exceptional anticipation and understanding of the game. Frequently appears to be in the right place before the play develops and consistently makes high-level decisions."}]'),
('game_execution', 'Game Execution', 10, 6,
  ARRAY['Does the player actually use their skills during games?','Can they execute at game speed?','Can they execute while under pressure?','Can they execute when tired?','Do they make good decisions under pressure?','Do they maintain their level throughout the game?','Do they contribute consistently?','Can they adjust when opponents change their approach?'],
  NULL, 'This category is the reality check for the entire rating.',
  '[{"range":"0–3","label":"D Level","text":"Skills are inconsistent in game situations. Pressure significantly reduces performance."},
    {"range":"4–6","label":"C Level","text":"Usually able to execute skills effectively during normal game play."},
    {"range":"7–9","label":"B Level","text":"Consistently executes skills at game speed and under pressure. Remains effective throughout the game."},
    {"range":"10–11","label":"A Level","text":"Consistently performs at a high level regardless of pressure, pace or game situation."}]');

-- Session store (connect-pg-simple)
CREATE TABLE user_sessions (
  sid     varchar NOT NULL PRIMARY KEY,
  sess    json NOT NULL,
  expire  timestamp(6) NOT NULL
);
CREATE INDEX user_sessions_expire_idx ON user_sessions (expire);
