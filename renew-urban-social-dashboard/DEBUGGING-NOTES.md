# Renew Urban Social Dashboard — Debugging Notes
**File:** `index.html` (single-file Cowork HTML artifact)
**Dashboard ID:** `renew-urban-social-dashboard`
**Meta Plugin:** `mcp__plugin_meta-social-insights_meta-social-insights__*`

> **2026-07-02:** Added `webapp/` — a standalone Node/Express + plain-JS
> version of this same dashboard that does not depend on the Cowork
> artifact sandbox at all (no `window.cowork`, no `mcpTools` registration,
> no CSP image workarounds). Built because the Cowork sandbox's
> `callMcpTool` flakiness documented below made the artifact version
> unreliable. See `webapp/README.md` for setup. Everything below this line
> describes the *original artifact* (`index.html`) and still applies to it.

---

## Architecture Overview

- Self-contained HTML artifact rendered inside a Cowork iframe sandbox
- Uses `window.cowork.callMcpTool(toolName, args)` to call Meta Graph API tools at runtime
- Returns `{ content, structuredContent, isError }` — NOT the raw tool response shape
- Static `LIVE_DATA` JSON is embedded in the HTML as seed data; `doRefresh()` overwrites it in memory
- Tools must be registered in the artifact metadata `mcp_tools` array or `callMcpTool` silently fails

---

## Problems Encountered & Status

### 1. `mcp_tools` registration wipes on every `update_artifact` call
**Status: Partially fixed — keep watching**

The Cowork `update_artifact` tool has an `mcp_tools` parameter. If omitted, it claims to keep the existing list — but in practice it was resetting to `[]` on updates. An empty `mcp_tools` array causes `callMcpTool` to return `{ isError: true, content: [{ type: 'text', text: 'Tool call failed: 400 ' }] }` for every call.

**Fix:** Always pass `mcp_tools` explicitly on every `update_artifact` call:
```json
[
  "mcp__plugin_meta-social-insights_meta-social-insights__get_ig_posts",
  "mcp__plugin_meta-social-insights_meta-social-insights__get_ig_account_insights",
  "mcp__plugin_meta-social-insights_meta-social-insights__get_fb_posts",
  "mcp__plugin_meta-social-insights_meta-social-insights__get_fb_page_insights",
  "mcp__plugin_meta-social-insights_meta-social-insights__get_post_image"
]
```

---

### 2. `include_images: true` causes `callMcpTool` to hang forever
**Status: Fixed in latest build**

Calling `get_ig_posts` with `include_images: true` returns ~800KB of base64 image data. When called from inside the artifact via `callMcpTool`, the sandbox hangs indefinitely — the promise never resolves or rejects. `Promise.allSettled` waits forever. The spinner shows "Fetching..." but LIVE_DATA never updates and no error is shown.

**Symptoms:**
- Refresh button appears to do nothing
- Spinner shows briefly then page reverts to embedded data
- No "Refresh failed" message appears
- Live bar still shows the old embedded data period/date

**Fix:** Remove `include_images: true` from the `doRefresh()` calls. Posts still return `thumbnail_url` and `media_url` from Meta which work for the current session. Also added a 20-second timeout wrapper on all four `callMcpTool` calls:
```javascript
function withTimeout(p, ms) {
  return Promise.race([p, new Promise(function(_, rej) {
    setTimeout(function() { rej(new Error('timeout')); }, ms);
  })]);
}
```

**Note:** Calling `get_ig_posts` with `include_images: true` works fine when called directly from Claude — the hang only happens inside the artifact's `callMcpTool` sandbox. Likely a response size limit in the Cowork iframe.

---

### 3. Meta API returns 400 for future `until` dates
**Status: Fixed**

When the user selects a full month range (e.g., July 1–31) and today is July 2, passing `until: '2026-07-31'` to some Meta endpoints returns a 400 error.

**Fix:** Cap `until` at today before making API calls:
```javascript
var todayStr = new Date().toISOString().split('T')[0];
var apiUntil = until > todayStr ? todayStr : until;
```
Use `apiUntil` for all four API calls but keep `until` (the full month end) for `LIVE_DATA.period` labeling.

---

### 4. Calendar month navigation buttons not working
**Status: Fixed**

Nav buttons used inline onclick with escaped quotes inside JS string literals inside HTML attributes — a triple-nesting quoting nightmare:
```javascript
// BROKEN — quote escaping breaks in some browsers
var prevBtn = '<button onclick="window._calMonthIdx--;var c=document.getElementById(\'cal-container\');...">'
```

