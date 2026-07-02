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
// As of a recent Graph API version, IG insights metrics are split into two
// families that can't be requested together: time-series metrics (daily
// values) and "total value" metrics, which now require an explicit
// metric_type=total_value param or the call is rejected outright.
const IG_TIME_SERIES_METRICS = 'reach,follower_count';
const IG_TOTAL_VALUE_METRICS = 'profile_views,website_clicks,accounts_engaged';
const FB_INSIGHT_METRICS = 'page_post_engagements,page_views_total';

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

async function getIGInsights(since, until) {
  const capped = cappedUntil(until);
  const [timeSeries, totals] = await Promise.all([
    graphGet(`${META_IG_ID}/insights`, {
      metric: IG_TIME_SERIES_METRICS,
      period: 'day',
      since,
      until: capped,
    }),
    graphGet(`${META_IG_ID}/insights`, {
      metric: IG_TOTAL_VALUE_METRICS,
      period: 'day',
      metric_type: 'total_value',
      since,
      until: capped,
    }),
  ]);
  return { data: [...(timeSeries?.data ?? []), ...(totals?.data ?? [])] };
}

async function getFBInsights(since, until) {
  const data = await graphGet(`${META_FB_PAGE_ID}/insights`, {
    metric: FB_INSIGHT_METRICS,
    period: 'day',
    since,
    until: cappedUntil(until),
  });
  return data ?? null;
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
