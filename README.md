# GURHA Ratings

Player rating system for GURHA Recreational Hockey, at **https://gurha.hockey**.

Approved raters search for players and score them using the official **GURHA Player Rating Form**. The app averages every rater's scores into a weighted overall score (0–11) and a GURHA level (BEG → A1).

## Features

**Seasons**
- Each season has its own teams, rosters (team, jersey, position) and ratings. Players carry over between seasons, so their history builds up over time.
- A season selector under the header switches everything (player list, ratings, team reports, exports) to that season. The **current** season is the default.
- Admins create seasons by hand (optionally copying the previous roster) or by importing from SportsEngine. Admins can also rename seasons, edit teams and divisions, and open or close each season for ratings.
- Each player page shows a **season history**: team, average score, level and the change from the previous rated season.

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
- **One rating per player per rater, per season.** This is enforced in the database. Submitting again in the same season shows:
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
- **Player final rating** (per season) = the average of all raters' overall scores that season. The player's level comes from that average, unless an admin set an override for that season.
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

Set `SPORTSENGINE_CLIENT_ID`, `SPORTSENGINE_CLIENT_SECRET` and `SPORTSENGINE_ORG_ID`. Then use **Admin → SportsEngine**:

1. **Choose a SportsEngine season.** If your API access doesn't expose seasons, you browse all teams instead.
2. **Tick the teams to import**, and choose the GURHA season they go into. That can be an existing season, or a new one named and dated from SportsEngine.
3. **Import.** Teams and roster entries are created in that season. Players are matched to existing GURHA players (by SportsEngine ID, then name), so history carries across seasons. Nobody is deleted, and re-importing updates the roster in place.

SportsEngine rejects queries over a complexity budget (101; roughly 1 + page size × nested objects). The app only requests the fields it uses: team ID/name/division, and player name, jersey, position, profile ID, date of birth and SportsEngine ID. It sizes pages to fit the budget, and if the API still reports "Query is too complex", it shrinks the page and retries. A player's profile ID and SportsEngine ID are stored as person-level IDs alongside the roster entry's registration ID, so the same person is recognised across registrations and seasons. Override the budget with `SPORTSENGINE_MAX_COMPLEXITY` if SportsEngine changes it.

The integration authenticates with OAuth client credentials. It reads the GraphQL schema (introspection) and builds every query from the fields your access actually exposes. Teams are filtered to a season by a season argument if `teams` has one, by a season field on the team, or through divisions. Rosters are fetched per team with `team(id)` when available. **Admin → SportsEngine → Diagnostics** runs a dry run that shows the generated query and the raw response. If introspection is disabled for your account, set `SPORTSENGINE_ROSTER_QUERY`.

## Browsing

**Players** opens on the leagues for the selected season (C1B2, D1C2, D2, D3…). Each league card shows its teams, players and rating progress. Open a league to see its teams, then a team to see its roster (regulars, then subs) with Rate buttons, then a player for their ratings and season history. Breadcrumbs (Leagues › League › Team › Player) link back up. The search box and "Players I haven't rated" / "All players" links are on the leagues page.

## Look and feel

The pages sit on a rink: a full NHL-proportion rink drawn in SVG, rotated for phones. The header is styled like a scoreboard with jersey-style headings (the Oswald font, self-hosted under the SIL Open Font License). Sponsor "dasher boards" scroll under the header, and there are board ads in player lists and a footer banner. The sponsors are fictional and live in `src/lib/ads.js` and `public/ads/`. Set `ADS_ENABLED=false` to turn all ads off.

## Players, registrations and duplicates

SportsEngine issues a new **SportNgin ID for every registration**, not every person. The same player can show up as "Hassan" #50 on one team and "Hassan (Sub)" #23 on another, with two different IDs. The app keeps three separate things:

- **A player** is a person. They're rated **once per season** however many teams they're on.
- **Registration IDs:** every SportNgin/SportsEngine ID seen for that person. A known ID always links straight back to them.
- **Roster spots:** the teams a person is on in a season, each with its own jersey, position and sub flag. Team reports list everyone on the team (subs marked). The player list shows each person once.

Imports match people in this order:

1. A registration ID already linked to someone.
2. **Same name + same date of birth.** Names are normalized first: "(Sub)", "[sub]" and "- Sub" are stripped and recorded as a sub spot; case, accents and punctuation are ignored.
3. Same name when one side has no date of birth and only one person matches.

**Different dates of birth always mean different people** (e.g. a father and son with the same name). Anything ambiguous comes in as a new player and is listed under **Admin → Duplicates**. That page also catches nicknames (same last name + date of birth, e.g. Tom / Thomas) and records without a date of birth. Admins merge a pair, or mark them as different people so the pair isn't suggested again. **Merge all exact matches** handles every same-name + same-date-of-birth pair in one click. Merging combines registration IDs, rosters and level overrides. If one rater rated both records in the same season, the earlier rating is kept, and every merge is recorded in the audit log.

## SportsEngine roster export (.xls)

**Admin → Import → SportsEngine roster export** takes the workbook SportsEngine exports: one sheet per team. Each sheet has `League`, `Division`, `Season` and `Team` rows (the team row includes the SportsEngine team ID), then a header row: `SportNgin ID`, `Jersey #`, `First Name`, `Last Name`, `Position`, `Date of Birth`, `Gender`, `Height`, `Weight`, `Shoots`, `Grad Year`, `High School`, `ACT`, `SAT`, `GPA`.

| Export column / row | Stored as |
|---|---|
| `League` row | Ignored: it's always Greer Upstate Recreational Hockey League (GURHA) |
| `Team` row (name + ID) | Team in the chosen season, linked by SportsEngine team ID |
| `Division` row (`C1B2 DIVISION`) | Team division (`C1B2`) |
| `Season` row | Suggested season name (the last value, e.g. `FALL SEASON 2026`) |
| `SportNgin ID` | A registration ID on the player (see above) |
| `Jersey #`, `Position` | The player's roster spot on that team (a blank value doesn't erase an existing one) |
| `First Name`, `Last Name` | Player name. Tags like "(Sub)" are removed and mark the spot as a sub; "(Substitute goalie)" also sets the position to goalie |
| `Date of Birth` | Player's date of birth, used for matching. Raters only see the age calculated from it |
| Gender, Height, Weight, Shoots, school/test columns | Ignored |

After upload, the review page shows every row's match (**Existing**, **New**, **Same person** as another row in the file, or **New · review**) and how many people the roster rows add up to. You then pick the teams and the season to import into. Nothing is saved until you confirm, and the upload is discarded afterwards. Only the Excel 97–2003 `.xls` format is supported.

## Import format

Files are imported into the season selected at the top of the page. Use CSV or JSON with any of these columns: `first_name`, `last_name` (or one `name` column), `jersey_number`, `team`, `division`, `position` (F/D/G or Forward/Defense/Goalie), `age`, `email`, `external_id`, `notes`. Download a template from Admin → Import.

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