**Fix:** Extract to a named global function:
```javascript
function calNav(dir) {
  window._calMonthIdx = (window._calMonthIdx || 0) + dir;
  var c = document.getElementById('cal-container');
  if (c) c.innerHTML = renderPostCalendar();
}
// Buttons become:
'<button onclick="calNav(-1)">&#8249;</button>'
'<button onclick="calNav(1)">&#8250;</button>'
```

---

### 5. Hardcoded period text ("June 2026 · July 1, 2026") in live bar
**Status: Fixed**

Three separate places in the tab render functions had hardcoded period strings instead of calling `renderLiveBar()`:
- `renderOV()` — `const statusBar = usingLive ? '...' : '...'` with hardcoded text
- `renderIG()` — same pattern
- `renderFB()` — same pattern

**Fix:** All three replaced with `${renderLiveBar()}` using the dynamic function.

---

### 6. AI Insights tab — multiple failures
**Status: Fixed**

Several layered issues:
- **Spinner stuck forever:** Data prep functions (`igM()`, etc.) were outside try/catch; any error silently left spinner running. Fixed by wrapping everything in try/catch and adding a 15-second timeout via `Promise.race`.
- **`[object Object]` rendering:** Cached broken result in localStorage from a prior buggy run. Fixed by bumping cache key to `ru_insights_v3_` and validating cache with `.includes('<')` (checks for HTML content).
- **Markdown code fences in output:** `askClaude` returns content wrapped in ` ```html ``` `. Fixed with regex strip:
  ```javascript
  raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '')
  ```
- **Rule-based fallback:** `buildRuleInsights()` computes 5 insights from live data when `askClaude` fails or times out. Avoids apostrophes to prevent JS string issues.

---

### 7. July date range showing 0 posts (pre-refresh)
**Status: Fixed / Working as designed**

The dashboard embeds June 2026 data as seed. When the user navigates to July (using the month header arrows), `loadData()` filters the embedded June posts by the July date range — finds nothing — shows the "No data for this period" banner. This is correct behavior. The user must click Refresh to pull July data.

The banner logic:
```javascript
const hasAnyData = (LIVE_DATA.igPosts||[]).length > 0 || (LIVE_DATA.fbPosts||[]).length > 0;
const noPostsInRange = s.igPosts.length === 0 && s.fbPosts.length === 0;
banner.style.display = (hasAnyData && noPostsInRange) ? 'block' : 'none';
```

---

### 8. `doRefresh()` silently restoring old data on hidden errors
**Status: Improved**

The try/catch in `doRefresh()` restores saved data on any thrown error. But errors were only logged to `console.error`, not shown to the user. If the refresh fails silently (e.g., a JS error after the API call succeeds), the spinner disappears and the old data stays — no visible indication of failure.

**Fix:** Show error message in `ldg` element for 10 seconds with `err.message`.

---

## Key Technical Facts

| Item | Value |
|------|-------|
| FB Page ID | `227517480778696` |
| IG Business Account ID | `17841404028087828` |
| Access token location | Plugin config (`meta-plugin-config.json`) — NOT in HTML |
| Token type | Page Access Token (from 60-day long-lived User Access Token) |
| Token expiry | ~60 days from generation. Refresh via Graph API Explorer |
| `callMcpTool` response shape | `{ content: [{type, text}], structuredContent: {...}, isError: bool }` |
| Max safe response size via `callMcpTool` | Unknown, but 800KB causes a hang. Keep under ~50KB. |

---

## `extractPosts()` — Response Shape Handler

The artifact must handle multiple possible response shapes from `callMcpTool`:

```javascript
function extractPosts(raw) {
  if (!raw) return null;
  if (raw.isError) return null;
  var sc = raw.structuredContent;
  if (sc) {
    if (Array.isArray(sc)) return sc;
    if (sc.data && Array.isArray(sc.data)) return sc.data;
  }
  try {
    var txt = Array.isArray(raw.content) ? raw.content[0] && raw.content[0].text : raw.content;
    if (!txt) return null;
    var parsed = JSON.parse(txt);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.data)) return parsed.data;
  } catch(e) {}
  return null;
}
```

---

## What's Still Broken / Unverified

1. **Refresh producing live July data** — The `include_images` hang fix was the last change. Not yet confirmed working by user. (See "2026-07-02 rebuild" below — verified in a simulated harness; still needs a real Cowork session confirmation.)
2. **Calendar thumbnails** — Without `include_images: true`, thumbnails come from CDN URLs (`thumbnail_url`, `media_url`) which expire after ~1 hour. Calendar images may go blank after session expires.
3. **AI Insights with live July data** — Was working with June embedded data; untested with refreshed data.

