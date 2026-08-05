# Dotloop MCP integration

Connects a Dotloop account to Claude — Claude Code, Claude Desktop, and Cowork —
via the [Dotloop Public API v2](https://dotloop.github.io/public-api/).

Claude can read transaction loops and their contract details, list and download
documents, manage participants and contacts, and create or update loops.

---

## Before you start

Dotloop API access has to be turned on for your account by Dotloop first. Once
it is, you create an **Application Client** yourself — that's what produces the
Client ID and Secret this server needs.

### Step 1 — Create the Application Client

1. Log into dotloop.com **as your dedicated API account** (not a personal account).
2. Go to **My Account → Clients** (this section only appears once API access is active).
3. Click **+ Add Client** and fill in every field, including a 100×100 logo.
4. Set **Redirect URL** to exactly:

   ```
   http://localhost:5858/callback
   ```

   It does not need to be a working website, but it must match what you put in
   `.env` character for character.

5. Under **Access Control**, enable **all five** scopes:
   Account, Loop, Template, Profile, Contact.

   > ⚠️ **Access Control can be set only once.** Per Dotloop's guide: *"If the
   > levels need to be changed, a new Application Client will need to be created."*
   > Enabling everything now costs nothing and avoids rebuilding later.

6. Save. Dotloop shows the **Client ID** and **Secret** one time only. Copy both.

### Step 2 — Get a refresh token

Dotloop refresh tokens never expire, so you do this once.

```bash
cd server
cp .env.example .env
# paste DOTLOOP_CLIENT_ID and DOTLOOP_CLIENT_SECRET into .env
npm install
npm run get-token
```

The script prints a URL. Open it, log into Dotloop, click **Approve**, and the
refresh token is printed in your terminal. Paste it into `.env` as
`DOTLOOP_REFRESH_TOKEN`.

This replaces the Postman/Insomnia walkthrough in Dotloop's Quick Start Guide —
same OAuth flow, no extra tooling. If you'd rather use Postman, the settings are
in that PDF and produce an identical token.

> 🔒 The refresh token does not expire and grants full access to your Dotloop
> data. Treat it like a password. `.env` is gitignored — keep it that way, and
> never paste the token into a chat window.

### Step 3 — Verify

```bash
npm run smoke
```

Read-only. Confirms the credentials work, then lists your profiles and five most
recent loops.

---

## Connecting Claude

### Claude Code

The plugin ships `.mcp.json`, which reads `server/.env` automatically. With the
plugin installed, run `/dotloop-status` to confirm the connection.

### Claude Desktop

The server reads `server/.env` itself, so credentials stay out of the Desktop
config. Add this to your Claude Desktop MCP config, using an absolute path:

```json
{
  "mcpServers": {
    "dotloop": {
      "command": "node",
      "args": ["/absolute/path/to/dotloop.plugin/server/index.js"]
    }
  }
}
```

On Windows, escape the backslashes:
`"C:\\Users\\you\\Playground\\dotloop.plugin\\server\\index.js"`

Restart Claude Desktop, then ask it to list your Dotloop profiles to confirm.

### Hosted, for a whole brokerage (Desktop, Cowork, web, mobile)

This is the mode to use when other agents need access. Deploy once; each agent
adds the connector, logs into Dotloop themselves, and sees only their own
loops. Nobody installs anything and no refresh tokens get passed around.

Claude's custom-connector UI has no field for a static bearer token, so the
hosted server implements OAuth 2.0 and brokers the real login to Dotloop:

```
Claude  --OAuth-->  this server  --OAuth-->  Dotloop
```

**Deploy** `http-server.js` (`railway.json` is included; Render and Fly work
the same way) with these environment variables:

| Variable | Purpose |
|---|---|
| `DOTLOOP_CLIENT_ID` | From Step 1 |
| `DOTLOOP_CLIENT_SECRET` | From Step 1 |
| `PUBLIC_URL` | The public https base URL, no trailing slash. **Setting this turns on OAuth mode.** |
| `STORE_PATH` | Optional. Where agent grants persist — point it at a mounted volume. |
| `MCP_AUTH_TOKEN` | Optional. Enables `GET /agents` to list who is connected. |

**Then add the callback to your Dotloop client.** In the Dotloop account that
owns the Application Client, add this to its Redirect URLs:

```
https://<your-host>/oauth/dotloop-callback
```

Dotloop matches redirect URLs exactly, so every agent login fails until this is
registered. The server prints the exact URL on startup.

**What each agent does** — no install, about two minutes:

1. In Claude Desktop or Cowork, go to **Settings > Connectors > Add custom connector**
2. Paste `https://<your-host>/mcp` — leave the OAuth client fields blank
3. Click connect, log into Dotloop, click Approve

`DOTLOOP_REFRESH_TOKEN` is not used in this mode. Each agent's token is
obtained through their own login and stored server-side; the admin listing at
`GET /agents` shows connected accounts by email and never returns tokens.

> Don't commit `.env` to deploy. Set variables through the host's own
> environment settings — real environment variables take precedence over the
> file, and `data/oauth.json` holds live agent credentials.

### Single-account mode

Setting `MCP_AUTH_TOKEN` and `DOTLOOP_REFRESH_TOKEN` while leaving `PUBLIC_URL`
unset serves one fixed Dotloop account to any caller presenting that bearer
token. Useful for testing and scripts. Claude's connector UI cannot supply a
static bearer token, so this is not the path for agents.

---

## Where downloaded documents go

`dotloop_download_document` writes PDFs to disk and returns the path. By
default that's the OS temp directory. Point it anywhere — including a synced
Dropbox or OneDrive folder — with `DOTLOOP_DOWNLOAD_DIR` in `server/.env`:

```bash
# Windows — forward slashes also work and avoid escaping entirely
DOTLOOP_DOWNLOAD_DIR=C:\Users\you\Dropbox\Dotloop Docs

# macOS
DOTLOOP_DOWNLOAD_DIR=/Users/you/Dropbox/Dotloop Docs
```

Nested folders are created automatically, and paths containing spaces are
fine. Quotes are optional; if present they're stripped.

**This applies to the local server only.** A hosted deployment writes to the
server's own disk, which is ephemeral and not your Dropbox. If you want
downloads landing in a synced folder, run the stdio server locally (Claude
Code or Claude Desktop) for that work.

---

## Tools

**Account & profiles** — `dotloop_get_account`, `dotloop_list_profiles`,
`dotloop_get_profile`

**Loops** — `dotloop_list_loops`, `dotloop_get_loop`, `dotloop_get_loop_detail`,
`dotloop_get_loop_full`, `dotloop_update_loop_detail`, `dotloop_create_loop`,
`dotloop_update_loop`

**Documents** — `dotloop_list_folders`, `dotloop_create_folder`,
`dotloop_list_documents`, `dotloop_download_document`, `dotloop_upload_document`

**Participants** — `dotloop_list_participants`, `dotloop_add_participant`,
`dotloop_update_participant`, `dotloop_remove_participant`

**Tasks & activity** — `dotloop_list_tasklists`, `dotloop_list_tasks`,
`dotloop_list_activities`

**Contacts** — `dotloop_list_contacts`, `dotloop_get_contact`,
`dotloop_create_contact`, `dotloop_update_contact`, `dotloop_delete_contact`

**Templates** — `dotloop_list_loop_templates`

`dotloop_get_loop_full` fetches detail, participants, folders, documents, and
task lists in one call — prefer it when reviewing a whole transaction.

---

## Notes and limits

**Rate limit.** 100 requests per minute per user. Sweeping many loops needs
batching; `dotloop_get_loop_full` exists partly to keep call counts down.

**Contract data vs. PDFs.** `dotloop_get_loop_detail` returns the contract's
structured fields — price, closing date, inspection deadline, earnest money,
commission. That answers most questions without opening a file. Download PDFs
only when you need language that isn't a form field.

**Document downloads need the `document:read` scope.** Dotloop grants it per
API client on their side; ask your Partner Success Manager to enable document
downloads. The request itself is per their spec — `GET .../document/:id` with
`Accept: application/pdf`, which returns `Content-Type: application/pdf` and a
`Content-Disposition` filename.

**After the grant, every connected user must reconnect.** A token issued
before the scope was enabled does not carry it, and refreshing that token will
not add it — the connector has to run a fresh Dotloop login. Remove and re-add
the connector, then approve again. Without this step downloads keep returning
403 even though the grant is in place.

The tool reports both cases with that distinction rather than a raw 403.

**Writes are real.** Update, create, and delete tools modify live transaction
records. `dotloop_remove_participant` and `dotloop_delete_contact` cannot be
undone.

**Field names are literal.** `dotloop_update_loop_detail` takes
`{ section: { field: value } }` using the exact names returned by
`dotloop_get_loop_detail`. A typo writes nothing rather than erroring.

---

## Multi-account support

Today the server acts as one Dotloop account, using a refresh token from the
environment. Token handling is isolated in `server/auth.js` behind a store
interface (`EnvTokenStore`) and the token manager already keys its cache by
account.

Supporting many agents or brokerages means replacing `EnvTokenStore` with a
database-backed store and adding the hosted OAuth callback so users can
authorize themselves — the API layer in `dotloop.js` doesn't change.

Note that redistributing this to other brokerages is a different arrangement
with Dotloop than using it for your own account. Their API request form scopes
approval to a vendor or service provider of an existing subscriber, so talk to
your Partner Success Manager before packaging it for outside customers.
