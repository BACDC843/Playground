# Claude Code Instructions — Renew Urban Social Dashboard

## What This Is

A single-file HTML dashboard (`index.html`) that displays live Facebook and Instagram analytics for Renew Urban Charleston. It runs inside a **Cowork artifact sandbox** — a sandboxed iframe inside the Claude desktop app. It is NOT a normal webpage.

## The Core Problem You Need to Solve

The **Refresh button does not successfully pull live data**. The dashboard loads with embedded June 2026 seed data. When the user navigates to July and clicks Refresh, the data never updates. The spinner either hangs forever or disappears and the old data remains.

Read `DEBUGGING-NOTES.md` before touching anything. It documents every issue found and attempted fixes in detail.

## How the Sandbox Works (Critical — Read This First)

The artifact runs in a Cowork iframe. Inside this sandbox:

- **`window.cowork.callMcpTool(toolName, args)`** is the ONLY way to call external APIs. No `fetch()`, no `XMLHttpRequest`, nothing else works.
- `callMcpTool` returns `{ content: [{type, text}], structuredContent: {...}, isError: bool }` — NOT the raw API response.
- Tools must be registered in the `<script type="application/json" id="cowork-artifact-meta">` block at the top of the HTML under `mcpTools`. If that list is wrong or empty, every `callMcpTool` call returns a 400 error.
- **Response size matters.** Large responses (tested: ~800KB) cause `callMcpTool` to hang indefinitely — the promise never resolves or rejects. This was the root cause of the broken Refresh.
- You **cannot run the artifact directly** from Claude Code. You can only edit `index.html`. The user tests it in Cowork by opening the artifact and clicking Refresh.

## The Five Tools Available Inside the Artifact

```json
[
  "mcp__plugin_meta-social-insights_meta-social-insights__get_ig_posts",
  "mcp__plugin_meta-social-insights_meta-social-insights__get_ig_account_insights",
  "mcp__plugin_meta-social-insights_meta-social-insights__get_fb_posts",
  "mcp__plugin_meta-social-insights_meta-social-insights__get_fb_page_insights",
  "mcp__plugin_meta-social-insights_meta-social-insights__get_post_image"
]
```

These are registered in the `mcpTools` array in the artifact meta block at the top of `index.html`. Do not remove or rename them.

## Tool Response Shapes

**`get_ig_posts` / `get_fb_posts`:** Returns `{ data: [...posts], paging: {...} }`
- IG post fields: `id`, `caption`, `media_type`, `media_url`, `thumbnail_url`, `permalink`, `timestamp`, `like_count`, `comments_count`
- FB post fields: `id`, `message`, `created_time`, `full_picture`, `permalink_url`, `likes.summary.total_count`, `comments.summary.total_count`
- **Do NOT use `include_images: true`** — it returns ~800KB and hangs `callMcpTool`

**`get_ig_account_insights` / `get_fb_page_insights`:** Returns page-level metrics array

## What `doRefresh()` Should Do

1. Get date range from `customRange || getRange()` — this respects the user's current month/week/custom selection
2. Cap `until` at today's date (Meta API rejects future dates with 400)
3. Call all four tools with `Promise.allSettled` + a timeout wrapper (20s) on each call
4. Extract post arrays from the response using `extractPosts()` (handles multiple response shapes — see `DEBUGGING-NOTES.md`)
5. Update `LIVE_DATA.igPosts`, `LIVE_DATA.fbPosts`, `LIVE_DATA.igIns`, `LIVE_DATA.fbIns`, `LIVE_DATA.period`, `LIVE_DATA.refreshedAt`, `LIVE_DATA.since`, `LIVE_DATA.until`
6. Set `customRange = { since, until }` so filters stay on the refreshed period
7. Call `loadData()` to re-filter and re-render

## Key Global Variables

