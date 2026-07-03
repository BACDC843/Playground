import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  META_ACCESS_TOKEN,
  META_IG_ID,
  META_FB_PAGE_ID,
  META_API_VERSION = 'v21.0',
  META_GRAPH_BASE_URL = 'https://graph.facebook.com',
  PORT = 3000,
} = process.env;

const IG_POST_FIELDS = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count';
const FB_POST_FIELDS = 'id,message,full_picture,permalink_url,created_time,likes.summary(true),comments.summary(true),shares';
// Meta's IG insights metrics each carry their own, frequently-changing rules
// (some need metric_type=total_value, follower_count only covers a trailing
// 30-day window that excludes today, etc). Rather than chase each one,
// every metric is fetched independently below -- one metric being
// unavailable for a given date range no longer takes the other four down
// with it.
const IG_METRICS = [
  { name: 'reach' },
  { name: 'follower_count' },
  { name: 'profile_views', metric_type: 'total_value' },
  { name: 'website_clicks', metric_type: 'total_value' },
  { name: 'accounts_engaged', metric_type: 'total_value' },
];
const FB_METRICS = [
  { name: 'page_post_engagements' },
  { name: 'page_views_total' },
];

const TIMEOUT_MS = 15000;

async function graphFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    const body = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = body?.error?.message || `Graph API ${resp.status}`;
      throw new Error(msg);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function graphGet(path, params) {
  const url = new URL(`${META_GRAPH_BASE_URL}/${META_API_VERSION}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', META_ACCESS_TOKEN || '');
  return graphFetch(url);
}

function cappedUntil(until) {
  const today = new Date().toISOString().split('T')[0];
  return until > today ? today : until;
}

// Safety cap on how many pages of 50 to follow when looking for an older
// date range -- 20 pages (up to ~1000 posts) is far more than a small
// business account posts in any realistic lookback window.
const MAX_POST_PAGES = 20;

// The posts edges return at most 50 items per page with no filtering
// guarantee we can fully rely on, so a `since` further back than the most
// recent 50 posts would otherwise silently disappear. This follows Meta's
// own pagination (`paging.next`) until it has actually seen a post older
// than `since`, rather than trusting the since param alone to do the
// filtering. `since` is still sent as a hint (Meta may use it to
// pre-filter and shrink the number of pages needed) but if that edge
// rejects it outright, it retries the first page without it.
//
// `until` is deliberately never sent here. Meta's `until` cutoff excludes
// the exact day passed in (it's a start-of-day boundary, not end-of-day),
// so capping it at "today" was silently telling Meta "before today" and
// dropping every post published today. Since the frontend already
// re-filters the returned posts to the exact requested window (including
// the full end day), the server doesn't need Meta's `until` filtering to
// be correct at all -- it only needs to know where to stop paging backward,
// which `since` and the per-page date check below already handle.
async function fetchPostsInRange(edge, fields, since, dateField) {
  const sinceMs = new Date(`${since}T00:00:00`).getTime();
  const all = [];
  let next = null;
  let paramsWithoutSince = null; // set only if `since` gets rejected
  for (let page = 0; page < MAX_POST_PAGES; page++) {
    let body;
    if (next) {
      body = await graphFetch(next);
    } else if (paramsWithoutSince) {
      body = await graphGet(edge, paramsWithoutSince);
    } else {
      try {
        body = await graphGet(edge, { fields, since, limit: 50 });
      } catch (err) {
        console.warn(`${edge}: since rejected (${err.message}) -- paginating without it instead`);
        paramsWithoutSince = { fields, limit: 50 };
        body = await graphGet(edge, paramsWithoutSince);
      }
    }
    const items = body?.data ?? [];
    all.push(...items);
    const oldest = items[items.length - 1];
    if (oldest && new Date(oldest[dateField]).getTime() < sinceMs) break; // paged past the requested start
    next = body?.paging?.next;
    if (!next) break;
  }
  return all;
}

async function getIGPosts(since, until) {
  return fetchPostsInRange(`${META_IG_ID}/media`, IG_POST_FIELDS, since, 'timestamp');
}

async function getFBPosts(since, until) {
  return fetchPostsInRange(`${META_FB_PAGE_ID}/posts`, FB_POST_FIELDS, since, 'created_time');
}

// Meta's insights endpoint rejects any since/until span over 30 days, so a
// 31-day calendar month (or a wider custom range) has to be broken into
// <=30-day windows and stitched back together.
const MAX_INSIGHTS_SPAN_DAYS = 30;

function isoDate(d) { return d.toISOString().split('T')[0]; }

function chunkDateRange(since, until, maxDays) {
  const chunks = [];
  let start = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  while (start <= end) {
    const chunkEnd = new Date(start);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({ since: isoDate(start), until: isoDate(chunkEnd) });
    start = new Date(chunkEnd);
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return chunks;
}

// Fetches one metric across as many <=30-day chunks as the range needs, and
// merges them back into a single series (concatenating daily values, or
// summing total_value counts). A chunk failing on its own (e.g.
// follower_count's extra "trailing 30 days only" rule rejecting an older
// chunk) just drops that chunk instead of losing the whole metric.
async function fetchMetricChunked(id, metric, since, until) {
  const chunks = chunkDateRange(since, until, MAX_INSIGHTS_SPAN_DAYS);
  const results = await Promise.allSettled(chunks.map((c) =>
    graphGet(`${id}/insights`, {
      metric: metric.name,
      period: 'day',
      ...(metric.metric_type ? { metric_type: metric.metric_type } : {}),
      since: c.since,
      until: c.until,
    })
  ));
  let merged = null;
  const failures = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      failures.push(`${chunks[i].since}..${chunks[i].until}: ${r.reason?.message || r.reason}`);
      return;
    }
    const item = r.value?.data?.[0];
    if (!item) return;
    if (!merged) merged = { name: item.name, period: item.period };
    if (item.values) merged.values = (merged.values || []).concat(item.values);
    if (item.total_value) merged.total_value = { value: (merged.total_value?.value || 0) + (item.total_value.value || 0) };
  });
  if (failures.length) console.warn(`[${metric.name}] some date ranges unavailable -- ${failures.join(' | ')}`);
  if (!merged) throw new Error(failures[0] || 'no data returned');
  return merged;
}

// Fetches each metric independently so one metric's rules (date-range
// limits, required params) can't take the others down with it. Only throws
// if every single metric failed -- a partial result is treated as success,
// with the failures logged for visibility.
async function getInsightsPerMetric(id, metrics, since, until) {
  const results = await Promise.allSettled(metrics.map((m) => fetchMetricChunked(id, m, since, until)));
  const data = [];
  const failures = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') data.push(r.value);
    else failures.push(`${metrics[i].name}: ${r.reason?.message || r.reason}`);
  });
  if (failures.length) console.warn(`[${since}..${until}] some metrics on ${id} unavailable -- ${failures.join(' | ')}`);
  if (data.length === 0 && failures.length > 0) throw new Error(failures.join(' | '));
  return { data };
}

async function getIGInsights(since, until) {
  return getInsightsPerMetric(META_IG_ID, IG_METRICS, since, cappedUntil(until));
}

async function getFBInsights(since, until) {
  return getInsightsPerMetric(META_FB_PAGE_ID, FB_METRICS, since, cappedUntil(until));
}

// Fetches all four Meta endpoints for one date range in parallel. Failures
// in one endpoint don't take down the others -- each field is either the
// fetched value or null, with the reason recorded in `errors`.
async function fetchBundle(since, until) {
  const [igPosts, fbPosts, igIns, fbIns] = await Promise.allSettled([
    getIGPosts(since, until),
    getFBPosts(since, until),
    getIGInsights(since, until),
    getFBInsights(since, until),
  ]);
  const pick = (r) => (r.status === 'fulfilled' ? r.value : null);
  const err = (r) => (r.status === 'rejected' ? String(r.reason?.message || r.reason) : null);
  const errors = {
    igPosts: err(igPosts),
    fbPosts: err(fbPosts),
    igIns: err(igIns),
    fbIns: err(fbIns),
  };
  for (const [field, message] of Object.entries(errors)) {
    if (message) console.error(`[${since}..${until}] ${field} failed: ${message}`);
  }
  return {
    since,
    until,
    igPosts: pick(igPosts),
    fbPosts: pick(fbPosts),
    igIns: pick(igIns),
    fbIns: pick(fbIns),
    errors,
  };
}

const app = express();

app.get('/api/health', (req, res) => {
  res.json({ ok: true, tokenConfigured: Boolean(META_ACCESS_TOKEN) });
});

app.get('/api/dashboard', async (req, res) => {
  const { since, until, compareSince, compareUntil } = req.query;
  if (!since || !until) {
    res.status(400).json({ error: 'since and until (YYYY-MM-DD) are required query params' });
    return;
  }
  if (!META_ACCESS_TOKEN) {
    res.status(503).json({ error: 'META_ACCESS_TOKEN is not configured on the server (see server/.env.example)' });
    return;
  }
  try {
    const current = await fetchBundle(since, until);
    let previous = null;
    if (compareSince && compareUntil) {
      previous = await fetchBundle(compareSince, compareUntil);
    }
    res.json({ current, previous });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`Renew Urban dashboard server listening on http://localhost:${PORT}`);
  if (!META_ACCESS_TOKEN) {
    console.warn('WARNING: META_ACCESS_TOKEN is not set -- copy .env.example to .env and fill it in.');
  }
});
