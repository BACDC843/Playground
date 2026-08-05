---
description: Check the Dotloop connection and list profiles and recent loops
---

Verify the Dotloop integration is working:

1. Call `dotloop_get_account` and report the account name and email.
2. Call `dotloop_list_profiles` and list each profile's ID, name, and type.
3. For the first profile, call `dotloop_list_loops` with `batch_size: 5` and
   `sort: "updated:desc"`, and list each loop's ID, name, and status.

If any call fails, report the error verbatim and say which of these is the
likely cause:

- **401 / token refresh failed** — `DOTLOOP_REFRESH_TOKEN` is wrong or revoked,
  or the client secret was reset. Re-run `npm run get-token` in `server/`.
- **403** — the Application Client is missing an Access Control scope. Access
  Control can only be set once per client, so this needs a **new** client.
- **429** — rate limited at 100 requests/minute. Wait and retry with smaller batches.
- **Missing env vars** — `server/.env` isn't filled in yet.

Do not write or modify anything.