```javascript
LIVE_DATA       // The in-memory data store. Starts as embedded JSON, overwritten by doRefresh()
customRange     // { since, until } when user sets a custom date range. null otherwise.
navDate         // Date object — the month/week currently shown in the header
view            // 'month' | 'week' | 'custom'
s               // Filtered data: { igPosts, fbPosts, igIns, fbIns }
usingLive       // Boolean — true when showing live/refreshed data vs cached
```

## What "Works" vs "Broken"

| Feature | Status |
|---------|--------|
| Page loads with June embedded data | ✅ Working |
| Month navigation (header ‹/›) | ✅ Working |
| Tab switching (Overview / IG / FB / AI Insights) | ✅ Working |
| Calendar month nav buttons (‹/› on calendar widget) | ✅ Fixed (calNav function) |
| AI Insights tab | ✅ Fixed |
| Live bar showing correct period | ✅ Fixed |
| Print button | ✅ Working |
| **Refresh pulling live data** | ⚠️ Logic verified in a simulated harness (see `DEBUGGING-NOTES.md` #13); not yet confirmed in a real Cowork session |
| Calendar thumbnails after refresh | ⚠️ Uses CDN URLs that expire ~1hr |
| Insights showing correct period on partial refresh failure | ✅ Fixed — was silently showing stale-period numbers (`DEBUGGING-NOTES.md` #11) |
| No hardcoded FB access token in the HTML | ✅ Fixed — a live token + unused direct Graph API code was removed (`DEBUGGING-NOTES.md` #9) |

## Most Likely Remaining Issue

The last attempted fix removed `include_images: true` and added a 20s timeout. This has not been confirmed working by the user. If Refresh still fails, the next things to check:

1. **Is `callMcpTool` returning data at all?** Add `alert()` or write the raw `r0`/`r1` values to a visible DOM element so the user can see exactly what comes back. Don't rely on the `ldg` spinner element — it auto-hides.

2. **Is `extractPosts()` parsing the response correctly?** The `structuredContent` field from `callMcpTool` may be shaped differently than expected. Log `typeof r0.structuredContent` and `JSON.stringify(r0).substring(0, 200)` to see what's actually there.

3. **Is `loadData()` filtering posts into the right range?** After LIVE_DATA updates, `s.igPosts` and `s.fbPosts` are filtered by `customRange || getRange()`. If `customRange` or `navDate` don't match the fetched period, posts get filtered out even though they exist in LIVE_DATA.

4. **Is `renderAll()` being called?** Check that `loadData()` calls `renderAll()` after updating `s`.

## Suggested Debugging Approach

Add a temporary debug panel to the HTML that shows raw state after a refresh attempt:

```javascript
// After doRefresh() completes (success or failure):
document.getElementById('debug-panel').innerHTML =
  'IG posts: ' + (LIVE_DATA.igPosts||[]).length +
  ' | FB posts: ' + (LIVE_DATA.fbPosts||[]).length +
  ' | Period: ' + LIVE_DATA.period +
  ' | customRange: ' + JSON.stringify(customRange) +
  ' | r0 shape: ' + JSON.stringify(r0).substring(0, 100);
```

Add `<div id="debug-panel" style="position:fixed;bottom:0;left:0;right:0;background:yellow;padding:8px;font-size:11px;z-index:9999;"></div>` to the HTML body.

## File Structure

```
renew-urban-social-dashboard/
  index.html            ← The entire dashboard (single file, ~2.8MB)
  DEBUGGING-NOTES.md    ← Every bug found + root cause + fix status
  CLAUDE.md             ← This file
```

## Constraints

- `index.html` must remain a single self-contained file
- Do not add external script/CSS dependencies not already in the file
- The `mcpTools` array in the artifact meta block must always include all five tool names listed above
- Do not store or log the FB access token — it lives only in the plugin config, not in the HTML
- The dashboard is for a real client (Renew Urban Charleston). Keep any test/debug code clearly labeled and easy to remove.
