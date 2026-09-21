// ── Post approvals ─────────────────────────────────────────────────────────
// Renew Urban reviews every post before it goes out. The flow:
//
//   1. CMG adds a post to approvals/queue.json (plus its images under
//      public/approvals/<post id>/) and deploys.
//   2. Renew Urban opens the Approvals tab, enters the review passcode, and
//      marks each post Approved or Changes requested (with notes).
//   3. Decisions are stored in Supabase (table ru_post_decisions) because
//      Render's free plan wipes the local disk on every restart.
//   4. When a post is approved, the server schedules it in Blotato for its
//      planned time, as long as that time is still in the future. Nothing is
//      ever scheduled without an approval. No answer means no post.
//
// If a post is edited in queue.json after a decision, its content hash
// changes and the old decision no longer applies -- it goes back to pending.
//
// Env vars (all set in Render, never committed):
//   REVIEW_PASSCODE            passcode the reviewer types in
//   SUPABASE_URL               https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  service role key (server-side only)
//   BLOTATO_API_KEY            already set for Upcoming Posts
//   AUTO_SCHEDULE              "true" to schedule in Blotato on approval (default "true")
//   BLOTATO_IG_ACCOUNT_ID      Blotato account id for @renew_urban (default 60850)
//   BLOTATO_FB_ACCOUNT_ID      Blotato account id that owns the FB page (default 42817)
//   META_FB_PAGE_ID            already set; the Renew Urban Facebook page
//   PUBLIC_BASE_URL            where images are served from (default https://renewurban.chsmediagroup.com)

// Supabase table (run once in the SQL editor):
//
//   create table public.ru_post_decisions (
//     post_id        text primary key,
//     status         text not null check (status in ('approved','changes_requested')),
//     reviewer_name  text,
//     notes          text,
//     decided_at     timestamptz default now(),
//     content_hash   text not null,
//     schedule_state text,
//     schedule_ids   jsonb,
//     schedule_error text,
//     history        jsonb default '[]'::jsonb
//   );
//   alter table public.ru_post_decisions enable row level security;
//
// RLS with no policies means only the service role key (this server) can
// read or write it.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.join(__dirname, 'approvals', 'queue.json');
const TABLE = 'ru_post_decisions';
const MIN_LEAD_MS = 10 * 60 * 1000; // don't schedule anything less than 10 minutes out

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

function cfg() {
  return {
    passcode: env('REVIEW_PASSCODE'),
    supabaseUrl: (env('SUPABASE_URL') || '').replace(/\/+$/, ''),
    supabaseKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    blotatoKey: env('BLOTATO_API_KEY'),
    blotatoBase: env('BLOTATO_API_BASE', 'https://backend.blotato.com'),
    autoSchedule: env('AUTO_SCHEDULE', 'true') === 'true',
    igAccountId: env('BLOTATO_IG_ACCOUNT_ID', '60850'),
    fbAccountId: env('BLOTATO_FB_ACCOUNT_ID', '42817'),
    fbPageId: env('META_FB_PAGE_ID', '227517480778696'),
    publicBase: env('PUBLIC_BASE_URL', 'https://renewurban.chsmediagroup.com').replace(/\/+$/, ''),
  };
}

// ── Queue ───────────────────────────────────────────────────────────────────
async function loadQueue() {
  try {
    const raw = await fs.readFile(QUEUE_PATH, 'utf8');
    const body = JSON.parse(raw);
    return Array.isArray(body.posts) ? body.posts : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`approvals/queue.json could not be read: ${err.message}`);
  }
}

