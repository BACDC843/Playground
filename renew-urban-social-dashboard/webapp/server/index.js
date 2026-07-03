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
  GHL_API_KEY,
  GHL_LOCATION_ID,
  GHL_API_BASE = 'https://services.leadconnectorhq.com',
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
// page_impressions_unique/page_fan_adds added to give FB the same
// reach/follower-growth story IG already has (Facebook's API supports both;
// they just weren't being requested). Each metric is independent per the
// comment above, so if either of these isn't available for a given Page,
// it drops out gracefully rather than breaking the rest.
const FB_METRICS = [
  { name: 'page_post_engagements' },
  { name: 'page_views_total' },
  { name: 'page_impressions_unique', metric_type: 'total_value' },
  { name: 'page_fan_adds', metric_type: 'total_value' },
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

// One calendar month, `monthsAgo` months back from the current one (0 = this month).
function monthRange(monthsAgo) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
  const y = d.getFullYear(), m = d.getMonth();
  const lastDay = new Date(y, m + 1, 0).getDate();
  return {
    since: `${y}-${String(m + 1).padStart(2, '0')}-01`,
    until: `${y}-${String(m + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
  };
}

function metricTotal(insightsData, name) {
  if (!insightsData) return null;
  const item = insightsData.data.find((d) => d.name === name);
  if (!item) return null;
  if (item.total_value) return item.total_value.value || 0;
  return (item.values || []).reduce((a, v) => a + (v.value || 0), 0);
}

// Insights-only rollup per month (no post fetching -- this is for the
// multi-month trend view, where fetching full post lists for 6+ months
// would be a lot of unnecessary pagination for numbers the trend doesn't
// need). Each month's IG/FB insights fetch already degrades gracefully
// per-metric, so a bad month just shows nulls for whatever failed rather
// than breaking the whole trend.
async function getMonthRollup(range) {
  const [igIns, fbIns] = await Promise.allSettled([
    getIGInsights(range.since, range.until),
    getFBInsights(range.since, range.until),
  ]);
  const ig = igIns.status === 'fulfilled' ? igIns.value : null;
  const fb = fbIns.status === 'fulfilled' ? fbIns.value : null;
  return {
    month: range.since.slice(0, 7),
    label: range.label,
    igReach: metricTotal(ig, 'reach'),
    igAccsEng: metricTotal(ig, 'accounts_engaged'),
    igNewFollowers: metricTotal(ig, 'follower_count'),
    fbReach: metricTotal(fb, 'page_impressions_unique'),
    fbEng: metricTotal(fb, 'page_post_engagements'),
    fbNewFans: metricTotal(fb, 'page_fan_adds'),
  };
}

const app = express();

app.get('/api/health', (req, res) => {
  res.json({ ok: true, tokenConfigured: Boolean(META_ACCESS_TOKEN) });
});

app.get('/api/trend', async (req, res) => {
  if (!META_ACCESS_TOKEN) {
    res.status(503).json({ error: 'META_ACCESS_TOKEN is not configured on the server (see server/.env.example)' });
    return;
  }
  const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 12);
  const ranges = Array.from({ length: months }, (_, i) => monthRange(months - 1 - i)); // oldest first
  try {
    const trend = await Promise.all(ranges.map(getMonthRollup));
    res.json({ trend });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Trailing-12-months post list for the Content Calendar widget, deliberately
// independent of whatever date range the rest of the dashboard is navigated
// to (the header's Month/Week/custom picker) -- same "fixed window, fetched
// once per session" pattern as /api/trend. Posts only (no insights), since
// the calendar just needs to know what published on which day.
app.get('/api/calendar', async (req, res) => {
  if (!META_ACCESS_TOKEN) {
    res.status(503).json({ error: 'META_ACCESS_TOKEN is not configured on the server (see server/.env.example)' });
    return;
  }
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const since = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-01`;
  const [igPosts, fbPosts] = await Promise.allSettled([getIGPosts(since), getFBPosts(since)]);
  res.json({
    since,
    igPosts: igPosts.status === 'fulfilled' ? igPosts.value : [],
    fbPosts: fbPosts.status === 'fulfilled' ? fbPosts.value : [],
    errors: {
      igPosts: igPosts.status === 'rejected' ? String(igPosts.reason?.message || igPosts.reason) : null,
      fbPosts: fbPosts.status === 'rejected' ? String(fbPosts.reason?.message || fbPosts.reason) : null,
    },
  });
});

// Best-effort "did the business reply to comments" rollup for one period.
// Unlike the main posts/insights fetches, this makes one extra Graph API
// call per post (to see who commented), so it's kept separate and
// completely optional -- if anything about it fails (rate limit, an
// unexpected comment field shape, whatever), the whole feature just
// reports itself unavailable rather than affecting the rest of the
// dashboard.
async function getCommentAuthors(postId) {
  const body = await graphGet(`${postId}/comments`, { fields: 'from', limit: 50 });
  return body?.data ?? [];
}