---

## 2026-07-02 rebuild — security fix + correctness fixes

The uploaded `index.html` had drifted from this file's description in a few important ways. Found by reading the actual source (not just these notes) and by running the artifact's inline script through a headless DOM (jsdom) to exercise `doRefresh()` with a mocked `callMcpTool`.

### 9. **Live Facebook access token hardcoded in the HTML — removed**
**Status: Fixed (security)**

The file contained a `const META = { token: 'EAAT5UpLGo7g...' , igId, fbId, v }` block plus an unused `gfetch()` helper that called `fetch()` directly against `graph.facebook.com` with that token. This directly violates the constraint in `CLAUDE.md` ("Do not store or log the FB access token — it lives only in the plugin config, not in the HTML") and would leak a live, working Page Access Token to anyone who can view the artifact's source (and to anyone with access to this repo).

It was also **completely dead code** — `doRefresh()` only ever calls `window.cowork.callMcpTool(...)`, never `gfetch()`. It served no function and was pure liability.

**Fix:** Deleted `META`, `gfetch()`, and the unused `IGF`/`IGM`/`FBF`/`FBM` field-list constants entirely. If this token is real and was ever shared outside a trusted context, **rotate it** in the Graph API Explorer — treat it as compromised.

### 10. **Dead duplicate seed data (`SEED`) and dead tool-name object (`T`)**
**Status: Fixed (cleanup)**

- `const SEED = {...}` (June data) was defined but never referenced anywhere — `LIVE_DATA` (also June data, with `thumbnail_b64` images baked in) is what the app actually reads. Removed the unused `SEED` block.
- A top-level `const T = { igP, igI, fbP, fbI, img }` object was defined but never read — `doRefresh()` builds tool-name strings itself via string concatenation with a locally-scoped `var T` (a string prefix), which shadows the outer object within that function. Removed the dead outer object.

### 11. **Insights silently showed the wrong period's numbers on partial refresh failure**
**Status: Fixed**

`doRefresh()` fetches 4 things in parallel: IG posts, FB posts, IG insights, FB insights. If IG/FB **posts** fail, the old code fell back to the previously-saved posts — harmless, because `loadData()` re-filters posts by the active date range, so stale-period posts get filtered back out automatically.

But `igIns`/`fbIns` are **not** date-filtered before display. The old code did:
```javascript
LIVE_DATA.igIns = extractInsights(r2) || savedIGIns || null;
LIVE_DATA.fbIns = extractInsights(r3) || savedFBIns || null;
```
So if, say, the FB insights call timed out while everything else (including `LIVE_DATA.period`) advanced to July, the dashboard would keep showing **June's** FB engagement numbers under a "July" label with no indication anything had failed. For a real client-facing report, that's a materially misleading number, not just a cosmetic bug.

**Fix:** Fail closed instead of masking with stale data:
```javascript
LIVE_DATA.igIns = extractInsights(r2);
LIVE_DATA.fbIns = extractInsights(r3);
```
(`igM()`/`fbM()` already handle `null` insights gracefully via `?.` and default to 0.) Also added a visible partial-failure notice — after a refresh that partially fails, the loading bar reports exactly which of the four calls failed (e.g. `Refreshed with partial data -- failed: FB insights`) for 8 seconds instead of just going quiet.

### 12. **Missing `.g3` CSS class**
**Status: Fixed**

The Insights tab's "Content Type ROI" cards use `<div class="kg g3">`, but only `.g5` and `.g4` grid variants existed in CSS. Without an explicit `grid-template-columns`, the cards stacked in a single column instead of a 3-up row. Added `.g3{grid-template-columns:repeat(3,1fr)}` (plus its 2-column mobile breakpoint, matching `.g4`).

### 13. **Verification method**
Ran the artifact's inline script inside jsdom (Node) with a stubbed `window.cowork.callMcpTool`, since this environment cannot open the actual Cowork iframe. Confirmed:
- Initial load renders all three tabs with the June seed data and no thrown errors.
- A full-success `doRefresh()` for July updates `LIVE_DATA`/`s`/`periodLabel` correctly.
- A partial-failure `doRefresh()` (posts succeed, insights fail) now reports the failure and leaves `igIns`/`fbIns` as `null` instead of silently reusing June's numbers.

This does **not** replace testing inside the real Cowork artifact sandbox — jsdom's `callMcpTool` is a hand-written mock, and the real MCP bridge's exact response shapes / timing / iframe restrictions can't be fully replicated outside Cowork. Item 1 above ("Refresh producing live July data") should still be confirmed by the user in a live session.
