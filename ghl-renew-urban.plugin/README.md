# ghl-renew-urban Plugin

A Claude Code plugin for managing GoHighLevel CRM workflows related to urban renewal projects.

## Requirements

- Claude Code v2.1.128 or later
- Node.js 18+ (for the bundled MCP server)
- GoHighLevel account with a Private Integration API key

## Setup

Set these environment variables before starting Claude Code:

```bash
export GHL_API_KEY="your-ghl-private-integration-api-key"
export GHL_LOCATION_ID="your-sub-account-location-id"
```

You can find your API key under **Settings → Integrations → Private Integrations** in GoHighLevel. The Location ID is in **Settings → Business Profile**.

## Installation

```bash
claude plugin install https://github.com/bacdc843/playground/tree/main/ghl-renew-urban.plugin
```

Install dependencies for the bundled MCP server (one-time):

```bash
cd ~/.claude/plugins/ghl-renew-urban/server && npm install
```

Or install locally for development:

```bash
claude --plugin-dir ./ghl-renew-urban.plugin
cd ghl-renew-urban.plugin/server && npm install
```

## MCP Tools

The plugin starts a local MCP server (`ghl-api`) that exposes the GHL API directly to Claude:

### Contacts

| Tool | Description |
|------|-------------|
| `ghl_search_contacts` | Search contacts by name, email, or phone |
| `ghl_get_contact` | Get full contact details by ID |
| `ghl_update_contact` | Update contact tags, custom fields, or pipeline stage |
| `ghl_add_contact_note` | Add a note to a contact |

### Opportunities

| Tool | Description |
|------|-------------|
| `ghl_search_opportunities` | Search deals by name or contact |
| `ghl_get_opportunity` | Get full opportunity details by ID |
| `ghl_update_opportunity` | Update stage, value, close date, or status |
| `ghl_list_pipelines` | List all pipelines and their stages |

### Social Planner

| Tool | Description |
|------|-------------|
| `ghl_social_get_accounts` | List all connected social media accounts |
| `ghl_social_list_posts` | List posts filtered by status, date range, account, or type |
| `ghl_social_get_post` | Get full details for a single post by ID |
| `ghl_social_create_post` | Create and schedule (or draft) a post to one or more accounts |
| `ghl_social_update_post` | Edit an existing post (caption, schedule date, accounts, media) |
| `ghl_social_delete_post` | Delete a post by ID |
| `ghl_social_get_categories` | List all post categories |
| `ghl_social_get_tags` | List all post tags |

## Remote / Web Sessions (Claude Code on the Web)

For Claude Code web sessions the local stdio server isn't reachable. Deploy `http-server.js` to Railway (a `railway.json` is included) and add the hosted URL as an MCP server in your environment settings on code.claude.com:

```json
{
  "mcpServers": {
    "ghl-api": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-railway-url>/mcp"],
      "env": {
        "MCP_AUTH_TOKEN": "<your-mcp-auth-token>"
      }
    }
  }
}
```

Set `GHL_API_KEY`, `GHL_LOCATION_ID`, and `MCP_AUTH_TOKEN` as environment variables in your Railway service.

## Skills

Skills are invoked automatically by Claude based on context, or explicitly via their namespaced names.

| Skill | Invocation | Description |
|-------|-----------|-------------|
| Renew Contact | `/ghl-renew-urban:renew-contact` | Refresh a GHL contact for an urban project |
| Renew Opportunity | `/ghl-renew-urban:renew-opportunity` | Reactivate a stalled GHL opportunity |
| Sync Urban Data | `/ghl-renew-urban:sync-urban-data` | Sync urban project data into GHL CRM |

## Commands

| Command | Invocation | Description |
|---------|-----------|-------------|
| GHL Status | `/ghl-renew-urban:ghl-status` | Show urban renewal project status summary |

## Usage Examples

```
/ghl-renew-urban:renew-contact John Smith - Urban Renewal Phase 2
/ghl-renew-urban:renew-opportunity Downtown Loft Conversion
/ghl-renew-urban:sync-urban-data projects.csv
/ghl-renew-urban:ghl-status overdue
```
