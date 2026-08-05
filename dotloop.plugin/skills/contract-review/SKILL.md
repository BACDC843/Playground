---
name: contract-review
description: Review a Dotloop transaction and report its contract terms, deadlines, missing participants, and paperwork gaps. Use when Barry asks to check a deal, review a contract, find upcoming deadlines, audit a loop for missing documents, or summarize where a transaction stands. Triggers on "review this loop", "what's due this week", "check the contract on [address]", "is anything missing on [deal]".
---

# Dotloop contract review

Pulls a transaction out of Dotloop and reports what matters: the terms, what's
due, who's missing, and what paperwork isn't there yet.

## Finding the loop

Loops live under a profile, so start there.

1. `dotloop_list_profiles` — cache the profile ID; it rarely changes.
2. `dotloop_list_loops` with `profile_id` and a `filter`/`sort` that matches the ask:
   - upcoming closings → `sort: "closing_date:asc"`, `filter: "transaction_status=UNDER_CONTRACT"`
   - recently touched → `sort: "updated:desc"`
   - by address → list and match on `name`; there is no server-side text search

Never page through every loop to find one deal. Filter first.

## Reviewing it

Use `dotloop_get_loop_full` — one call returns detail, participants, folders,
documents, and task lists. Prefer it over five separate calls; the API allows
100 requests per minute per user and a multi-loop sweep burns that fast.

## What to report

Lead with anything time-sensitive. Structure:

**Terms** — address, purchase price, transaction type, status, closing date.

**Deadlines** — pull every date field from the detail sections (Contract Dates,
Offer Dates, Listing Information) plus incomplete task due dates. Flag anything
inside 7 days, and anything already past with the task still open.

**People** — list participants by role. Call out a transaction missing a role it
should have: an under-contract purchase with no lender, no title/escrow rep, or
no cooperating agent is worth flagging.

**Paperwork** — list documents per folder. Note empty folders and folders whose
name implies a document that isn't there.

**Gaps** — blank fields that should be filled at this stage. An under-contract
loop with no closing date or no purchase price is the kind of thing worth
surfacing rather than silently skipping.

## Reading the actual PDFs

`dotloop_get_loop_detail` already returns the contract's structured data —
price, dates, commission, earnest money. That answers most questions without
opening a file, and it is faster and more reliable than parsing a PDF.

Only download when the question needs language that isn't a form field —
contingency wording, addendum terms, special stipulations. Then:

1. `dotloop_list_documents` for the folder
2. `dotloop_download_document` (leave `as` unset — it saves to disk and returns a path)
3. Read the file at that path

## Writing back

Write tools exist (`dotloop_update_loop_detail`, `dotloop_add_participant`,
`dotloop_upload_document`, `dotloop_remove_participant`). These change live
transaction records.

Confirm with Barry before any write, and quote the exact change first —
which loop, which field, old value to new value. Field and section names in
`dotloop_update_loop_detail` must match what `dotloop_get_loop_detail` returned,
character for character, or the write silently targets nothing.

`dotloop_remove_participant` and `dotloop_delete_contact` cannot be undone.

## Not legal advice

Report what the documents and fields say. Flag dates, gaps, and inconsistencies.
Don't interpret contract language as legal advice or tell Barry what a clause
obligates anyone to do — surface it and let him make the call.
