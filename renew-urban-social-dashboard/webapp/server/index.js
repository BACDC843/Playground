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

async function graphGet(path, params) {
  const url = new URL(`${META_GRAPH_BASE_URL}/${META_API_VERSION}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', META_ACCESS_TOKEN || '');

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

function cappedUntil(until) {
  const today = new Date().toISOString().split('T')[0];
  return until > today ? today : until;
}

async function getIGPosts(since, until) {
  const data = await graphGet(`${META_IG_ID}/media`, {
    fields: IG_POST_FIELDS,
    since,
    until: cappedUntil(until),
    limit: 50,
  });
  return data?.data ?? [];
}

async function getFBPosts(since, until) {
  const data = await graphGet(`${META_FB_PAGE_ID}/posts`, {
    fields: FB_POST_FIELDS,
    since,
    until: cappedUntil(until),
    limit: 50,
  });
  return data?.data ?? [];
}

// Fetches each metric as its own Graph API call so one metric's rules
// (date-range limits, required params) can't take the others down with it.
// Only throws if every single metric failed -- a partial result is treated
// as success, with the failures logged for visibility.
async function getInsightsPerMetric(id, metrics, since, until) {
  const results = await Promise.allSettled(metrics.map((m) =>
    graphGet(`${id}/insights`, {
      metric: m.name,
      period: 'day',
      ...(m.metric_type ? { metric_type: m.metric_type } : {}),
      since,
      until,
    })
  ));
  const data = [];
  const failures = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const item = r.value?.data?.[0];
      if (item) data.push(item);
    } else {
      failures.push(`${metrics[i].name}: ${r.reason?.message || r.reason}`);
    }
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
