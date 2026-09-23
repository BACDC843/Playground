// ── Post approvals ─────────────────────────────────────────────────────────
// Renew Urban reviews every post before it goes out. The flow:
//
//   1. CMG adds a post on the admin page (/admin.html). The post is saved in
//      Supabase (table ru_post_queue) and its images in Supabase Storage
//      (bucket ru-approvals), so nothing needs a commit or a redeploy.
//      approvals/queue.json still works for posts added the old way.
//   2. Renew Urban opens the Approvals tab, enters the review passcode, and
//      marks each post Approved or Changes requested (with notes).
//   3. Decisions are stored in Supabase (table ru_post_decisions) because
//      Render's free plan wipes the local disk on every restart.
//   4. When a post is approved, the server schedules it in Blotato for its
//      planned time, as long as that time is still in the future. Nothing is
//      ever scheduled without an approval. No answer means no post.
//
// If a post is edited (admin page or queue.json) after a decision, its content hash
// changes and the old decision no longer applies -- it goes back to pending.
//
// Env vars (all set in Render, never committed):
//   REVIEW_PASSCODE            passcode the reviewer types in
//   ADMIN_PASSCODE             passcode for the admin page (adding/editing posts)
//   APPROVER_EMAILS            who gets "Submit for approval" emails (default paige@ and andy@renewurban.net)
//   NOTIFY_FROM                sender; must be on a domain verified in Resend to email anyone but the Resend account owner
//   SUPABASE_URL               https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  service role key (server-side only)
//   BLOTATO_API_KEY            already set for Upcoming Posts
//   AUTO_SCHEDULE              "true" to schedule in Blotato on approval (default "true")
//   BLOTATO_IG_ACCOUNT_ID      Blotato account id for @renew_urban (default 60850)
//   BLOTATO_FB_ACCOUNT_ID      Blotato account id that owns the FB page (default 42817)
//   META_FB_PAGE_ID            already set; the Renew Urban Facebook page
//   PUBLIC_BASE_URL            where images are served from (default https://renewurban.chsmediagroup.com)
//   RESEND_API_KEY             optional; emails NOTIFY_EMAIL on every decision
//   NOTIFY_EMAIL               who gets the emails (default barry@chsmediagroup.com)
//   NOTIFY_FROM                sender (default Renew Urban Approvals <onboarding@resend.dev>)

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
const QUEUE_TABLE = 'ru_post_queue';
const BUCKET = 'ru-approvals';
const IG_MAX_HASHTAGS = 5;     // Blotato rejects Instagram posts with more
const IG_MAX_CAPTION = 2200;
const IG_MAX_IMAGES = 10;
const MIN_LEAD_MS = 10 * 60 * 1000; // don't schedule anything less than 10 minutes out

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

function cfg() {
  return {
    passcode: env('REVIEW_PASSCODE'),
    adminPasscode: env('ADMIN_PASSCODE'),
    supabaseUrl: (env('SUPABASE_URL') || '').replace(/\/+$/, ''),
    supabaseKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    blotatoKey: env('BLOTATO_API_KEY'),
    blotatoBase: env('BLOTATO_API_BASE', 'https://backend.blotato.com'),
    autoSchedule: env('AUTO_SCHEDULE', 'true') === 'true',
    igAccountId: env('BLOTATO_IG_ACCOUNT_ID', '60850'),
    fbAccountId: env('BLOTATO_FB_ACCOUNT_ID', '42817'),
    fbPageId: env('META_FB_PAGE_ID', '227517480778696'),
    publicBase: env('PUBLIC_BASE_URL', 'https://renewurban.chsmediagroup.com').replace(/\/+$/, ''),
    resendKey: env('RESEND_API_KEY'),
    notifyTo: env('NOTIFY_EMAIL', 'barry@chsmediagroup.com'),
    notifyFrom: env('NOTIFY_FROM', 'Renew Urban Approvals <onboarding@resend.dev>'),
    approverEmails: env('APPROVER_EMAILS', 'paige@renewurban.net,andy@renewurban.net').split(',').map((x) => x.trim()).filter(Boolean),
    replyTo: env('REPLY_TO_EMAIL', 'barry@chsmediagroup.com'),
  };
}

