-- Outgoing email log (codes are redacted before storing) and admin notification preference.
CREATE TABLE email_log (
  id           serial PRIMARY KEY,
  to_address   text NOT NULL,
  kind         text NOT NULL,
  subject      text NOT NULL,
  status       text NOT NULL,           -- sent | failed | console | delivered | bounced | complained | delayed
  provider     text,
  provider_id  text,
  error        text,
  user_id      integer REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_log_created_idx ON email_log (created_at DESC);
CREATE INDEX email_log_provider_idx ON email_log (provider_id);

ALTER TABLE users ADD COLUMN notify_access_requests boolean NOT NULL DEFAULT true;
