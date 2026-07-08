# ghl-chsmedia Plugin

A Claude Code plugin exposing GoHighLevel CRM and Social Planner tools for
**CHS Media Group's own GHL sub-account** — separate from `ghl-renew-urban.plugin`,
which is scoped to the Renew Urban client sub-account. Both can be connected
at once so you can manage the two sub-accounts side by side, since each
plugin's tools are namespaced to its own MCP server and each reads its own
credentials.

## Requirements

- Node.js 18+ (for the bundled MCP server)
- A GoHighLevel Private Integration API key **for the CHS Media Group
  sub-account specifically** — not the same key used by `ghl-renew-urban.plugin`

## Setup

In GHL, switch to the CHS Media Group sub-account, then go to
**Settings → Private Integrations → Create**, grant it read/write access to
Contacts, Opportunities, and Social Media Posting, and copy the token (starts
with `pit-`). The Location ID is in **Settings → Business Profile**.

### Using it from Claude Code (CLI)

```bash
export GHL_API_KEY="your-chs-media-private-integration-key"
export GHL_LOCATION_ID="your-chs-media-location-id"

claude --plugin-dir ./ghl-chsmedia.plugin
cd ghl-chsmedia.plugin/server && npm install
```

This starts a local `ghl-chsmedia-api` MCP server (`server/index.js`, stdio
transport) scoped only to the CHS Media Group sub-account. You can have both
this plugin and `ghl-renew-urban.plugin` loaded at once — their MCP server
names (`ghl-chsmedia-api` vs `ghl-api`) don't collide, and each reads its own
`.env` file from its own plugin directory.

### Using it from Cowork (or any remote/hosted client)

Cowork connects to MCP servers over HTTP, not via a local plugin directory,
so `server/http-server.js` needs to run somewhere reachable — the same
pattern as `ghl-renew-urban.plugin`'s hosted server
(`ghl-renew-urban-mcp.onrender.com`):

1. Deploy `server/` to Render or Railway as its own service (same steps you
   already used for the Renew Urban MCP server and the dashboard — new
   service, point it at this folder, `npm install && npm start`).
2. Set its environment variables: `GHL_API_KEY` and `GHL_LOCATION_ID` (the
   CHS Media Group ones from above), and a new `MCP_AUTH_TOKEN` — generate one
   with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   Use a different `MCP_AUTH_TOKEN` than the Renew Urban service; don't reuse it.
3. Once it's live (check `https://<your-service>.onrender.com/health` returns
   `{"status":"ok"}`), add it in claude.ai as a **custom connector**: Settings
   → Connectors → Add custom connector, with the MCP URL
   (`https://<your-service>.onrender.com/mcp`) and the `MCP_AUTH_TOKEN` as a
   Bearer token.
4. Enable it for whichever chats/Cowork spaces should see it. It will show up
   alongside your existing `ghl-mcp` connector as a separate tool set, so you
   can call tools against either sub-account in the same conversation.

## MCP Tools

The plugin starts a local MCP server (`ghl-chsmedia-api`) exposing:

| Tool | Description |
|------|-------------|
| `ghl_search_contacts` | Search contacts by name, email, or phone |
| `ghl_get_contact` | Get full contact details by ID |
| `ghl_update_contact` | Update contact tags, custom fields, or pipeline stage |
| `ghl_add_contact_note` | Add a note to a contact |
| `ghl_search_opportunities` | Search deals by name or contact |
| `ghl_get_opportunity` | Get full opportunity details by ID |
| `ghl_update_opportunity` | Update stage, value, close date, or status |
| `ghl_list_pipelines` | List all pipelines and their stages |
| `ghl_social_get_accounts` | List connected social accounts (Facebook, Instagram, etc.) |
| `ghl_social_list_posts` | List social posts filtered by status/date/account |
| `ghl_social_get_post` | Get full details for a single social post |
| `ghl_social_create_post` | Create/schedule a social post |
| `ghl_social_update_post` | Edit an existing social post |
| `ghl_social_delete_post` | Delete a social post |
| `ghl_social_get_categories` | List Social Planner categories |
| `ghl_social_get_tags` | List Social Planner tags |

All tool logic lives in `server/ghl.js`, shared between the stdio server
(`index.js`, for Claude Code CLI) and the HTTP server (`http-server.js`, for
Cowork/hosted use) — identical to how `ghl-renew-urban.plugin` is structured.