app.get('/api/community', async (req, res) => {
  const { since, until } = req.query;
  if (!since || !until) {
    res.status(400).json({ error: 'since and until (YYYY-MM-DD) are required query params' });
    return;
  }
  if (!META_ACCESS_TOKEN) {
    res.status(503).json({ available: false, reason: 'not configured' });
    return;
  }
  try {
    const [igPosts, fbPosts] = await Promise.all([
      getIGPosts(since, until),
      getFBPosts(since, until),
    ]);
    const allPosts = [
      ...igPosts.filter((p) => (p.comments_count || 0) > 0).map((p) => ({ id: p.id })),
      ...fbPosts.filter((p) => (p.comments?.summary?.total_count || 0) > 0).map((p) => ({ id: p.id })),
    ];
    if (allPosts.length === 0) {
      res.json({ available: true, postsWithComments: 0, postsWithReply: 0, replyRate: null });
      return;
    }
    const results = await Promise.allSettled(allPosts.map((p) => getCommentAuthors(p.id)));
    let fetchedAny = false;
    let postsWithReply = 0;
    results.forEach((r) => {
      if (r.status !== 'fulfilled') return;
      fetchedAny = true;
      const repliedByBusiness = r.value.some((c) => {
        const fromId = c.from?.id;
        return fromId === META_IG_ID || fromId === META_FB_PAGE_ID;
      });
      if (repliedByBusiness) postsWithReply += 1;
    });
    if (!fetchedAny) {
      res.json({ available: false, reason: 'comment authors could not be read for this account' });
      return;
    }
    res.json({
      available: true,
      postsWithComments: allPosts.length,
      postsWithReply,
      replyRate: Math.round((postsWithReply / allPosts.length) * 100),
    });
  } catch (err) {
    res.json({ available: false, reason: String(err?.message || err) });
  }
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

// ── GoHighLevel Social Planner (upcoming/scheduled posts) ─────────────────
// Completely separate credential and API from Meta -- GHL is where this
// client's posts get scheduled before Meta ever sees them. Same
// fail-gracefully approach as the community-management feature: if GHL
// isn't configured or its API errors, /api/upcoming just reports itself
// unavailable rather than affecting anything else on the dashboard.
const GHL_API_VERSION = '2021-07-28';

async function ghlFetch(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${GHL_API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: GHL_API_VERSION,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`GHL API ${resp.status}: ${JSON.stringify(body).slice(0, 200)}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/upcoming', async (req, res) => {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    res.json({ available: false, reason: 'GHL_API_KEY/GHL_LOCATION_ID not configured (see server/.env.example)' });
    return;
  }
  try {
    const now = new Date();
    const toDate = new Date(now.getTime() + 60 * 86400000); // next 60 days
    const body = await ghlFetch(`/social-media-posting/${GHL_LOCATION_ID}/posts/list`, {
      method: 'POST',
      body: JSON.stringify({
        skip: '0',
        limit: '50',
        fromDate: now.toISOString(),
        toDate: toDate.toISOString(),
        includeUsers: 'true',
        type: 'scheduled',
      }),
    });
    const posts = body?.results?.posts ?? body?.posts ?? [];
    const upcoming = posts
      .map((p) => {
        const accountIds = p.accountIds || [];
        const onIG = accountIds.some((id) => META_IG_ID && id.includes(META_IG_ID));
        const onFB = accountIds.some((id) => META_FB_PAGE_ID && id.includes(META_FB_PAGE_ID));
        if (!onIG && !onFB) return null; // not one of this dashboard's connected accounts
        const media = (p.media || [])[0];
        const isVideo = (media?.type || '').startsWith('video');
        return {
          id: p._id || p.postId,
          caption: p.summary || '',
          // Video posts carry a separate `thumbnail` (a real image) --
          // media[0].url for those is the video file itself, not something
          // an <img> tag can show.
          mediaUrl: (isVideo ? p.thumbnail : media?.url) || p.thumbnail || null,
          mediaType: media?.type || null,
          scheduleDate: p.scheduleDate || p.displayDate,
          postType: p.type || 'post',
          instagram: onIG,
          facebook: onFB,
        };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(a.scheduleDate) - new Date(b.scheduleDate));
    res.json({ available: true, upcoming });
  } catch (err) {
    res.json({ available: false, reason: String(err?.message || err) });
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`Renew Urban dashboard server listening on http://localhost:${PORT}`);
  if (!META_ACCESS_TOKEN) {
    console.warn('WARNING: META_ACCESS_TOKEN is not set -- copy .env.example to .env and fill it in.');
  }
});
