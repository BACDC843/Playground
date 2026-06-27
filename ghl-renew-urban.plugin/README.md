# ghl-renew-urban Plugin

A Claude Code plugin for managing GoHighLevel CRM workflows related to urban renewal projects.

## Installation

```bash
claude plugin install https://github.com/bacdc843/playground/tree/main/ghl-renew-urban.plugin
```

Or install locally for development:

```bash
claude --plugin-dir ./ghl-renew-urban.plugin
```

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

## Requirements

- Claude Code v2.1.128 or later
- GoHighLevel account with API access configured