// Hash of everything the reviewer actually approves. Editing any of it
// invalidates an earlier decision.
function contentHash(post) {
  const relevant = {
    plannedAt: post.plannedAt,
    images: post.images,
    instagram: post.instagram,
    facebook: post.facebook,
  };
  return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

// ── Supabase (PostgREST) ────────────────────────────────────────────────────
async function sb(method, query, body, extraHeaders = {}) {
  const c = cfg();
  const resp = await fetch(`${c.supabaseUrl}/rest/v1/${TABLE}${query}`, {
    method,
    headers: {
      apikey: c.supabaseKey,
      // Legacy service_role keys are JWTs and go in Authorization too. The
      // newer sb_secret_ keys aren't JWTs and only belong in apikey.
      ...(c.supabaseKey?.startsWith('sb_') ? {} : { Authorization: `Bearer ${c.supabaseKey}` }),
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function getDecisions() {
  const rows = await sb('GET', '?select=*');
  return Object.fromEntries((rows || []).map((r) => [r.post_id, r]));
}

async function upsertDecision(row) {
  const rows = await sb('POST', '?on_conflict=post_id', row, {
    Prefer: 'resolution=merge-duplicates,return=representation',
  });
  return rows?.[0] || row;
}

// ── Blotato ─────────────────────────────────────────────────────────────────
async function blotatoCreatePost(payload) {
  const c = cfg();
  const resp = await fetch(`${c.blotatoBase}/v2/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'blotato-api-key': c.blotatoKey },
    body: JSON.stringify(payload),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Blotato ${resp.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

function absoluteUrl(u) {
  if (/^https?:\/\//i.test(u)) return u;
  return `${cfg().publicBase}/${u.replace(/^\/+/, '')}`;
}

async function schedulePost(post) {
  const c = cfg();
  const mediaUrls = (post.images || []).map(absoluteUrl);
  const results = {};
  const errors = [];
  if (post.instagram?.caption) {
    try {
      const target = { targetType: 'instagram' };
      if (post.instagram.altText) target.altText = post.instagram.altText;
      if (post.instagram.firstComment) target.firstComment = post.instagram.firstComment;
      const r = await blotatoCreatePost({
        post: { accountId: c.igAccountId, content: { text: post.instagram.caption, mediaUrls, platform: 'instagram' }, target },
        scheduledTime: post.plannedAt,
      });
      results.instagram = r.postSubmissionId || r.id || true;
    } catch (err) {
      errors.push(`Instagram: ${err.message}`);
    }
  }
  if (post.facebook?.caption) {
    try {
      const target = { targetType: 'facebook', pageId: c.fbPageId };
      if (post.facebook.firstComment) target.firstComment = post.facebook.firstComment;
      const r = await blotatoCreatePost({
        post: { accountId: c.fbAccountId, content: { text: post.facebook.caption, mediaUrls, platform: 'facebook' }, target },
        scheduledTime: post.plannedAt,
      });
      results.facebook = r.postSubmissionId || r.id || true;
    } catch (err) {
      errors.push(`Facebook: ${err.message}`);
    }
  }
  return { results, errors };
}

// ── Auth ────────────────────────────────────────────────────────────────────
const failedAttempts = new Map(); // ip -> { count, until }

function checkPasscode(req, res) {
  const c = cfg();
  if (!c.passcode) {
    res.status(503).json({ error: 'Approvals are not set up yet (REVIEW_PASSCODE missing).' });
    return false;
  }
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const f = failedAttempts.get(ip);
  if (f && f.until > Date.now()) {
    res.status(429).json({ error: 'Too many wrong passcodes. Try again in a few minutes.' });
    return false;
  }
  const given = Buffer.from(String(req.get('x-review-passcode') || ''));
  const want = Buffer.from(c.passcode);
  const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!ok) {
    const count = (f?.count || 0) + 1;
    failedAttempts.set(ip, { count, until: count >= 5 ? Date.now() + 10 * 60 * 1000 : 0 });
    res.status(401).json({ error: 'Wrong passcode.' });
    return false;
  }
  failedAttempts.delete(ip);
  return true;
}

function storageReady(res) {
  const c = cfg();
  if (!c.supabaseUrl || !c.supabaseKey) {
    res.status(503).json({ error: 'Approvals are not set up yet (Supabase settings missing).' });
    return false;
  }
  return true;
}

// ── Status ──────────────────────────────────────────────────────────────────
function statusFor(post, d) {
  if (!d || d.content_hash !== contentHash(post)) return 'pending';
  return d.status; // approved | changes_requested
}

function view(post, d) {
  const status = statusFor(post, d);
  const current = status !== 'pending';
  return {
    id: post.id,
    title: post.title,
    format: post.format,
    plannedAt: post.plannedAt,
    images: post.images || [],
    instagram: post.instagram || null,
    facebook: post.facebook || null,
    sources: post.sources || [],
    notesForReviewer: post.notesForReviewer || '',
    status,
    reviewerName: current ? d.reviewer_name : null,
    reviewerNotes: current ? d.notes : null,
    decidedAt: current ? d.decided_at : null,
    schedule: current && status === 'approved'
      ? { state: d.schedule_state, ids: d.schedule_ids, error: d.schedule_error }
      : null,
    previousRound: d && !current ? { status: d.status, notes: d.notes, reviewerName: d.reviewer_name, decidedAt: d.decided_at } : null,
  };
}

const locks = new Set();

export function registerApprovals(app) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  // Keep-alive: free Supabase projects pause after a week with no requests.
  // A scheduled check hits this every few days. It returns no post data.
  router.get('/ping', async (req, res) => {
    if (!cfg().supabaseUrl || !cfg().supabaseKey) { res.status(503).json({ ok: false }); return; }
    try {
      await sb('GET', '?select=post_id&limit=1');
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ ok: false });
    }
  });

  router.get('/', async (req, res) => {
    if (!checkPasscode(req, res) || !storageReady(res)) return;
    try {
      const [queue, decisions] = await Promise.all([loadQueue(), getDecisions()]);
      const posts = queue
        .map((p) => view(p, decisions[p.id]))
        .sort((a, b) => new Date(a.plannedAt) - new Date(b.plannedAt));
      res.json({ posts, autoSchedule: cfg().autoSchedule && Boolean(cfg().blotatoKey) });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  router.post('/:id/decision', async (req, res) => {
    if (!checkPasscode(req, res) || !storageReady(res)) return;
    const { id } = req.params;
    const decision = req.body?.decision;
    const reviewerName = String(req.body?.reviewerName || '').trim().slice(0, 80);
    const notes = String(req.body?.notes || '').trim().slice(0, 4000);
    if (!['approved', 'changes_requested'].includes(decision)) {
      res.status(400).json({ error: 'decision must be "approved" or "changes_requested"' });
      return;
    }
    if (!reviewerName) {
      res.status(400).json({ error: 'Please add your name.' });
      return;
    }
    if (decision === 'changes_requested' && !notes) {
      res.status(400).json({ error: 'Please say what should change.' });
      return;
    }
    if (locks.has(id)) {
      res.status(409).json({ error: 'This post is already being updated. Refresh in a moment.' });
      return;
    }
    locks.add(id);
    try {
      const queue = await loadQueue();
      const post = queue.find((p) => p.id === id);
      if (!post) {
        res.status(404).json({ error: 'That post is no longer in the queue.' });
        return;
      }
      const decisions = await getDecisions();
      const prev = decisions[id];
      const hash = contentHash(post);
      if (prev && prev.content_hash === hash && ['scheduled', 'partial'].includes(prev.schedule_state)) {
        res.status(409).json({ error: 'This post is already scheduled. Contact Barry to change or pull it.' });
        return;
      }
      const now = new Date().toISOString();
      const history = Array.isArray(prev?.history) ? prev.history.slice(-49) : [];
      history.push({ at: now, decision, reviewerName, notes, contentHash: hash });

      const row = {
        post_id: id,
        status: decision,
        reviewer_name: reviewerName,
        notes,
        decided_at: now,
        content_hash: hash,
        schedule_state: 'not_scheduled',
        schedule_ids: null,
        schedule_error: null,
        history,
      };

      if (decision === 'approved') {
        const c = cfg();
        const planned = new Date(post.plannedAt).getTime();
        if (!c.autoSchedule || !c.blotatoKey) {
          row.schedule_state = 'manual';
        } else if (!Number.isFinite(planned) || planned - Date.now() < MIN_LEAD_MS) {
          row.schedule_state = 'needs_new_time';
          row.schedule_error = 'Approved after the planned time. Barry will pick a new time.';
        } else {
          const { results, errors } = await schedulePost(post);
          row.schedule_ids = results;
          if (errors.length && Object.keys(results).length === 0) {
            row.schedule_state = 'failed';
          } else if (errors.length) {
            row.schedule_state = 'partial';
          } else {
            row.schedule_state = 'scheduled';
          }
          row.schedule_error = errors.length ? errors.join(' | ') : null;
          if (errors.length) console.error(`[approvals] scheduling ${id}: ${row.schedule_error}`);
        }
      }

      const saved = await upsertDecision(row);
      res.json({ post: view(post, saved) });
    } catch (err) {
      console.error(`[approvals] ${id}:`, err);
      res.status(500).json({ error: String(err.message || err) });
    } finally {
      locks.delete(id);
    }
  });

  app.use('/api/approvals', router);
}