// ── Queue ───────────────────────────────────────────────────────────────────
// Posts come from two places: Supabase (added on the admin page) and the
// legacy approvals/queue.json. A Supabase post wins if both use the same id.
async function loadFileQueue() {
  try {
    const raw = await fs.readFile(QUEUE_PATH, 'utf8');
    const body = JSON.parse(raw);
    return Array.isArray(body.posts) ? body.posts : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`approvals/queue.json could not be read: ${err.message}`);
  }
}

async function loadDbQueue() {
  const c = cfg();
  if (!c.supabaseUrl || !c.supabaseKey) return [];
  const rows = await sb('GET', '?select=id,post,submitted_at&active=eq.true', null, {}, QUEUE_TABLE);
  return (rows || []).map((r) => ({ ...r.post, id: r.id, _source: 'admin', _submittedAt: r.submitted_at || null }));
}

async function loadQueue() {
  const [file, db] = await Promise.all([loadFileQueue(), loadDbQueue()]);
  const ids = new Set(db.map((p) => p.id));
  return [...db, ...file.filter((p) => !ids.has(p.id)).map((p) => ({ ...p, _source: 'file' }))];
}

// ── Checks ──────────────────────────────────────────────────────────────────
// Blotato counts every "#word" as a hashtag, including something like "#1"
// in the middle of a sentence, so this counts the same way.
export function countHashtags(text) {
  return (String(text || '').match(/#[\p{L}\p{N}_]+/gu) || []).length;
}

function checkPost(post) {
  const errors = [];
  const warnings = [];
  if (!String(post.title || '').trim()) errors.push('Add a title.');
  const planned = new Date(post.plannedAt).getTime();
  if (!Number.isFinite(planned)) errors.push('Set a planned date and time.');
  else if (planned - Date.now() < MIN_LEAD_MS) warnings.push('The planned time is less than 10 minutes away or already past. An approval won\'t schedule it.');
  const images = post.images || [];
  const video = post.video || null;
  if (!images.length && !video) errors.push('Add at least one image or a video.');
  if (video && images.length > 1) errors.push('A video post can have one cover image at most.');
  if (video && video.width && video.height) {
    const r = video.width / video.height;
    if (Math.abs(r - 9 / 16) > 0.02) warnings.push(`The video is ${video.width}x${video.height}, not vertical 9:16. Instagram will show it letterboxed as a Reel.`);
  }
  const ig = post.instagram || {};
  const fb = post.facebook || {};
  if (!String(ig.caption || '').trim() && !String(fb.caption || '').trim()) errors.push('Write an Instagram or Facebook caption.');
  if (ig.caption) {
    const n = countHashtags(ig.caption);
    if (n > IG_MAX_HASHTAGS) errors.push(`Instagram caption has ${n} hashtags. Instagram allows ${IG_MAX_HASHTAGS} (anything like "#1" counts).`);
    if (ig.caption.length > IG_MAX_CAPTION) errors.push(`Instagram caption is ${ig.caption.length} characters. The limit is ${IG_MAX_CAPTION}.`);
    if (!video && images.length > IG_MAX_IMAGES) errors.push(`Instagram carousels take up to ${IG_MAX_IMAGES} images.`);
  }
  return { errors, warnings };
}
// Hash of everything the reviewer actually approves. Editing any of it
// invalidates an earlier decision.
function contentHash(post) {
  const relevant = {
    plannedAt: post.plannedAt,
    images: post.images,
    video: post.video || null,
    instagram: post.instagram,
    facebook: post.facebook,
  };
  return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

// ── Supabase (PostgREST) ────────────────────────────────────────────────────
function sbAuthHeaders() {
  const c = cfg();
  return {
    apikey: c.supabaseKey,
    // Legacy service_role keys are JWTs and go in Authorization too. The
    // newer sb_secret_ keys aren't JWTs and only belong in apikey.
    ...(c.supabaseKey?.startsWith('sb_') ? {} : { Authorization: `Bearer ${c.supabaseKey}` }),
  };
}

async function sb(method, query, body, extraHeaders = {}, table = TABLE) {
  const c = cfg();
  const resp = await fetch(`${c.supabaseUrl}/rest/v1/${table}${query}`, {
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

async function uploadImage(buffer, contentType, filename) {
  const c = cfg();
  const ext = (filename.match(/\.(jpe?g|png|webp)$/i)?.[1] || (contentType.split('/')[1] || 'jpg')).toLowerCase().replace('jpeg', 'jpg');
  const base = filename.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
  const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomBytes(5).toString('hex')}-${base}.${ext}`;
  const resp = await fetch(`${c.supabaseUrl}/storage/v1/object/${BUCKET}/${key}`, {
    method: 'POST',
    headers: { ...sbAuthHeaders(), 'Content-Type': contentType, 'x-upsert': 'false', 'cache-control': '31536000' },
    body: buffer,
  });
  if (!resp.ok) throw new Error(`Image upload failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  return `${c.supabaseUrl}/storage/v1/object/public/${BUCKET}/${key}`;
}

function slugify(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'post';
}

// Only the fields a post is allowed to have; everything else is dropped.
function cleanPost(input) {
  const str = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').slice(0, max);
  const side = (o, withAlt) => {
    if (!o || !String(o.caption || '').trim()) return null;
    const out = { caption: str(o.caption, 5000) };
    if (String(o.firstComment || '').trim()) out.firstComment = str(o.firstComment, 2000);
    if (withAlt && String(o.altText || '').trim()) out.altText = str(o.altText, 1000);
    return out;
  };
  const images = (Array.isArray(input.images) ? input.images : [])
    .map((u) => String(u || '').trim())
    .filter((u) => /^https:\/\//i.test(u) || u.startsWith('/approvals/') || (cfg().supabaseUrl && u.startsWith(`${cfg().supabaseUrl}/`)))
    .slice(0, 20);
  const sources = (Array.isArray(input.sources) ? input.sources : [])
    .map((x) => ({ name: str(x?.name, 300).trim(), url: str(x?.url, 1000).trim() }))
    .filter((x) => x.name || x.url)
    .slice(0, 20);
  const n = images.length;
  let video = null;
  if (input.video && /^https:\/\//i.test(String(input.video.url || ''))) {
    const num = (v) => (Number.isFinite(+v) && +v > 0 ? Math.round(+v) : undefined);
    video = { url: String(input.video.url).trim(), width: num(input.video.width), height: num(input.video.height), duration: num(input.video.duration) };
  }
  return {
    title: str(input.title, 200).trim(),
    format: str(input.format, 100).trim() || (video ? 'Video (Reel)' : n > 1 ? `${n}-slide carousel` : 'Single image'),
    video,
    plannedAt: new Date(input.plannedAt).toString() === 'Invalid Date' ? '' : new Date(input.plannedAt).toISOString(),
    images,
    instagram: side(input.instagram, true),
    facebook: side(input.facebook, false),
    sources,
    notesForReviewer: str(input.notesForReviewer, 2000).trim(),
  };
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
  const video = post.video?.url ? absoluteUrl(post.video.url) : null;
  const cover = video && post.images?.[0] ? absoluteUrl(post.images[0]) : null;
  const mediaUrls = video ? [video] : (post.images || []).map(absoluteUrl);
  const results = {};
  const errors = [];
  if (post.instagram?.caption) {
    try {
      const target = { targetType: 'instagram' };
      if (video) {
        target.mediaType = 'reel';
        target.shareToFeed = true;
        if (cover) target.coverImageUrl = cover;
      }
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

// ── Email notification (Resend) ─────────────────────────────────────────────
// Emails Barry every time a post is approved or sent back. Optional: without
// RESEND_API_KEY it does nothing. With Resend's default sender
// (onboarding@resend.dev) mail can only go to the address the Resend account
// was created with, so sign up with the NOTIFY_EMAIL address.
const escHtml = (t) => String(t ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function scheduleText(row, post) {
  const when = new Date(post.plannedAt).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
  switch (row.schedule_state) {
    case 'scheduled': return `Scheduled in Blotato for ${when} (Instagram and Facebook).`;
    case 'partial': return `Only partly scheduled -- check Blotato. ${row.schedule_error || ''}`;
    case 'failed': return `NOT scheduled -- Blotato returned an error: ${row.schedule_error || 'unknown'}. Schedule it manually.`;
    case 'needs_new_time': return `NOT scheduled -- approved after its planned time (${when}). Pick a new time.`;
    case 'manual': return 'Automatic scheduling is off. Schedule it in Blotato.';
    default: return '';
  }
}

async function notifyDecision(post, row) {
  const c = cfg();
  if (!c.resendKey || !c.notifyTo) return false;
  const approved = row.status === 'approved';
  const subject = approved
    ? `${row.reviewer_name} approved: ${post.title}`
    : `${row.reviewer_name} requested changes: ${post.title}`;
  const lines = [
    `<p><b>${escHtml(row.reviewer_name)}</b> ${approved ? 'approved' : 'requested changes to'} <b>${escHtml(post.title)}</b>.</p>`,
    row.notes ? `<p><b>Notes:</b><br>${escHtml(row.notes).replace(/\n/g, '<br>')}</p>` : '',
    approved ? `<p>${escHtml(scheduleText(row, post))}</p>` : '<p>Edit it on the admin page to send it back for another review.</p>',
    `<p><a href="${c.publicBase}/?tab=approvals">Open the Approvals tab</a></p>`,
  ];
  try {
    const resp = await fetch(`${env('RESEND_API_BASE', 'https://api.resend.com')}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: c.notifyFrom, to: [c.notifyTo], subject, html: lines.join('') }),
    });
    if (!resp.ok) {
      console.error(`[approvals] notification email failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[approvals] notification email failed:', err.message);
    return false;
  }
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
    video: post.video || null,
    submittedAt: post._submittedAt || null,
    instagram: post.instagram || null,
    facebook: post.facebook || null,
    sources: post.sources || [],
    notesForReviewer: post.notesForReviewer || '',
    source: post._source || 'file',
    checks: checkPost(post),
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

  // Sends a test notification so email can be checked without touching a real post.
  router.post('/test-notify', async (req, res) => {
    if (!checkPasscode(req, res)) return;
    if (!cfg().resendKey) { res.status(503).json({ ok: false, error: 'RESEND_API_KEY not set' }); return; }
    const ok = await notifyDecision(
      { title: 'Test post (ignore)', plannedAt: new Date(Date.now() + 86400000).toISOString() },
      { status: 'approved', reviewer_name: 'Test', notes: 'This is a test of approval notifications.', schedule_state: 'scheduled' },
    );
    res.json({ ok });
  });

  router.get('/', async (req, res) => {
    if (!checkPasscode(req, res) || !storageReady(res)) return;
    try {
      const [queue, decisions] = await Promise.all([loadQueue(), getDecisions()]);
      // Posts that already went out drop off the reviewer's list a day later.
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const posts = queue
        .map((p) => view(p, decisions[p.id]))
        .filter((v) => !(v.status === 'approved' && new Date(v.plannedAt).getTime() < cutoff))
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
        const problems = checkPost(post).errors;
        if (!c.autoSchedule || !c.blotatoKey) {
          row.schedule_state = 'manual';
        } else if (problems.length) {
          row.schedule_state = 'failed';
          row.schedule_error = `Not scheduled: ${problems.join(' ')} Barry will fix it and resend.`;
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
      notifyDecision(post, saved); // fire and forget; never blocks the reviewer
      res.json({ post: view(post, saved) });
    } catch (err) {
      console.error(`[approvals] ${id}:`, err);
      res.status(500).json({ error: String(err.message || err) });
    } finally {
      locks.delete(id);
    }
  });

  app.use('/api/approvals', router);
  app.use('/api/admin', adminRouter());
}

// ── Admin (CMG only) ────────────────────────────────────────────────────────
function checkAdmin(req, res) {
  const c = cfg();
  if (!c.adminPasscode) {
    res.status(503).json({ error: 'The admin page is not set up yet (ADMIN_PASSCODE missing).' });
    return false;
  }
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const key = `admin:${ip}`;
  const f = failedAttempts.get(key);
  if (f && f.until > Date.now()) {
    res.status(429).json({ error: 'Too many wrong passcodes. Try again in a few minutes.' });
    return false;
  }
  const given = Buffer.from(String(req.get('x-admin-passcode') || ''));
  const want = Buffer.from(c.adminPasscode);
  if (!(given.length === want.length && crypto.timingSafeEqual(given, want))) {
    const count = (f?.count || 0) + 1;
    failedAttempts.set(key, { count, until: count >= 5 ? Date.now() + 10 * 60 * 1000 : 0 });
    res.status(401).json({ error: 'Wrong passcode.' });
    return false;
  }
  failedAttempts.delete(key);
  return true;
}

function adminRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '20mb' }));
  r.use((req, res, next) => (checkAdmin(req, res) && storageReady(res) ? next() : undefined));

  r.get('/posts', async (req, res) => {
    try {
      const [queue, decisions] = await Promise.all([loadQueue(), getDecisions()]);
      const posts = queue
        .map((p) => view(p, decisions[p.id]))
        .sort((a, b) => new Date(a.plannedAt) - new Date(b.plannedAt));
      res.json({ posts });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // One image per request, sent as base64 JSON (keeps the server dependency-free).
  r.post('/images', async (req, res) => {
    try {
      const { filename = 'image.jpg', contentType = '', data = '' } = req.body || {};
      if (!/^image\/(jpeg|png|webp)$/.test(contentType)) {
        res.status(400).json({ error: 'Images must be JPG, PNG or WebP.' });
        return;
      }
      const buffer = Buffer.from(String(data), 'base64');
      if (!buffer.length || buffer.length > 12 * 1024 * 1024) {
        res.status(400).json({ error: 'Each image must be under 12 MB.' });
        return;
      }
      res.json({ url: await uploadImage(buffer, contentType, String(filename)) });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // Videos are too big for the free Supabase plan, so they go straight from
  // the browser to Blotato's storage (where they'll be published from anyway).
  r.post('/video-upload', async (req, res) => {
    try {
      const c = cfg();
      if (!c.blotatoKey) { res.status(503).json({ error: 'BLOTATO_API_KEY is not set.' }); return; }
      const name = String(req.body?.filename || 'video.mp4');
      if (!/\.(mp4|mov|m4v)$/i.test(name)) { res.status(400).json({ error: 'Videos must be MP4 or MOV.' }); return; }
      const clean = name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+/, '').slice(-60);
      const resp = await fetch(`${c.blotatoBase}/v2/media/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'blotato-api-key': c.blotatoKey },
        body: JSON.stringify({ filename: `ru-${Date.now()}-${clean}` }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok || !body.presignedUrl) throw new Error(`Blotato ${resp.status}: ${JSON.stringify(body).slice(0, 200)}`);
      res.json({ uploadUrl: body.presignedUrl, publicUrl: body.publicUrl });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // Emails Paige and Andy one message listing every post waiting for them.
  r.post('/submit', async (req, res) => {
    try {
      const c = cfg();
      if (!c.resendKey) { res.status(503).json({ error: 'Email is not set up (RESEND_API_KEY missing).' }); return; }
      if (!c.approverEmails.length) { res.status(503).json({ error: 'No approver emails set (APPROVER_EMAILS).' }); return; }
      const [queue, decisions] = await Promise.all([loadQueue(), getDecisions()]);
      const pending = queue
        .map((p) => ({ p, v: view(p, decisions[p.id]) }))
        .filter(({ v }) => v.status === 'pending' && !v.checks.errors.length)
        .sort((a, b) => new Date(a.v.plannedAt) - new Date(b.v.plannedAt));
      if (!pending.length) { res.status(400).json({ error: 'Nothing is waiting for approval.' }); return; }
      const link = `${c.publicBase}/?tab=approvals`;
      const fmt = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
      const rows = pending.map(({ v }) => {
        const thumb = v.images[0]
          ? `<img src="${escHtml(absoluteUrl(v.images[0]))}" width="72" height="90" style="object-fit:cover;border-radius:6px;display:block" alt="">`
          : '<div style="width:72px;height:90px;border-radius:6px;background:#0B1F2E;color:#fff;font:12px Arial;text-align:center;line-height:90px">Video</div>';
        return `<tr><td style="padding:10px 12px 10px 0;vertical-align:top">${thumb}</td><td style="padding:10px 0;vertical-align:top;font:14px Arial;color:#182433"><b>${escHtml(v.title)}</b><br><span style="color:#6B6F73;font-size:13px">${escHtml(fmt(v.plannedAt))} · ${escHtml(v.format || '')}</span>${v.notesForReviewer ? `<br><span style="font-size:13px">Note: ${escHtml(v.notesForReviewer)}</span>` : ''}</td></tr>`;
      }).join('');
      const n = pending.length;
      const html = `<div style="font:15px Arial;color:#182433;max-width:560px">
        <p>Hi Paige and Andy,</p>
        <p>${n === 1 ? 'A new post is' : `${n} new posts are`} ready for your approval. Nothing goes out until one of you approves it.</p>
        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}</table>
        <p style="margin:22px 0"><a href="${link}" style="background:#C99A4A;color:#fff;text-decoration:none;padding:12px 22px;border-radius:22px;font-weight:bold">Review and approve</a></p>
        <p style="font-size:13px;color:#6B6F73">Use the review passcode we gave you. Reply to this email with any questions.<br>Barry, Charleston Media Group</p></div>`;
      const resp = await fetch(`${env('RESEND_API_BASE', 'https://api.resend.com')}/emails`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: c.notifyFrom, to: c.approverEmails, reply_to: c.replyTo, cc: c.replyTo ? [c.replyTo] : undefined,
          subject: n === 1 ? `Ready for approval: ${pending[0].v.title}` : `${n} Renew Urban posts ready for approval`,
          html,
        }),
      });
      if (!resp.ok) {
        const t = (await resp.text()).slice(0, 300);
        const hint = /verify a domain|testing emails|own email/i.test(t) ? ' Resend will only email other people once chsmediagroup.com is verified there.' : '';
        res.status(502).json({ error: `Email didn't send (Resend ${resp.status}).${hint} ${t}` });
        return;
      }
      const now = new Date().toISOString();
      const ids = pending.filter(({ p }) => p._source === 'admin').map(({ p }) => p.id);
      if (ids.length) {
        await sb('PATCH', `?id=in.(${ids.map(encodeURIComponent).join(',')})`, { submitted_at: now }, { Prefer: 'return=minimal' }, QUEUE_TABLE);
      }
      res.json({ ok: true, sent: n, to: c.approverEmails });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // Create (no id) or update (id) a post. Saving any change sends it back to
  // pending, because the content hash changes.
  r.post('/posts', async (req, res) => {
    try {
      const post = cleanPost(req.body?.post || {});
      const { errors, warnings } = checkPost(post);
      if (errors.length) {
        res.status(400).json({ error: errors.join(' '), errors, warnings });
        return;
      }
      let id = String(req.body?.id || '').trim();
      const decisions = await getDecisions();
      if (id) {
        const d = decisions[id];
        if (d && d.status === 'approved' && ['scheduled', 'partial'].includes(d.schedule_state)) {
          res.status(409).json({ error: 'This post is already scheduled in Blotato. Delete it there first, then remove it here and add it again.' });
          return;
        }
      } else {
        const existing = new Set((await loadQueue()).map((p) => p.id).concat(Object.keys(decisions)));
        const baseId = `${post.plannedAt.slice(0, 10)}-${slugify(post.title)}`;
        id = baseId;
        for (let i = 2; existing.has(id); i++) id = `${baseId}-${i}`;
      }
      if (!/^[a-z0-9-]{3,80}$/.test(id)) {
        res.status(400).json({ error: 'Invalid post id.' });
        return;
      }
      const now = new Date().toISOString();
      await sb('POST', '?on_conflict=id', { id, post, active: true, updated_at: now, submitted_at: null }, {
        Prefer: 'resolution=merge-duplicates,return=minimal',
      }, QUEUE_TABLE);
      res.json({ id, warnings });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // Takes a post off the Approvals tab. Kept in the table (active=false) as a record.
  r.delete('/posts/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const rows = await sb('PATCH', `?id=eq.${encodeURIComponent(id)}`, { active: false, updated_at: new Date().toISOString() }, {
        Prefer: 'return=representation',
      }, QUEUE_TABLE);
      if (!rows?.length) {
        res.status(404).json({ error: 'Only posts added on this page can be removed here. Posts in queue.json have to be removed in the code.' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  return r;
}
