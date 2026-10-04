# GURHA Ratings

Player rating system for GURHA Recreational Hockey, at **https://gurha.hockey**.

Approved raters search for players and score them using the official **GURHA Player Rating Form**. The app averages every rater's scores into a weighted overall score (0–11) and a GURHA level (BEG → A1).

## Features

**Raters**
- Request access. An admin must approve the request before the rater can sign in.
- Two-step verification at every sign-in: an **authenticator app** (TOTP) or **email codes**.
- Search players by name, team, division or jersey #. Filter by team, position, "not rated by me" or "needs 3rd review".
- Rate a player on the six weighted categories, scored 0–11:

  | Category | Weight |
  |---|---|
  | Skating | 25% |
  | Puck Skills | 20% |
  | Passing & Receiving | 15% |
  | Shooting | 10% |
  | Hockey IQ / Awareness | 20% |
  | Game Execution | 10% |

  The form also includes the independent level assessment, game performance check, age and injury sections, evidence, strengths, areas to improve, and the final recommended level. The overall score and level update live as you score.
- **One rating per player per rater.** This is enforced in the database. Submitting again shows:
  > You already rated this player. If you feel this is an error, or would like to change your rating, please contact an Admin
- View submitted ratings and averages. Other raters show as "Rater 1", "Rater 2" by default.
- Team summary report that mirrors the *Team Player Rating & Division Summary* sheet, and can be printed.

**Admins**
- Approve or reject access requests (by email notification and on the Users page). Promote users to admin, disable accounts, reset a user's two-step verification.
- Add or edit players manually. Import players from **CSV / JSON**, or sync from **SportsEngine**.
- **Edit or delete any submitted rating**, with an optional reason. Every change is written to the audit log.
- Set a final level override on a player.
- Edit categories: weights, score ranges, guide text, and adding or deactivating categories.
- Players are **flagged for a third review** when raters' levels differ by 2 or more, as the form's guidelines require.
- Export everything to CSV.

## How scores are calculated

- **Rating overall** = Σ(score × weight) ÷ Σ(weights). With the default weights this is exactly the form's formula: `(Skating × .25) + (Puck × .20) + (Passing × .15) + (Shooting × .10) + (IQ × .20) + (Execution × .10)`.
- **Calculated level** = the overall score rounded to the nearest whole number, mapped as 0=BEG, 1=D3 … 11=A1.
- **Player final rating** = the average of all raters' overall scores. The player's level comes from that average, unless an admin set an override.
- **Raters' recommended** = the average of each rater's *final recommended level*.
- **3rd review flag**: raters' final recommended levels differ by ≥ 2 steps.

## Deploying on Railway

1. Create a new Railway project → **Deploy from GitHub repo** → `gurha-ratings`.
2. Add a **PostgreSQL** database to the project.
3. On the app service, set these variables (see `.env.example`):
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `NODE_ENV=production`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `APP_URL=https://gurha.hockey`
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`: your first admin account. It is created on first boot.
   - `RESEND_API_KEY` (or the `SMTP_*` variables) and `MAIL_FROM`.
4. Deploy. Migrations run automatically at startup. The health check is `/healthz`.
5. **Custom domain**: Service → Settings → Networking → *Custom Domain* → `gurha.hockey`. Railway gives you a DNS record to add at your registrar. Use a CNAME (or an ALIAS/flattened CNAME for the root domain), plus a TXT verification record if Railway asks for one. TLS is issued automatically.
6. **Email**: in Resend, verify the `gurha.hockey` domain by adding the SPF/DKIM DNS records it lists. Then set `MAIL_FROM=GURHA Ratings <no-reply@gurha.hockey>`.

Until email is configured, codes are printed to the server log. That is fine for testing, but not for real users.

## SportsEngine

Set `SPORTSENGINE_CLIENT_ID`, `SPORTSENGINE_CLIENT_SECRET` and `SPORTSENGINE_ORG_ID` (optionally `SPORTSENGINE_SEASON_ID`). A **Sync from SportsEngine** button then appears under Admin → Import.

The integration uses OAuth client credentials and a GraphQL roster query. API access, endpoints and schema depend on what SportsEngine grants your organization, so the token URL, GraphQL URL and query can all be overridden with env vars. The sync collects any player records (first/last name, jersey, position, team) wherever they appear in the response. It matches existing players by SportsEngine ID, then by name + team, and never deletes anyone.

## Import format

CSV or JSON with any of these columns: `first_name`, `last_name` (or one `name` column), `jersey_number`, `team`, `division`, `position` (F/D/G or Forward/Defense/Goalie), `age`, `email`, `external_id`, `notes`. Download a template from Admin → Import.

## Local development

```bash
npm install
cp .env.example .env    # set DATABASE_URL to a local Postgres; leave NODE_ENV unset
npm run dev             # http://localhost:3000
npm test                # needs a Postgres database; set TEST_DATABASE_URL
```

The test suite drops and recreates the schema in `TEST_DATABASE_URL`, so never point it at production.

## Tech

Node 22 · Express 5 · PostgreSQL · server-rendered EJS. The front end is mobile-first with no build step. Sessions are stored in Postgres. Passwords are hashed with bcrypt. Authenticator secrets are encrypted with AES-256-GCM. The app uses CSRF tokens, Helmet/CSP and rate limits on auth endpoints.
