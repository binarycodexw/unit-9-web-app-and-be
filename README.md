# WatchSecure

Stock watchlist web app for the Unit 9 coursework (Web Application Development, University of Essex Online).
Node.js + Express on the backend, PostgreSQL for the data, server-side rendered pages with EJS.

Users sign up, turn on two-factor authentication (TOTP), build watchlists with notes and target prices and look at
price charts. Admins manage the list of stocks that can be followed. Prices come from Alpha Vantage.

Live version: https://watchsecure.onrender.com

Not financial advice, and the prices in the seed data are made up.

## Stack

- Node.js 22, Express 5, EJS
- PostgreSQL 16 with `pg` (parameterised queries only)
- Sessions: `express-session` with `connect-pg-simple` (stored in PostgreSQL)
- Security: `argon2`, `otplib`, `qrcode`, `helmet`, `express-rate-limit`, `zod`
- Charts: Chart.js, installed with npm and served by the app itself (no CDN)
- Market data: Alpha Vantage `TIME_SERIES_DAILY`

## Running it

```bash
npm install
cp .env.example .env      # fill in SESSION_SECRET, MFA_ENCRYPTION_KEY, ADMIN_PASSWORD
docker compose up -d      # PostgreSQL on localhost:5433
npm run db:reset          # tables, sample data and the admin user
npm start                 # http://localhost:3000
```

The two secrets can be generated with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"         # MFA_ENCRYPTION_KEY
```

Tests need the database running:

```bash
npm test
```

## How prices work

Prices are stored in the database (`stocks.last_price` and the daily candles in `price_history`). When someone opens
a stock page and the stored price is older than `PRICE_MAX_AGE_HOURS` (12 by default), the server fetches it from
Alpha Vantage and saves it. If the daily quota is over or the API is down, the last stored price is kept.

The free plan only gives 25 calls a day, so the app stops at `API_DAILY_BUDGET` (20), waits 15 minutes after a
provider error and never makes two calls for the same stock at once.

## Where things are

| Requirement | Where |
|---|---|
| Database design, constraints, indexes | `db/schema.sql`, `docs/database.md` |
| SELECT / INSERT / UPDATE / DELETE forms | `src/routes/`, `views/` |
| Client-side validation | `public/js/app.js` |
| Server-side validation | `src/validation/schemas.js` |
| Prepared statements | every query in `src/` uses `$1, $2...` |
| Login and MFA | `src/routes/auth.js`, `src/routes/account.js`, `src/services/mfa.js` |
| Charts | `public/js/charts.js`, `src/services/chart.js`, `views/stock.ejs` |
| Tests | `tests/` |

## Security measures (OWASP Top 10:2021)

- **A01 Access control:** admin routes check the role, every query on user data also filters by `user_id`, CSRF token on every POST, redirects only to local paths.
- **A02 Cryptography:** Argon2id for passwords, MFA secrets encrypted with AES-256-GCM, secure cookies and HSTS in production, secrets only in environment variables.
- **A03 Injection:** parameterised SQL, zod validation, escaped EJS output, CSP without inline scripts, LIKE wildcards escaped in the search.
- **A04 Insecure design:** same error for wrong email or password, lock-out after 5 failed attempts, the MFA step only opens after the password was accepted, password and code needed to turn MFA off or delete the account.
- **A05 Misconfiguration:** `helmet` headers, no `X-Powered-By`, generic error pages, the app refuses to start with missing secrets, `no-store` cache header.
- **A06 Components:** `npm audit` reports no vulnerabilities, lock file is committed.
- **A07 Authentication:** passwords of at least 12 characters and a list of common passwords is refused, rate limiting, TOTP codes can't be reused, new session after login.
- **A08 Integrity:** the Alpha Vantage response is validated before it is saved.
- **A09 Logging:** sign-ins, failures, lock-outs, MFA changes and admin actions go to the `security_events` table, and administrators can read them on the Security log page (`/admin/events`).
- **A10 SSRF:** the Alpha Vantage URL is fixed, symbols are checked against a pattern, 8 second timeout, redirects are not followed.

## Deploying

The app is live at https://watchsecure.onrender.com. It runs as a Render web service with a Render PostgreSQL database in the same region. It is on the free plan, so it pauses when idle and the first request after a pause can take a minute.

To deploy your own copy:

1. Create a PostgreSQL database on Render (or Neon, Supabase...).
2. Create the tables and the admin user from your machine, using the external database URL. Put `DATABASE_URL`, `DATABASE_SSL=true`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` in a file such as `.env.render` (git ignores it), run `node --env-file=.env.render scripts/init-db.js --seed` and delete the file.
3. Create a web service from the repository: build command `npm install`, start command `node server.js`.
4. Add the environment variables in the dashboard: `NODE_ENV=production`, `NODE_VERSION=22`, `DATABASE_URL`, `DATABASE_SSL`, `SESSION_SECRET`, `MFA_ENCRYPTION_KEY` and, if wanted, `ALPHAVANTAGE_API_KEY`. With the internal database URL of a Render database use `DATABASE_SSL=false`, with an external URL use `true`.

Render provides the HTTPS certificate and redirects HTTP to HTTPS.

## Folders

```
server.js          entry point
src/app.js         middleware (helmet, sessions, CSRF) and routes
src/routes/        auth, account, watchlists, stocks, admin, pages
src/services/      MFA, Alpha Vantage client, price updates, chart data
src/middleware/    auth, csrf, rate limiting
src/validation/    zod schemas
db/                schema.sql and seed.sql
scripts/           init-db.js (tables, seed, admin)
views/, public/    templates, css and browser scripts
tests/             tests
docs/              database documentation
```
