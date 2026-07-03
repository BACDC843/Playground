# Renew Urban Social Dashboard — standalone web app

A normal local web app (Node/Express + static HTML/CSS/JS) that shows the same
Facebook/Instagram analytics as the Cowork-artifact version in `../index.html`,
without depending on the Cowork sandbox at all. No `window.cowork`, no
`mcpTools` registration, no iframe CSP workarounds -- just `fetch()` calls
from the browser to a small local server that holds your Meta access token.

## Why this exists

The Cowork-artifact version (`../index.html`) runs inside a sandboxed iframe
that only allows API calls through `window.cowork.callMcpTool()`, which has
been finicky (tool registration resets, response-size hangs, blocked
external images). This version sidesteps all of that: it's a real server
process and a real browser tab.

## Setup

```bash
cd server
npm install
cp .env.example .env
# edit .env and set META_ACCESS_TOKEN to a valid Page Access Token
npm start
```

Then open **http://localhost:3000** in your browser.

## How it's structured

```
webapp/
  server/
    index.js       Express server: proxies the Meta Graph API, serves public/
    package.json
    .env.example    Copy to .env and fill in your token (never commit .env)
  public/
    index.html      Page markup
    styles.css      All styling -- colors/fonts pulled from DESIGN-SYSTEM.md
    app.js          Dashboard logic: tabs, calendar, charts, KPIs, insights
  DESIGN-SYSTEM.md  Renew Urban's brand/design system doc (colors, type, etc.)
```

## Brand styling

`styles.css`'s `:root` block maps directly onto `DESIGN-SYSTEM.md`'s tokens:
navy (`--dark`) for the header and dark surfaces, gold (`--gold`/`--gold-lt`)
for accents/borders/active states, warm white/stone (`--bg`/`--border`) for
the page background and card borders, and the serif/sans pairing
(`--serif`/`--sans`) -- serif on the logo, big KPI numbers, the spotlight
quote, and the executive summary; sans everywhere else, since a dense data
dashboard needs to stay a "utility" surface per the design system's own
distinction between hero/editorial and body/utility type. Facebook blue and
Instagram's gradient are kept as-is on their platform-specific badges/pills
since those are functional (telling IG data from FB data at a glance), not
decorative. If the brand system changes, update `DESIGN-SYSTEM.md` and
re-map the `:root` tokens in `styles.css` from it.

The server never sends your access token to the browser. The frontend only
ever calls its own `/api/dashboard` endpoint; the server does the Meta Graph
API calls and returns plain JSON.

## What's different from the Cowork artifact version

- **No embedded seed data.** The old version shipped ~2.7MB of embedded
  June 2026 data (including base64 images) so the artifact had something to
  show before a live fetch. This version just fetches on load -- a local
  server round-trip is fast and reliable, so there's no need for a seed.
- **Images load directly from Meta's CDN URLs** (`<img src="...">`) instead
  of being pre-fetched and base64-embedded. That workaround only existed
  because the Cowork iframe's CSP blocked external images; a normal browser
  has no such restriction. Meta's CDN URLs are signed and expire after a
  while -- if a thumbnail 404s, it falls back to a placeholder icon instead
  of showing a broken image.
- **Month-over-month badges work.** The artifact version had this feature
  fully built in the UI but never wired up with data (fetching a second
  period would have doubled the number of `callMcpTool` calls and made the
  hangs worse). A plain server-to-server HTTP call doesn't have that
  problem, so the server fetches the equivalent previous period alongside
  the current one and the dashboard now shows real ↑/↓ deltas.
- **The Insights tab is rule-based only** (`buildRuleInsights()`), no
  external AI call -- keeps the whole thing self-contained with zero
  external dependencies besides Meta's API and the Chart.js CDN script.
- **Refresh became "Reload"** -- since every page load already fetches live
  data, there's no separate stale-vs-live state to manage. The button just
  re-fetches the current date range.

## Testing without a real Meta token

`server/index.js` respects an optional `META_GRAPH_BASE_URL` env var (see
`.env.example`) that overrides the Graph API host. Pointing it at a local
mock server that returns canned JSON in the same shape as the real Graph API
is how this was verified end-to-end during development, without needing
real credentials.

## Upcoming posts (GoHighLevel Social Planner)

Optional. If `GHL_API_KEY` and `GHL_LOCATION_ID` are set, the Overview tab
shows an "Upcoming Posts" section and the content calendar marks scheduled
(not-yet-published) days with a dashed gold border, pulled from GHL's
Social Planner rather than Meta (Meta only ever returns posts that have
already gone live).

To set it up:
1. In GHL, go to **Settings -> Private Integrations -> Create** and grant
   it read access to Social Media Posting / Posts. Copy the token (starts
   with `pit-`) into `GHL_API_KEY`.
2. Set `GHL_LOCATION_ID` to this client's location (sub-account) ID in GHL.
3. Restart the server (or redeploy). Leave both blank to just not show this
   section at all -- nothing else on the dashboard depends on it.

This is a separate credential and API from Meta's, matching the pattern
already used in `ghl-renew-urban.plugin/server/ghl.js` elsewhere in this
repo. It only ever reads posts (`type: scheduled`) -- nothing here creates,
edits, or deletes anything in GHL.

## Auto-refresh

The page automatically re-fetches the currently-viewed date range every 5
minutes while the tab is visible (and immediately when you switch back to
it), so a client with the dashboard open sees new data without touching
anything. See `AUTO_REFRESH_MS` near the bottom of `public/app.js` to change
the interval.

## Deploying so clients can see it (Railway)

`localhost` only works on the machine it's running on. To share this with
clients, it needs to run on a real hosting service instead. This ships with
a `server/railway.json` for deploying to [Railway](https://railway.app),
which doesn't require a GitHub repo -- its CLI uploads your local folder
directly.

1. Create a free account at [railway.app](https://railway.app).
2. Install the Railway CLI and log in (this opens a browser tab to confirm):
   ```bash
   npm install -g @railway/cli
   railway login
   ```
3. From inside `webapp/server`, create a Railway project and deploy:
   ```bash
   cd webapp/server
   railway init
   railway up
   ```
4. Set your Meta token as a variable on Railway (never put it in code):
   ```bash
   railway variables --set "META_ACCESS_TOKEN=your-real-token-here"
   ```
   Re-run `railway up` after setting variables so the running server picks
   them up.
5. Run `railway domain` (or check the project in the Railway dashboard) to
   get the public URL -- that's the link to share with clients.

To use your own domain instead of the railway.app one, add a custom domain
in the Railway project's Settings tab and follow its DNS instructions (a
CNAME record pointing a subdomain like `dashboard.yourdomain.com` at
Railway).
