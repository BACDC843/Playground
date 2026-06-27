---
description: Sync urban project data into GoHighLevel. Use when importing urban renewal project records, updating bulk contact/opportunity data, or aligning GHL CRM with external urban project databases.
---

# Sync Urban Project Data to GHL

Synchronize urban project data with GoHighLevel CRM records.

Process:
1. Accept project data from `$ARGUMENTS` (project name, CSV path, JSON payload, or description)
2. Map urban project fields to GHL CRM fields:
   - Project name → Opportunity name
   - Project address → Contact address / custom field
   - Project stage → Pipeline stage
   - Project owner → Assigned user
   - Renewal date → Close date / custom date field
3. Identify existing records to update vs. new records to create
4. Generate a sync plan listing:
   - Records to create
   - Records to update (with field-level diff)
   - Records to skip (already current)
5. Execute or present the plan for confirmation

Always deduplicate by contact email or project ID before syncing.
