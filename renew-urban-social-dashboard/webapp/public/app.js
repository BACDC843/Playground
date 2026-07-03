// ── State ──────────────────────────────────────────────
let tab = localStorage.getItem('ru_tab') || 'overview';
// Default view on load is year-to-date (Jan 1 of the current year through
// today) rather than just "this month" -- opening the dashboard fresh
// should show how the year's going so far, not a view that resets sparse
// every time a new month starts. Computed from the current year rather
// than hardcoded so it doesn't need updating every January.
let view = 'custom';
let navDate = new Date();
navDate = new Date(navDate.getFullYear(), navDate.getMonth(), 1);
let customRange = { since: `${navDate.getFullYear()}-01-01`, until: fiso(new Date()) };

let DATA = { since:null, until:null, igPosts:[], fbPosts:[], igIns:null, fbIns:null, refreshedAt:null };
let PREV = null; // same shape as DATA, for the comparison period, or null
let s = { igPosts:[], fbPosts:[], igIns:null, fbIns:null };
let sp = null; // filtered previous-period state, used for MoM deltas

let charts = {};
let cinit = {};
let TREND_DATA = null; // 6-month rollup, cached for the session (doesn't change with date nav)
let COMMUNITY_DATA = null;
let COMMUNITY_RANGE_KEY = null; // re-fetch only when the viewed range actually changes

// ── Date helpers ──────────────────────────────────────
const MOS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MOS3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fiso(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

function getRange(){
  if(view==='custom'&&customRange) return customRange;
  if(view==='month'){
    const y=navDate.getFullYear(), m=navDate.getMonth();
    const last=new Date(y,m+1,0).getDate();
    return { since:`${y}-${String(m+1).padStart(2,'0')}-01`, until:`${y}-${String(m+1).padStart(2,'0')}-${last}` };
  } else {
    const d=new Date(navDate), day=d.getDay();
    const mon=new Date(d); mon.setDate(d.getDate()-(day===0?6:day-1));
    const sun=new Date(mon); sun.setDate(mon.getDate()+6);
    return { since:fiso(mon), until:fiso(sun) };
  }
}

// The equivalent immediately-preceding period, used for month-over-month badges.
function getPrevRange(range){
  if(view==='month'&&!customRange){
    const y=navDate.getFullYear(), m=navDate.getMonth();
    const pm=new Date(y,m-1,1);
    const last=new Date(pm.getFullYear(),pm.getMonth()+1,0).getDate();
    return { since:fiso(new Date(pm.getFullYear(),pm.getMonth(),1)), until:fiso(new Date(pm.getFullYear(),pm.getMonth(),last)) };
  }
  const sd=new Date(range.since+'T12:00:00'), ud=new Date(range.until+'T12:00:00');
  const spanDays=Math.round((ud-sd)/86400000)+1;
  const prevUntil=new Date(sd); prevUntil.setDate(prevUntil.getDate()-1);
  const prevSince=new Date(prevUntil); prevSince.setDate(prevSince.getDate()-(spanDays-1));
  return { since:fiso(prevSince), until:fiso(prevUntil) };
}

function getPeriod(){
  if(view==='custom'&&customRange){
    const sd=new Date(customRange.since+'T00:00:00'), ud=new Date(customRange.until+'T00:00:00');
    if(sd.getFullYear()===ud.getFullYear()) return `${MOS3[sd.getMonth()]} ${sd.getDate()} – ${MOS3[ud.getMonth()]} ${ud.getDate()}, ${sd.getFullYear()}`;
    return `${MOS3[sd.getMonth()]} ${sd.getDate()}, ${sd.getFullYear()} – ${MOS3[ud.getMonth()]} ${ud.getDate()}, ${ud.getFullYear()}`;
  }
  if(view==='month') return `${MOS[navDate.getMonth()]} ${navDate.getFullYear()}`;
  const {since,until}=getRange();
  const [,sm,sd]=since.split('-'); const [,um,ud]=until.split('-');
  return sm===um ? `${MOS3[+sm-1]} ${+sd}–${+ud}, ${navDate.getFullYear()}` : `${MOS3[+sm-1]} ${+sd} – ${MOS3[+um-1]} ${+ud}`;
}

function fmtDate(ts){ const d=new Date(ts); return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}); }
function fmtRefreshDate(d){ return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})+' '+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); }

// ── Data loading ───────────────────────────────────────
function showLoading(on){
  const ldg=document.getElementById('ldg');
  if(ldg) ldg.style.display=on?'flex':'none';
}
function showConfigBanner(on){
  const el=document.getElementById('config-banner');
  if(el) el.style.display=on?'block':'none';
}
function showError(msg){
  let bar=document.getElementById('error-bar');
  if(!msg){ if(bar) bar.remove(); return; }
  if(!bar){
    bar=document.createElement('div');
    bar.id='error-bar';
    bar.className='error-bar';
    document.querySelector('.main').insertBefore(bar, document.getElementById('ldg'));
  }
  bar.textContent='⚠️ '+msg;
}

function filterByRange(posts, dateField, range){
  const rSince=new Date(range.since+'T00:00:00'), rUntil=new Date(range.until+'T23:59:59');
  return (posts||[]).filter(p=>{ const d=new Date(p[dateField]); return d>=rSince&&d<=rUntil; });
}

function applyFilter(){
  const range=customRange||getRange();
  s.igPosts=filterByRange(DATA.igPosts,'timestamp',range);
  s.fbPosts=filterByRange(DATA.fbPosts,'created_time',range);
  s.igIns=DATA.igIns||null;
  s.fbIns=DATA.fbIns||null;
  if(PREV){
    const prevRange=getPrevRange(range);
    sp={
      igPosts:filterByRange(PREV.igPosts,'timestamp',prevRange),
      fbPosts:filterByRange(PREV.fbPosts,'created_time',prevRange),
      igIns:PREV.igIns||null,
      fbIns:PREV.fbIns||null,
    };
  } else {
    sp=null;
  }
  const hasAnyData=(DATA.igPosts||[]).length>0||(DATA.fbPosts||[]).length>0;
  const noPostsInRange=s.igPosts.length===0&&s.fbPosts.length===0;
  const banner=document.getElementById('no-data-banner');
  if(banner) banner.style.display=(hasAnyData&&noPostsInRange)?'block':'none';
}

async function loadData(){
  const period=getPeriod();
  document.getElementById('periodLabel').textContent=period;
  document.getElementById('print-period').textContent=`Social Media Performance Report — ${period}`;
  cinit={};
  const range=customRange||getRange();
  const prevRange=getPrevRange(range);
  showLoading(true);
  try{
    const url=new URL('/api/dashboard', location.origin);
    url.searchParams.set('since',range.since);
    url.searchParams.set('until',range.until);
    url.searchParams.set('compareSince',prevRange.since);
    url.searchParams.set('compareUntil',prevRange.until);
    const resp=await fetch(url);
    const body=await resp.json().catch(()=>null);
    if(!resp.ok){
      showConfigBanner(resp.status===503);
      showError((body&&body.error)||`Request failed (${resp.status})`);
      showLoading(false);
      return;
    }
    showConfigBanner(false);
    const cur=body.current;
    DATA={
      since:cur.since, until:cur.until,
      igPosts:cur.igPosts||[], fbPosts:cur.fbPosts||[],
      igIns:cur.igIns||null, fbIns:cur.fbIns||null,
      refreshedAt:new Date(),
    };
    PREV=body.previous?{
      since:body.previous.since, until:body.previous.until,
      igPosts:body.previous.igPosts||[], fbPosts:body.previous.fbPosts||[],
      igIns:body.previous.igIns||null, fbIns:body.previous.fbIns||null,
    }:null;
    const failed=Object.entries(cur.errors||{}).filter(([,v])=>v);
    showError(failed.length?('Partial data this refresh — '+failed.map(([k,v])=>k+': '+v).join(' | ')):null);
  }catch(err){
    showError('Network error: '+err.message);
    showLoading(false);
    return;
  }
  applyFilter();
  renderAll();
  showLoading(false);
  setTab(tab,true);
}

// ── Metrics ───────────────────────────────────────────
function getVals(ins,name){ if(!ins||!ins.data) return []; const it=ins.data.find(d=>d.name===name); return (it&&it.values)||[]; }
function getTotal(ins,name){
  if(!ins||!ins.data) return 0;
  const it=ins.data.find(d=>d.name===name);
  if(it&&it.total_value&&it.total_value.value!==undefined) return it.total_value.value;
  return ((it&&it.values)||[]).reduce((a,v)=>a+(v.value||0),0);
}

function igM(){
  const reach=getVals(s.igIns,'reach'), fc=getVals(s.igIns,'follower_count');
  const tl=s.igPosts.reduce((a,p)=>a+(p.like_count||0),0);
  const tc=s.igPosts.reduce((a,p)=>a+(p.comments_count||0),0);
  return {
    totalReach:reach.reduce((a,v)=>a+(v.value||0),0),
    peakReach:Math.max(0,...reach.map(v=>v.value||0)),
    tl, tc, totalEng:tl+tc,
    newFol:fc.reduce((a,v)=>a+(v.value||0),0),
    profViews:getTotal(s.igIns,'profile_views'),
    webClicks:getTotal(s.igIns,'website_clicks'),
    accsEng:getTotal(s.igIns,'accounts_engaged'),
    reachByDay:reach, folByDay:fc,
  };
}

function fbM(){
  const eng=getVals(s.fbIns,'page_post_engagements'), views=getVals(s.fbIns,'page_views_total');
  return {
    totalEng:eng.reduce((a,v)=>a+(v.value||0),0),
    peakEng:Math.max(0,...eng.map(v=>v.value||0)),
    pageViews:views.reduce((a,v)=>a+(v.value||0),0),
    totalReach:getTotal(s.fbIns,'page_impressions_unique'),
    newFans:getTotal(s.fbIns,'page_fan_adds'),
    posts:s.fbPosts.length,
    tl:s.fbPosts.reduce((a,p)=>a+((p.likes&&p.likes.summary&&p.likes.summary.total_count)||0),0),
    tc:s.fbPosts.reduce((a,p)=>a+((p.comments&&p.comments.summary&&p.comments.summary.total_count)||0),0),
    ts:s.fbPosts.reduce((a,p)=>a+((p.shares&&p.shares.count)||0),0),
    engByDay:eng, viewsByDay:views,
  };
}

function matched(){
  return s.igPosts.map(ig=>{
    const cap=(ig.caption||'').substring(0,50).toLowerCase().trim();
    const fb=s.fbPosts.find(f=>{
      const mc=(f.message||'').substring(0,50).toLowerCase().trim();
      return cap.length>15&&mc.length>15&&cap===mc;
    })||null;
    const iE=(ig.like_count||0)+(ig.comments_count||0);
    const fE=fb?((fb.likes&&fb.likes.summary&&fb.likes.summary.total_count)||0)+((fb.comments&&fb.comments.summary&&fb.comments.summary.total_count)||0)+((fb.shares&&fb.shares.count)||0):0;
    return {ig,fb,iE,fE,score:iE+fE};
  }).sort((a,b)=>b.score-a.score);
}

// ── MoM helpers ──────────────────────────────────────
function prevM(){
  if(!sp) return null;
  const gV=(ins,name)=>(ins&&ins.data?((ins.data.find(d=>d.name===name)||{}).values||[]):[]);
  const gT=(ins,name)=>{
    if(!ins||!ins.data) return 0;
    const it=ins.data.find(d=>d.name===name);
    if(it&&it.total_value&&it.total_value.value!==undefined) return it.total_value.value;
    return ((it&&it.values)||[]).reduce((a,v)=>a+(v.value||0),0);
  };
  const igR=gV(sp.igIns,'reach').reduce((a,v)=>a+(v.value||0),0);
  const igFc=gV(sp.igIns,'follower_count').reduce((a,v)=>a+(v.value||0),0);
  const igLk=(sp.igPosts||[]).reduce((a,p)=>a+(p.like_count||0),0);
  const igCm=(sp.igPosts||[]).reduce((a,p)=>a+(p.comments_count||0),0);
  const fbEng=gV(sp.fbIns,'page_post_engagements').reduce((a,v)=>a+(v.value||0),0);
  const fbViews=gV(sp.fbIns,'page_views_total').reduce((a,v)=>a+(v.value||0),0);
  const fbReach=gT(sp.fbIns,'page_impressions_unique');
  const fbNewFans=gT(sp.fbIns,'page_fan_adds');
  return {
    igReach:igR, igEng:igLk+igCm, igNewFol:igFc,
    igProfViews:gT(sp.igIns,'profile_views'),
    igWebClicks:gT(sp.igIns,'website_clicks'),
    igAccsEng:gT(sp.igIns,'accounts_engaged'),
    fbEng, fbViews, fbReach, fbNewFans,
    fbLikes:(sp.fbPosts||[]).reduce((a,p)=>a+((p.likes&&p.likes.summary&&p.likes.summary.total_count)||0),0),
    igPosts:(sp.igPosts||[]).length, fbPosts:(sp.fbPosts||[]).length,
  };
}

function momBadge(curr,prev){
  if(prev==null||!sp) return '';
  const pct=prev===0?(curr>0?100:0):Math.round(((curr-prev)/Math.abs(prev))*100);
  if(Math.abs(pct)<2) return '<span class="mom mom-flat">→ 0%</span>';
  return pct>0?`<span class="mom mom-up">↑ ${pct}%</span>`:`<span class="mom mom-dn">↓ ${Math.abs(pct)}%</span>`;
}

// Plain-text version of momBadge for use inside prose (the executive summary),
// where an HTML pill doesn't fit.
function momPhrase(curr,prev){
  if(prev==null||!sp) return '';
  const pct=prev===0?(curr>0?100:0):Math.round(((curr-prev)/Math.abs(prev))*100);
  if(Math.abs(pct)<2) return ' (flat vs last period)';
  return pct>0?` (up ${pct}% vs last period)`:` (down ${Math.abs(pct)}% vs last period)`;
}

// A KPI tile label with an optional hover tooltip explaining the metric --
// for numbers that aren't self-explanatory to a non-marketer reading this.
function klbl(text,tip){
  return tip?`<div class="kl">${text} <span class="kl-info" title="${tip.replace(/"/g,'&quot;')}">ⓘ</span></div>`:`<div class="kl">${text}</div>`;
}

// ── Type labels ───────────────────────────────────────
function igType(t){ if(t==='VIDEO') return '▶ REEL'; if(t==='CAROUSEL_ALBUM') return '⊞ CAROUSEL'; return '▢ IMAGE'; }
function fbType(p){ const t=p.attachments&&p.attachments.data&&p.attachments.data[0]&&p.attachments.data[0].media_type; if(t==='album') return '⊞ CAROUSEL'; if(t==='video_inline'||t==='video') return '▶ VIDEO'; return '▢ POST'; }

// ── Image rendering ───────────────────────────────────
// Real browser, real CDN URLs -- no artifact-sandbox CSP to work around.
// Meta's signed CDN URLs expire after a while, so fall back to a placeholder
// on load failure instead of showing a broken-image icon.
function imgTag(url, cls, placeholderCls, placeholderEmoji){
  if(!url) return `<div class="${placeholderCls}">${placeholderEmoji}</div>`;
  const safeUrl=url.replace(/"/g,'&quot;');
  return `<img class="${cls}" src="${safeUrl}" alt="" loading="lazy" `+
    `onerror="this.outerHTML='<div class=&quot;${placeholderCls}&quot;>${placeholderEmoji}</div>'">`;
}

function chartLabels(vals){ return vals.map(v=>{ const d=new Date(v.end_time); return `${d.getMonth()+1}/${d.getDate()}`; }); }

function dc(id){ if(charts[id]){ charts[id].destroy(); delete charts[id]; } }

// ── RENDER ALL ────────────────────────────────────────
function renderAll(){ renderOV(); renderIG(); renderFB(); renderInsights(); }

// ── CALENDAR NAV ──────────────────────────────────────
function calNav(dir){
  window._calMonthIdx=(window._calMonthIdx||0)+dir;
  const c=document.getElementById('cal-container');
  if(c) c.innerHTML=renderPostCalendar();
}

// ── OVERVIEW ──────────────────────────────────────────
function renderPostCalendar(){
  try{
    const MONTH_NAMES=MOS, DAY_NAMES=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const allPosts=[];
    (s.igPosts||[]).forEach(p=>{
      const d=new Date(p.timestamp);
      if(isNaN(d.getTime())) return;
      allPosts.push({date:d,ds:d.toISOString().split('T')[0],platform:'ig',
        thumb:p.thumbnail_url||p.media_url||null,url:p.permalink||'',
        title:(p.caption||'').replace(/[\n\r]/g,' ').substring(0,45)||'IG Post'});
    });
    (s.fbPosts||[]).forEach(p=>{
      const d=new Date(p.created_time);
      if(isNaN(d.getTime())) return;
      allPosts.push({date:d,ds:d.toISOString().split('T')[0],platform:'fb',
        thumb:p.full_picture||null,url:p.permalink_url||'',
        title:(p.message||'').replace(/[\n\r]/g,' ').substring(0,45)||'FB Post'});
    });
    // Scheduled-but-not-yet-published posts from GHL's Social Planner, if
    // loaded -- always included regardless of the currently-viewed date
    // range, since "what's coming up" is a fixed window, not tied to
    // whatever historical period is being browsed. One entry per platform
    // a post is scheduled to, matching how a cross-posted IG+FB item
    // already shows as two separate published entries above.
    if(UPCOMING_DATA&&UPCOMING_DATA.available&&UPCOMING_DATA.upcoming){
      UPCOMING_DATA.upcoming.forEach(p=>{
        const d=new Date(p.scheduleDate);
        if(isNaN(d.getTime())) return;
        const ds=d.toISOString().split('T')[0];
        const title=(p.caption||'').replace(/[\n\r]/g,' ').substring(0,45)||'Scheduled post';
        if(p.instagram) allPosts.push({date:d,ds,platform:'ig',thumb:p.mediaUrl||null,url:'',title,upcoming:true});
        if(p.facebook) allPosts.push({date:d,ds,platform:'fb',thumb:p.mediaUrl||null,url:'',title,upcoming:true});
      });
    }
    if(!allPosts.length) return '<div class="nd" style="padding:16px;">No posts this period.</div>';
    const byDate={};
    allPosts.forEach(p=>{ if(!byDate[p.ds]) byDate[p.ds]=[]; byDate[p.ds].push(p); });
    const months={};
    Object.keys(byDate).forEach(ds=>{
      const d=new Date(ds+'T12:00:00');
      const key=d.getFullYear()+'-'+String(d.getMonth()).padStart(2,'0');
      if(!months[key]) months[key]={year:d.getFullYear(),month:d.getMonth()};
    });
    const monthKeys=Object.keys(months).sort();
    if(!monthKeys.length) return '<div class="nd" style="padding:16px;">No posts this period.</div>';
    if(window._calMonthIdx===undefined||window._calMonthIdx<0||window._calMonthIdx>=monthKeys.length){
      // Default to the current calendar month if it's in range (so adding
      // future "upcoming" months doesn't change what opens by default),
      // otherwise fall back to the most recent month with content.
      const now=new Date();
      const todayKey=now.getFullYear()+'-'+String(now.getMonth()).padStart(2,'0');
      const todayIdx=monthKeys.indexOf(todayKey);
      window._calMonthIdx=todayIdx>=0?todayIdx:monthKeys.length-1;
    }
    const mk=monthKeys[window._calMonthIdx];
    const m=months[mk], year=m.year, month=m.month;
    const firstDow=new Date(year,month,1).getDay();
    const totalDays=new Date(year,month+1,0).getDate();
    const todayStr=new Date().toISOString().split('T')[0];
    let cells='';
    for(let i=0;i<firstDow;i++) cells+='<div class="cal-empty"></div>';
    for(let day=1;day<=totalDays;day++){
      const ds=year+'-'+String(month+1).padStart(2,'0')+'-'+String(day).padStart(2,'0');
      const posts=byDate[ds]||[];
      const isToday=ds===todayStr;
      let thumbs='';
      posts.slice(0,4).forEach(p=>{
        const platIcon=p.platform==='ig'?'<span class="cal-plat ig-plat">IG</span>':'<span class="cal-plat fb-plat">FB</span>';
        let inner;
        if(p.thumb){
          const safeSrc=p.thumb.replace(/"/g,'&quot;');
          inner=`<img src="${safeSrc}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:2px;" onerror="this.outerHTML='<div class=&quot;cal-ph&quot;>${p.platform==='ig'?'📷':'👍'}</div>'">`;
        } else {
          inner=`<div class="cal-ph">${p.platform==='ig'?'📷':'👍'}</div>`;
        }
        const safeTitle=p.title.replace(/"/g,'&quot;');
        if(p.upcoming){
          // Nothing to link to yet -- it hasn't published -- so this is a
          // plain, non-clickable div with a dashed border and a scheduled
          // badge instead of the usual platform-only badge.
          thumbs+=`<div class="cal-thumb-wrap upcoming" title="${safeTitle} (scheduled)">${inner}${platIcon}<span class="cal-upcoming-badge">📅</span></div>`;
        } else {
          const safeUrl=(p.url||'#').replace(/"/g,'&quot;');
          // A real <a href target="_blank"> here, not a JS window.open() --
          // Facebook/Instagram appear to treat JS-triggered popup navigation
          // as suspicious and show a "log in to see this" wall, while a
          // genuine link click (as used everywhere else in this dashboard)
          // goes through fine.
          thumbs+=`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="cal-thumb-wrap" onclick="event.stopPropagation()" title="${safeTitle}">${inner}${platIcon}</a>`;
        }
      });
      if(posts.length>4) thumbs+='<div class="cal-more">+'+(posts.length-4)+'</div>';
      let titleRow='';
      if(posts.length===1){
        const esc=posts[0].title.replace(/</g,'&lt;').replace(/>/g,'&gt;');
        titleRow='<div class="cal-title">'+esc+'</div>';
      } else if(posts.length>1){
        titleRow='<div class="cal-title">'+posts.length+' posts</div>';
      }
      const allUpcoming=posts.length>0&&posts.every(p=>p.upcoming);
      cells+='<div class="cal-day'+(posts.length?' has-post':'')+(allUpcoming?' has-upcoming':'')+(isToday?' cal-today':'')+'">'+
        '<div class="cal-dn">'+day+'</div>'+
        (thumbs?'<div class="cal-thumbs">'+thumbs+'</div>':'')+
        titleRow+'</div>';
    }
    const hdr=DAY_NAMES.map(d=>'<div class="cal-dh">'+d+'</div>').join('');
    const canPrev=window._calMonthIdx>0;
    const canNext=window._calMonthIdx<monthKeys.length-1;
    const prevBtn=canPrev?'<button class="cal-nav-btn" onclick="calNav(-1)">&#8249;</button>':'<button class="cal-nav-btn" disabled>&#8249;</button>';
    const nextBtn=canNext?'<button class="cal-nav-btn" onclick="calNav(1)">&#8250;</button>':'<button class="cal-nav-btn" disabled>&#8250;</button>';
    const nav='<div class="cal-nav">'+prevBtn+'<span class="cal-nav-label">'+MONTH_NAMES[month]+' '+year+'</span>'+nextBtn+'</div>';
    return nav+'<div class="cal-grid">'+hdr+cells+'</div>';
  }catch(e){
    console.error('renderPostCalendar error:',e);
    return '<div class="nd" style="padding:16px;color:#B3362A;">Calendar error: '+e.message+'</div>';
  }
}

function renderOV(){
  const ig=igM(), fb=fbM(), top5=matched().slice(0,5), pm=prevM();
  const vc=s.igPosts.filter(p=>p.media_type==='VIDEO').length;
  const cc=s.igPosts.filter(p=>p.media_type==='CAROUSEL_ALBUM').length;
  const ic=s.igPosts.filter(p=>p.media_type==='IMAGE').length;
  const reachEff=ig.totalReach>0?((ig.totalEng/ig.totalReach)*100).toFixed(1):0;
  const ctr=ig.profViews>0?((ig.webClicks/ig.profViews)*100).toFixed(1):0;
  const vAvg=vc>0?(s.igPosts.filter(p=>p.media_type==='VIDEO').reduce((a,p)=>a+(p.like_count||0),0)/vc).toFixed(1):0;
  const cAvg=cc>0?(s.igPosts.filter(p=>p.media_type==='CAROUSEL_ALBUM').reduce((a,p)=>a+(p.like_count||0),0)/cc).toFixed(1):0;
  const totalPosts=s.igPosts.length+s.fbPosts.length;

  const tp=top5[0];
  const tpImgUrl=tp?(tp.ig.thumbnail_url||tp.ig.media_url||''):'';
  const spotlight=tp?`
    <div class="spotlight">
      <div class="sp-img-wrap">
        <a href="${tp.ig.permalink}" target="_blank" rel="noopener" style="display:block;position:relative;text-decoration:none;">
        ${tpImgUrl?`<img class="sp-img" src="${tpImgUrl.replace(/"/g,'&quot;')}" alt="" onerror="this.outerHTML='<div class=&quot;sp-ph&quot;>🏠</div>'">`:`<div class="sp-ph">🏠</div>`}
        <div class="sp-hover-ov">View Post ↗</div>
        </a>
        <div class="sp-badge">🏆 #1 This Month</div>
        <div class="sp-ftype">${tp.ig.media_type==='VIDEO'?'▶ REEL':tp.ig.media_type==='CAROUSEL_ALBUM'?'⊞ CAROUSEL':'▢ IMAGE'}</div>
      </div>
      <div class="sp-body">
        <div class="sp-label">Best Performing Post · ${getPeriod()}</div>
        <div class="sp-caption">"${(tp.ig.caption||'').split(String.fromCharCode(10)).join(' ').substring(0,180).replace(/"/g,'&quot;')}…"</div>
        <div class="sp-metrics">
          <div class="sp-m"><span class="sp-mv">${tp.ig.like_count||0}</span><span class="sp-ml">IG Likes</span></div>
          <div class="sp-m"><span class="sp-mv">${tp.ig.comments_count||0}</span><span class="sp-ml">Comments</span></div>
          <div class="sp-m"><span class="sp-mv">${tp.iE}</span><span class="sp-ml">IG Total</span></div>
          ${tp.fb?`<div class="sp-m"><span class="sp-mv">${tp.fE}</span><span class="sp-ml">FB Total</span></div>`:''}
          <div class="sp-m"><span class="sp-mv">${tp.score}</span><span class="sp-ml">Combined</span></div>
        </div>
        <div class="sp-foot">
          <span class="sp-meta">${igType(tp.ig.media_type)} · ${fmtDate(tp.ig.timestamp)}</span>
          <a class="sp-link" href="${tp.ig.permalink}" target="_blank" rel="noopener">View Post ↗</a>
        </div>
      </div>
    </div>`:'';

  document.getElementById('tab-overview').innerHTML = `
    ${renderLiveBar()}
    <div class="exec-summary">${buildExecutiveSummary()}</div>
    <div class="sec" id="upcoming-sec" style="display:none;">🗓️ Upcoming Posts <span class="pill" style="background:#243447;color:#fff;font-size:10px;">Next 60 Days · GHL</span></div>
    <div id="upcoming-container"></div>
    <div class="sec">🏆 Top Post Spotlight</div>
    ${spotlight||'<div class="nd" style="margin-bottom:18px">No posts found — navigate to a month with content.</div>'}
    <div class="sec" style="margin-top:24px;">📅 Content Calendar <span class="pill" style="background:#182433;color:#fff;font-size:10px;">IG + FB</span></div>
    <div class="cal-wrap"><div id="cal-container">${renderPostCalendar()}</div></div>
    <div class="sec">Combined Performance <span class="pill p-live">LIVE</span></div>
    <div class="kg g5">
      <div class="kpi hi">${klbl('IG Reach','Unique Instagram accounts that saw at least one of your posts this period.')}<div class="kv">${ig.totalReach.toLocaleString()}${momBadge(ig.totalReach,pm&&pm.igReach)}</div><div class="ks">unique accounts</div></div>
      <div class="kpi"><div class="kl">IG Engagements</div><div class="kv">${ig.totalEng.toLocaleString()}${momBadge(ig.totalEng,pm&&pm.igEng)}</div><div class="ks">${ig.tl} likes · ${ig.tc} cmts</div></div>
      <div class="kpi fbhi"><div class="kl">FB Engagements</div><div class="kv">${fb.totalEng.toLocaleString()}${momBadge(fb.totalEng,pm&&pm.fbEng)}</div><div class="ks">likes · cmts · shares</div></div>
      <div class="kpi"><div class="kl">Posts Published</div><div class="kv">${totalPosts}${momBadge(totalPosts,pm?(pm.igPosts||0)+(pm.fbPosts||0):null)}</div><div class="ks">${s.igPosts.length} IG · ${s.fbPosts.length} FB</div></div>
      <div class="kpi ${ig.webClicks<3?'bad':ig.webClicks<8?'warn':'good'}">${klbl('Website Clicks','Taps on the link in your Instagram bio.')}<div class="kv">${ig.webClicks}${momBadge(ig.webClicks,pm&&pm.igWebClicks)}</div><div class="ks">${ig.webClicks<3?'⚠ critically low':'from IG bio'}</div></div>
    </div>
    <div class="crow c21">
      <div class="cc"><div class="ct">IG Reach vs FB Engagement</div><div class="cst">Daily comparison — dual axis</div><div class="cw"><canvas id="c-combo"></canvas></div></div>
      <div class="cc"><div class="ct">Content Mix</div><div class="cst">${s.igPosts.length} total · ${vc} Reels · ${cc} Carousels · ${ic} Images</div><div class="cw"><canvas id="c-mix"></canvas></div></div>
    </div>
    <div class="sec">Top 5 Performing Posts <span class="pill p-gold">RANKED BY ENGAGEMENT</span></div>
    <div class="top5">
      ${top5.length===0?'<div class="nd">No posts found for this period.</div>':top5.map((p,i)=>renderT5(p,i)).join('')}
    </div>
    <hr class="div">
    <div class="sec">Analytics &amp; Insights</div>
    <div class="twg">${renderTW(ig,fb,{reachEff,ctr,vAvg,cAvg,top5}).join('')}</div>
  `;
  loadUpcoming();
}

function renderT5(p, i){
  const thumb=p.ig.thumbnail_url||p.ig.media_url||'';
  const fL=(p.fb&&p.fb.likes&&p.fb.likes.summary&&p.fb.likes.summary.total_count)||0;
  const fC=(p.fb&&p.fb.comments&&p.fb.comments.summary&&p.fb.comments.summary.total_count)||0;
  const fS=(p.fb&&p.fb.shares&&p.fb.shares.count)||0;
  const rc=i<3?` r${i+1}`:'';
  const rk=i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}`;
  const maxScore=matched().slice(0,5).reduce((m,x)=>Math.max(m,x.score),1);
  const barPct=Math.round(p.score/maxScore*100);
  return `
    <div class="t5c${rc}" onclick="window.open('${p.ig.permalink}','_blank')">
      <div class="t5iw">
        ${imgTag(thumb,'t5img','t5ph','🏠')}
        <div class="t5img-ov">View Post ↗</div>
        <div class="t5pbar" style="transform:scaleX(${barPct/100})"></div>
        <div class="t5rk">${rk}</div>
        <span class="t5typ">${igType(p.ig.media_type)}</span>
        <span class="t5dt">${fmtDate(p.ig.timestamp)}</span>
      </div>
      <div class="t5bd">
        <div class="t5cp">${(p.ig.caption||'No caption').replace(/\n/g,' ')}</div>
        <div class="t5st">
          <div class="t5s ig">❤️ <strong>${p.ig.like_count||0}</strong> &nbsp;💬 <strong>${p.ig.comments_count||0}</strong> &nbsp;<span style="opacity:.5;font-size:10px">IG</span></div>
          ${p.fb
            ? `<div class="t5s fb">👍 <strong>${fL}</strong> &nbsp;${fC?`💬 <strong>${fC}</strong> &nbsp;`:''}${fS?`🔁 <strong>${fS}</strong> &nbsp;`:''}<span style="opacity:.5;font-size:10px">FB</span></div>`
            : ''}
        </div>
        <div class="t5tot">
          <div><div class="t5sv">${p.score}</div><div class="t5sl">total eng.</div></div>
          ${i===0?'<span style="font-size:16px">🏆</span>':i===1?'<span style="font-size:14px;opacity:.7">🥈</span>':i===2?'<span style="font-size:14px;opacity:.7">🥉</span>':''}
        </div>
      </div>
    </div>`;
}

function renderTW(ig, fb, opts){
  const {reachEff,ctr,vAvg,cAvg,top5}=opts;
  const tp=top5[0];
  const fCv=ig.totalReach>0?((ig.newFol/ig.totalReach)*100).toFixed(2):0;
  const fbWins=fb.totalEng>ig.totalEng;
  const ppw=(s.igPosts.length/(view==='week'?1:4.3)).toFixed(1);
  return [
    {t:'gold',i:'🏆',tag:'Top Performer',b:tp?`"${(tp.ig.caption||'').substring(0,55).replace(/\n/g,' ')}…" earned <strong>${tp.score} combined engagements</strong>. ${tp.ig.media_type==='VIDEO'?'Client story videos are your strongest format — they build trust and reach simultaneously.':'Carousel content is leading this period — multi-slide education works for your audience.'}`:'Post more content to identify top performers.'},
    {t:'info',i:'📊',tag:'Engagement Rate',b:`IG engagement rate: <strong>${reachEff}%</strong> (${ig.totalEng} eng / ${ig.totalReach.toLocaleString()} reach). Luxury builder benchmark: 2–4%. FB generated <strong>${fb.totalEng} total engagements</strong> — ${fbWins?'<strong>Facebook is currently your higher-engagement platform.</strong> Don\'t neglect it.':'Instagram is your stronger engagement platform this period.'}`},
    {t:+vAvg>+cAvg?'win':'info',i:'🎬',tag:'Video vs Carousel',b:`Reels average <strong>${vAvg} IG likes</strong> vs ${cAvg} for carousels. ${+vAvg>+cAvg?`Video outperforms carousels by ${Math.round((+vAvg/Math.max(+cAvg,.1)-1)*100)}%. Prioritize Reels — they drive reach and follows.`:'Carousels are outperforming Reels this period. Your audience responds to multi-image content — lean into project showcases and before/afters.'}`},
    {t:ig.webClicks<3?'alert':ig.webClicks<8?'warn':'win',i:'🔗',tag:'Website CTR',b:`<strong>${ig.webClicks} website click${ig.webClicks!==1?'s':''}</strong> from <strong>${ig.profViews} profile views</strong> = ${ctr}% CTR. ${ig.webClicks<5?'<strong>⚠ This is critically low.</strong> Fix immediately: change bio CTA to "DM BUILD for a free consult" and link directly to a consultation booking page — not the homepage.':'Profile-to-site conversion is solid.'}`},
    {t:ig.newFol<5?'warn':'win',i:'👥',tag:'Follower Growth',b:`<strong>${ig.newFol} new follower${ig.newFol!==1?'s':''}</strong> from ${ig.totalReach.toLocaleString()} accounts reached = ${fCv}% follow rate. Luxury builder avg: 0.5–1%. ${ig.newFol<5?'To grow faster: add a follow CTA in the first 3 seconds of every Reel, engage with comments within the first hour of every post, and use location-specific hashtags.':'Growth is solid — stay consistent.'}`},
    {t:+ppw>=3?'win':'warn',i:'📅',tag:'Posting Cadence',b:`${s.igPosts.length} posts this period = <strong>${ppw}/week</strong>. ${+ppw>=3?'Good frequency. The algorithm rewards consistency — posting gaps cause reach drops that take weeks to recover.':'⚠ Target 3–4 posts/week: 1–2 Reels, 1–2 carousels. Even a simple phone photo with a great caption beats going silent.'}`},
    {t:'info',i:'📈',tag:'Platform Comparison',b:`FB: <strong>${fb.totalEng} engagements, ${fb.pageViews} page views</strong>. IG: <strong>${ig.totalEng} engagements, ${ig.totalReach.toLocaleString()} reach</strong>. ${fbWins?'Facebook is your engagement leader right now — your existing audience is active there. Post longer captions and use Facebook-specific features like polls and community posts.':'Instagram is winning on engagement, but FB page views ('+fb.pageViews+') show people are still checking your page.'}`},
    {t:'gold',i:'🏷️',tag:'Hashtag Strategy',b:`Current strategy: 15–20 hashtags per post. Test cutting to 5–8 hyper-local tags: <em>#CharlestonCustomHome, #KiawahIslandBuilder, #LowcountryLuxury, #CharlestonArchitecture, #SCCustomHomes</em>. Niche hashtags reach actual buyers — broad ones reach other builders who won't hire you.`},
    {t:'win',i:'💡',tag:'Action Items',b:`<strong>1.</strong> Fix bio link → direct booking page, change CTA to "DM BUILD." <strong>2.</strong> Film 1 client story Reel/week. <strong>3.</strong> Location-tag every post (Charleston · Kiawah · James Island). <strong>4.</strong> Reply to every comment within 60 min of posting. <strong>5.</strong> Post to both FB and IG within 24hrs of each piece of content.`},
  ].map(tw=>`
    <div class="tw ${tw.t}">
      <div class="twi">${tw.i}</div>
      <div class="twt">${tw.tag}</div>
      <div class="twb">${tw.b}</div>
    </div>`);
}

// ── INSTAGRAM ─────────────────────────────────────────
function renderIG(){
  const ig=igM(), pm=prevM();
  document.getElementById('tab-ig').innerHTML = `
    ${renderLiveBar()}
    <div class="sec">Instagram Performance <span class="pill p-ig">IG</span></div>
    <div class="kg g5">
      <div class="kpi hi">${klbl('Total Reach','Unique Instagram accounts that saw at least one of your posts this period.')}<div class="kv">${ig.totalReach.toLocaleString()}${momBadge(ig.totalReach,pm&&pm.igReach)}</div><div class="ks">unique accounts</div></div>
      <div class="kpi">${klbl('Accts Engaged','Accounts that liked, commented on, saved, or shared your content.')}<div class="kv">${ig.accsEng}${momBadge(ig.accsEng,pm&&pm.igAccsEng)}</div><div class="ks">interacted w/ content</div></div>
      <div class="kpi good">${klbl('New Followers','Net new Instagram followers gained this period.')}<div class="kv">${ig.newFol}${momBadge(ig.newFol,pm&&pm.igNewFol)}</div><div class="ks">organic growth</div></div>
      <div class="kpi">${klbl('Profile Views','Visits to your Instagram profile page.')}<div class="kv">${ig.profViews}${momBadge(ig.profViews,pm&&pm.igProfViews)}</div><div class="ks">bio visits</div></div>
      <div class="kpi ${ig.webClicks<3?'bad':ig.webClicks<8?'warn':''}">${klbl('Website Clicks','Taps on the link in your Instagram bio.')}<div class="kv">${ig.webClicks}${momBadge(ig.webClicks,pm&&pm.igWebClicks)}</div><div class="ks">${ig.webClicks<3?'⚠ update bio CTA':'bio link taps'}</div></div>
    </div>
    <div class="crow c11">
      <div class="cc"><div class="ct">Daily Reach</div><div class="cst">Unique accounts reached per day</div><div class="cw"><canvas id="c-ig-reach"></canvas></div></div>
      <div class="cc"><div class="ct">Daily Follower Growth</div><div class="cst">New followers gained per day</div><div class="cw"><canvas id="c-ig-fc"></canvas></div></div>
    </div>
    ${renderIGTopPerformers()}`;
}

function renderIGTopPerformers(){
  function engIG(p){ return (p.like_count||0)+(p.comments_count||0); }
  const allSorted=[...s.igPosts].sort((a,b)=>engIG(b)-engIG(a));
  const ref=s.igPosts.length?s.igPosts.reduce((m,p)=>new Date(p.timestamp)>new Date(m.timestamp)?p:m):null;
  const weekAgo=ref?new Date(new Date(ref.timestamp).getTime()-7*864e5):new Date(0);
  const weekTop=[...s.igPosts].filter(p=>new Date(p.timestamp)>=weekAgo).sort((a,b)=>engIG(b)-engIG(a)).slice(0,3);
  const monthTop=allSorted.slice(0,3);
  function tpSet(posts,label){
    if(!posts.length) return '<div class="nd">No posts in this period.</div>';
    return '<div class="tp-label">'+label+'</div><div class="pgrid">'+posts.map((p,i)=>renderIGPost(p,i+1)).join('')+'</div>';
  }
  const allGrid=s.igPosts.length===0?'<div class="nd">No posts.</div>':s.igPosts.map(p=>renderIGPost(p)).join('');
  return '<div class="sec">🏆 Top Performers <span class="pill p-ig">IG</span></div>'+
    tpSet(weekTop,'📅 This Week')+
    tpSet(monthTop,'📆 This Month')+
    '<details style="margin-top:12px;"><summary style="font-size:12px;color:#6B6F73;cursor:pointer;user-select:none;">▾ All Posts This Period ('+s.igPosts.length+')</summary>'+
    '<div class="pgrid" style="margin-top:8px;">'+allGrid+'</div></details>';
}
function renderIGPost(p, rank){
  const th=p.thumbnail_url||p.media_url||'';
  const maxE=Math.max(1,...s.igPosts.map(x=>(x.like_count||0)+(x.comments_count||0)));
  const pct=Math.round(((p.like_count||0)+(p.comments_count||0))/maxE*100);
  const rb=rank?`<span class="rank-badge r${rank}">#${rank}${rank===1?' 🏆':rank===2?' 🥈':rank===3?' 🥉':''}</span>`:'';
  return `
    <div class="pc" onclick="window.open('${p.permalink}','_blank')">
      <div class="piw">
        ${rb}
        ${imgTag(th,'pimg','pph','🏠')}
        <span class="ptyp">${igType(p.media_type)}</span>
        <span class="pdt">${fmtDate(p.timestamp)}</span>
        <div class="pbar" style="transform:scaleX(${pct/100})"></div>
      </div>
      <div class="pb">
        <div class="pcap">${(p.caption||'No caption').replace(/\n/g,' ')}</div>
        <div class="pmets">
          <span class="pm ig"><strong>${p.like_count||0}</strong> likes</span>
          <span class="pm ig"><strong>${p.comments_count||0}</strong> cmts</span>
        </div>
        <a href="${p.permalink}" target="_blank" onclick="event.stopPropagation()" class="view-post-link">View Post →</a>
      </div>
    </div>`;
}

// ── FACEBOOK ──────────────────────────────────────────
function renderFB(){
  const fb=fbM(), pm=prevM();
  document.getElementById('tab-fb').innerHTML = `
    ${renderLiveBar()}
    <div class="sec">Facebook Performance <span class="pill p-fb">FB</span></div>
    <div class="kg g5">
      <div class="kpi fbhi">${klbl('Total Reach','Unique people who saw any of your Facebook Page’s posts.')}<div class="kv">${fb.totalReach.toLocaleString()}${momBadge(fb.totalReach,pm&&pm.fbReach)}</div><div class="ks">unique people</div></div>
      <div class="kpi fbhi">${klbl('Total Engagements','Likes, comments, and shares across your Facebook posts.')}<div class="kv">${fb.totalEng.toLocaleString()}${momBadge(fb.totalEng,pm&&pm.fbEng)}</div><div class="ks">peak day ${fb.peakEng}</div></div>
      <div class="kpi good">${klbl('New Page Likes','Net new people who liked/followed your Facebook Page this period.')}<div class="kv">${fb.newFans}${momBadge(fb.newFans,pm&&pm.fbNewFans)}</div><div class="ks">organic growth</div></div>
      <div class="kpi">${klbl('Page Views','Visits to your Facebook Page.')}<div class="kv">${fb.pageViews}${momBadge(fb.pageViews,pm&&pm.fbViews)}</div><div class="ks">total this period</div></div>
      <div class="kpi"><div class="kl">Posts</div><div class="kv">${fb.posts}${momBadge(fb.posts,pm&&pm.fbPosts)}</div><div class="ks">${fb.tl} likes · ${fb.ts} shares</div></div>
    </div>
    <div class="crow c11">
      <div class="cc"><div class="ct">Daily Post Engagements</div><div class="cst">Total engagement actions per day</div><div class="cw"><canvas id="c-fb-eng"></canvas></div></div>
      <div class="cc"><div class="ct">Daily Page Views</div><div class="cst">Total visits to the Facebook Page</div><div class="cw"><canvas id="c-fb-views"></canvas></div></div>
    </div>
    ${renderFBTopPerformers()}`;
}

function renderFBTopPerformers(){
  function engFB(p){ return ((p.likes&&p.likes.summary&&p.likes.summary.total_count)||0)+((p.comments&&p.comments.summary&&p.comments.summary.total_count)||0)+((p.shares&&p.shares.count)||0); }
  const allSorted=[...s.fbPosts].sort((a,b)=>engFB(b)-engFB(a));
  const ref=s.fbPosts.length?s.fbPosts.reduce((m,p)=>new Date(p.created_time)>new Date(m.created_time)?p:m):null;
  const weekAgo=ref?new Date(new Date(ref.created_time).getTime()-7*864e5):new Date(0);
  const weekTop=[...s.fbPosts].filter(p=>new Date(p.created_time)>=weekAgo).sort((a,b)=>engFB(b)-engFB(a)).slice(0,3);
  const monthTop=allSorted.slice(0,3);
  function tpSet(posts,label){
    if(!posts.length) return '<div class="nd">No posts in this period.</div>';
    return '<div class="tp-label">'+label+'</div><div class="pgrid">'+posts.map((p,i)=>renderFBPost(p,i+1)).join('')+'</div>';
  }
  const allGrid=s.fbPosts.length===0?'<div class="nd">No posts.</div>':s.fbPosts.map(p=>renderFBPost(p)).join('');
  return '<div class="sec">🏆 Top Performers <span class="pill p-fb">FB</span></div>'+
    tpSet(weekTop,'📅 This Week')+
    tpSet(monthTop,'📆 This Month')+
    '<details style="margin-top:12px;"><summary style="font-size:12px;color:#6B6F73;cursor:pointer;user-select:none;">▾ All Posts This Period ('+s.fbPosts.length+')</summary>'+
    '<div class="pgrid" style="margin-top:8px;">'+allGrid+'</div></details>';
}
function renderFBPost(p, rank){
  const th=p.full_picture||'';
  const l=(p.likes&&p.likes.summary&&p.likes.summary.total_count)||0;
  const c=(p.comments&&p.comments.summary&&p.comments.summary.total_count)||0;
  const sh=(p.shares&&p.shares.count)||0;
  const maxE=Math.max(1,...s.fbPosts.map(x=>((x.likes&&x.likes.summary&&x.likes.summary.total_count)||0)+((x.comments&&x.comments.summary&&x.comments.summary.total_count)||0)+((x.shares&&x.shares.count)||0)));
  const pct=Math.round((l+c+sh)/maxE*100);
  const rb=rank?`<span class="rank-badge r${rank}">#${rank}${rank===1?' 🏆':rank===2?' 🥈':rank===3?' 🥉':''}</span>`:'';
  return `
    <div class="pc" onclick="window.open('${p.permalink_url}','_blank')">
      <div class="piw">
        ${rb}
        ${imgTag(th,'pimg','pph','🏠')}
        <span class="ptyp">${fbType(p)}</span>
        <span class="pdt">${fmtDate(p.created_time)}</span>
        <div class="pbar" style="transform:scaleX(${pct/100});background:#1877F2"></div>
      </div>
      <div class="pb">
        <div class="pcap">${(p.message||'No caption').replace(/\n/g,' ')}</div>
        <div class="pmets">
          <span class="pm fb"><strong>${l}</strong> likes</span>
          <span class="pm fb"><strong>${c}</strong> cmts</span>
          ${sh?`<span class="pm fb"><strong>${sh}</strong> shares</span>`:''}
        </div>
        <a href="${p.permalink_url}" target="_blank" onclick="event.stopPropagation()" class="view-post-link">View Post →</a>
      </div>
    </div>`;
}

// ── INSIGHTS HELPERS ─────────────────────────────────
function calcContentROI(){
  const types=[
    {key:'CAROUSEL_ALBUM',label:'Carousel',emoji:'⊞'},
    {key:'VIDEO',label:'Reel / Video',emoji:'▶'},
    {key:'IMAGE',label:'Image',emoji:'▢'}
  ];
  return types.map(t=>{
    const posts=s.igPosts.filter(p=>p.media_type===t.key);
    const engs=posts.map(p=>(p.like_count||0)+(p.comments_count||0));
    const total=engs.reduce((a,b)=>a+b,0);
    return {label:t.label,emoji:t.emoji,count:posts.length,totalEng:total,
      avgEng:posts.length?Math.round(total/posts.length):0};
  }).filter(t=>t.count>0);
}

function calcBestTimes(){
  const all=[];
  s.igPosts.forEach(p=>{
    const d=new Date(p.timestamp);
    all.push({day:d.getDay(),hour:d.getHours(),eng:(p.like_count||0)+(p.comments_count||0)});
  });
  s.fbPosts.forEach(p=>{
    const d=new Date(p.created_time);
    const e=((p.likes&&p.likes.summary&&p.likes.summary.total_count)||0)+
            ((p.comments&&p.comments.summary&&p.comments.summary.total_count)||0)+
            ((p.shares&&p.shares.count)||0);
    all.push({day:d.getDay(),hour:d.getHours(),eng:e});
  });
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const byDay=days.map((name,i)=>{
    const pts=all.filter(p=>p.day===i);
    const avg=pts.length?Math.round(pts.reduce((sum,p)=>sum+p.eng,0)/pts.length):0;
    return {name,count:pts.length,avgEng:avg};
  });
  return {byDay,all};
}

function buildRuleInsights(){
  const ig=igM(),fb=fbM(),roi=calcContentROI(),times=calcBestTimes();
  const bestDay=times.byDay.filter(d=>d.count>0).sort((a,b)=>b.avgEng-a.avgEng)[0];
  const worstDay=times.byDay.filter(d=>d.count>0).sort((a,b)=>a.avgEng-b.avgEng)[0];
  const busyDay=[...times.byDay].sort((a,b)=>b.count-a.count)[0];
  const engRate=ig.totalReach>0?((ig.accsEng/ig.totalReach)*100).toFixed(1):0;
  const ctr=ig.profViews>0?((ig.webClicks/ig.profViews)*100).toFixed(1):0;
  const roiSorted=[...roi].sort((a,b)=>b.avgEng-a.avgEng);
  const topType=roiSorted[0];
  const botType=roiSorted[roiSorted.length-1];
  const insights=[];

  if(topType&&topType.count>0){
    const lift=botType&&botType.avgEng>0?Math.round((topType.avgEng-botType.avgEng)/botType.avgEng*100):null;
    let s1='<strong>Prioritize '+topType.label+' content</strong> — averaging <strong>'+topType.avgEng+' engagements per post</strong>';
    s1+=lift?' ('+lift+'% more than '+botType.label+' posts).':'.';
    s1+=' You have posted '+topType.count+' of them this period.';
    s1+=lift>30?' Shift budget away from '+botType.label+' posts toward more '+topType.label+' production.':' Keep this as your primary content format.';
    insights.push('<li>'+s1+'</li>');
  }

  if(bestDay){
    let s2='<strong>Post more on '+bestDay.name+'s</strong> — engagement peaks at <strong>'+bestDay.avgEng+' avg per post</strong> that day';
    s2+=worstDay&&worstDay.name!==bestDay.name?' vs. '+worstDay.avgEng+' on '+worstDay.name+'s.':'.';
    s2+=busyDay&&busyDay.name!==bestDay.name?' You currently post most on '+busyDay.name+'s — shifting to '+bestDay.name+' could improve results.'
      :' You are already posting frequently on your best day.';
    insights.push('<li>'+s2+'</li>');
  }

  const er=parseFloat(engRate);
  if(ig.totalReach>0){
    let s3='<strong>'+(er>=2?'Maintain engagement momentum':'Lift engagement rate')+' </strong> — IG rate is <strong>'+engRate+'%</strong> (luxury benchmark: 2-4%). ';
    s3+=er>=4?'Outperforming the benchmark — sustain posting frequency and content quality.'
      :er>=2?'Within range. Push above 4% with interactive captions, carousels, and questions.'
      :'Focus on high-performing content types and add clear calls to action in every caption.';
    insights.push('<li>'+s3+'</li>');
  }

  if(ig.profViews>0){
    let s4='<strong>'+(parseFloat(ctr)>=5?'Bio link converting well':'Improve bio link conversion')+'</strong> — '+ig.webClicks+' of '+ig.profViews+' profile visitors ('+ctr+'%) clicked to the website. ';
    s4+=parseFloat(ctr)<3?'Update your bio link to a high-intent page (consultation booking or portfolio) and add a "Link in bio" CTA in every caption.'
      :'Keep driving traffic with captions that reference the bio link for portfolio tours or consultation booking.';
    insights.push('<li>'+s4+'</li>');
  }

  let s5;
  if(s.fbPosts.length>0){
    s5='<strong>Sync best IG content to Facebook</strong> — '+s.fbPosts.length+' FB posts vs. '+s.igPosts.length+' IG posts this period. ';
    s5+=s.fbPosts.length<s.igPosts.length?'Cross-posting top IG content to FB with minimal effort extends reach to a different homebuyer demographic.'
      :'FB posting pace is solid — adapt IG captions for FB to maximize native engagement.';
  } else {
    s5='<strong>Activate Facebook to extend reach</strong> — no FB posts found this period. Cross-posting IG content to Facebook reaches a different homebuyer demographic with no additional production time. Start by sharing your top 2-3 IG posts.';
  }
  insights.push('<li>'+s5+'</li>');

  return '<ul style="margin:0;padding-left:20px;line-height:1.9;">'+insights.join('')+'</ul>'
    +'<p style="font-size:10px;color:#928C7E;margin-top:12px;border-top:1px solid #EFE9DE;padding-top:8px;">Computed from live data &middot; '+getPeriod()+'</p>';
}

function renderLiveBar(){
  const refreshed=DATA.refreshedAt?fmtRefreshDate(DATA.refreshedAt):'—';
  const btn='<button onclick="loadData()" style="margin-left:auto;background:#0B1F2E;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;">🔄 Reload</button>';
  return '<div class="live-bar" style="display:flex;align-items:center;">✅ '+getPeriod()+' · Refreshed '+refreshed+' · auto-updates every 5 min '+btn+'</div>';
}

// A 2-3 sentence plain-English readout for the top of the Overview tab --
// meant to be readable in the time it takes to open the page, before
// scrolling into any chart. Reuses the same computed metrics as the rest
// of the tab rather than re-deriving anything.
function buildExecutiveSummary(){
  const ig=igM(), fb=fbM(), pm=prevM(), top5=matched().slice(0,5);
  const period=getPeriod();
  if(ig.totalReach===0&&fb.totalEng===0&&s.igPosts.length===0&&s.fbPosts.length===0){
    return `<strong>${period}:</strong> no posts or activity recorded for this period yet.`;
  }
  const tp=top5[0];
  const fbWins=fb.totalEng>ig.totalEng;
  let headline=`<strong>${period} at a glance:</strong> Instagram reached <strong>${ig.totalReach.toLocaleString()} accounts</strong>${momPhrase(ig.totalReach,pm&&pm.igReach)} with <strong>${ig.totalEng.toLocaleString()} engagements</strong>. `;
  headline+=fbWins
    ?`Facebook out-performed IG on engagement this period (<strong>${fb.totalEng.toLocaleString()}</strong> vs ${ig.totalEng.toLocaleString()}). `
    :`Instagram was the stronger engagement platform this period${fb.totalEng>0?` (FB: ${fb.totalEng.toLocaleString()})`:''}. `;
  let action;
  if(ig.webClicks<3&&ig.profViews>0){
    action=`<strong>Priority:</strong> website clicks are critically low (${ig.webClicks} from ${ig.profViews} profile views) — update the IG bio link CTA this week.`;
  } else if(tp){
    action=`<strong>Top performer:</strong> "${(tp.ig.caption||'').substring(0,50).replace(/\n/g,' ')}…" earned ${tp.score} combined engagements — see what made it work below.`;
  } else {
    action=`Keep posting consistently to start building a performance trend here.`;
  }
  return headline+action;
}

// ── GROWTH TREND (last 6 months) ──────────────────────
// Cached for the whole session since it's a fixed "last N months from now"
// window, independent of whatever period the rest of the dashboard is
// navigated to -- redrawn (not re-fetched) every time Insights re-renders,
// since renderInsights() rebuilds the canvas elements from scratch each load.
async function loadTrend(){
  const container=document.getElementById('trend-container');
  if(!container) return;
  if(TREND_DATA){ renderTrendCharts(); return; }
  try{
    const resp=await fetch('/api/trend?months=6');
    const body=await resp.json().catch(()=>null);
    if(!resp.ok||!body||!body.trend){
      container.innerHTML='<div class="nd">Growth trend unavailable'+(body&&body.error?': '+body.error:'')+'.</div>';
      return;
    }
    TREND_DATA=body.trend;
    renderTrendCharts();
  }catch(err){
    container.innerHTML='<div class="nd">Could not load growth trend: '+err.message+'</div>';
  }
}

function renderTrendCharts(){
  if(!TREND_DATA||typeof Chart==='undefined') return;
  const labels=TREND_DATA.map(m=>m.label);
  const lineOpts={responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{font:{size:10},boxWidth:10,padding:8}}},scales:{x:{grid:{display:false},ticks:{font:{size:9}}},y:{grid:{color:'#EFE9DE'},ticks:{font:{size:9}},beginAtZero:true}}};
  dc('c-trend-reach');
  charts['c-trend-reach']=new Chart(document.getElementById('c-trend-reach'),{type:'line',
    data:{labels,datasets:[
      {label:'IG Reach',data:TREND_DATA.map(m=>m.igReach),borderColor:'#833ab4',backgroundColor:'rgba(131,58,180,.08)',borderWidth:2,pointRadius:3,fill:true,tension:.3,spanGaps:true},
      {label:'FB Reach',data:TREND_DATA.map(m=>m.fbReach),borderColor:'#1877F2',backgroundColor:'rgba(24,119,242,.08)',borderWidth:2,pointRadius:3,fill:true,tension:.3,spanGaps:true},
    ]},options:lineOpts});
  dc('c-trend-eng');
  charts['c-trend-eng']=new Chart(document.getElementById('c-trend-eng'),{type:'line',
    data:{labels,datasets:[
      {label:'IG Accts Engaged',data:TREND_DATA.map(m=>m.igAccsEng),borderColor:'#833ab4',backgroundColor:'rgba(131,58,180,.08)',borderWidth:2,pointRadius:3,fill:true,tension:.3,spanGaps:true},
      {label:'FB Engagements',data:TREND_DATA.map(m=>m.fbEng),borderColor:'#1877F2',backgroundColor:'rgba(24,119,242,.08)',borderWidth:2,pointRadius:3,fill:true,tension:.3,spanGaps:true},
    ]},options:lineOpts});
  dc('c-trend-followers');
  charts['c-trend-followers']=new Chart(document.getElementById('c-trend-followers'),{type:'line',
    data:{labels,datasets:[
      {label:'IG New Followers',data:TREND_DATA.map(m=>m.igNewFollowers),borderColor:'#4A7C59',borderWidth:2,pointRadius:3,tension:.3,spanGaps:true},
      {label:'FB New Page Likes',data:TREND_DATA.map(m=>m.fbNewFans),borderColor:'#C99A4A',borderWidth:2,pointRadius:3,tension:.3,spanGaps:true},
    ]},options:lineOpts});
}

// ── BENCHMARK SCORECARD ────────────────────────────────
function renderBenchmarkBar(label,valuePct,lowBench,highBench,note){
  const maxScale=Math.max(highBench*1.8,valuePct*1.15,1);
  const bandLeftPct=(lowBench/maxScale)*100;
  const bandWidthPct=((highBench-lowBench)/maxScale)*100;
  const fillPct=Math.min(100,(Math.max(valuePct,0)/maxScale)*100);
  const status=valuePct>=highBench?'good':valuePct>=lowBench?'warn':'bad';
  const color=status==='good'?'#4A7C59':status==='warn'?'#C99A4A':'#B3362A';
  const statusLabel=status==='good'?'Above benchmark':status==='warn'?'Within benchmark':'Below benchmark';
  return `<div style="margin-bottom:18px;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
      <span style="font-size:12.5px;font-weight:600;color:#182433;">${label}</span>
      <span style="font-size:13px;font-weight:700;color:${color};">${valuePct.toFixed(1)}% <span style="font-size:10px;font-weight:600;">${statusLabel}</span></span>
    </div>
    <div style="position:relative;height:22px;background:#EFE9DE;border-radius:11px;overflow:hidden;">
      <div style="position:absolute;top:0;bottom:0;left:${bandLeftPct}%;width:${bandWidthPct}%;background:rgba(201,154,74,.28);"></div>
      <div style="position:absolute;top:3px;bottom:3px;left:0;width:${fillPct}%;background:${color};border-radius:8px;"></div>
    </div>
    <div style="font-size:10px;color:#6B6F73;margin-top:4px;">Industry benchmark: ${lowBench}–${highBench}%${note?(' · '+note):''}</div>
  </div>`;
}

// ── COMMUNITY MANAGEMENT (reply rate) ─────────────────
// Best-effort: one extra Graph API call per commented-on post to see who
// wrote each comment. If anything about that fails for this account, the
// whole section just hides instead of affecting anything else.
async function loadCommunity(){
  const container=document.getElementById('community-container');
  const sec=document.getElementById('community-sec');
  if(!container||!sec) return;
  const range=customRange||getRange();
  const key=range.since+'_'+range.until;
  if(COMMUNITY_DATA&&COMMUNITY_RANGE_KEY===key){ renderCommunitySection(); return; }
  try{
    const url=new URL('/api/community',location.origin);
    url.searchParams.set('since',range.since);
    url.searchParams.set('until',range.until);
    const resp=await fetch(url);
    const body=await resp.json().catch(()=>null);
    COMMUNITY_DATA=body;
    COMMUNITY_RANGE_KEY=key;
    renderCommunitySection();
  }catch(err){
    COMMUNITY_DATA=null;
    sec.style.display='none';
    container.innerHTML='';
  }
}

function renderCommunitySection(){
  const container=document.getElementById('community-container');
  const sec=document.getElementById('community-sec');
  if(!container||!sec) return;
  const d=COMMUNITY_DATA;
  if(!d||!d.available){
    sec.style.display='none';
    container.innerHTML='';
    return;
  }
  sec.style.display='';
  if(d.postsWithComments===0){
    container.innerHTML='<div class="nd">No comments received this period.</div>';
    return;
  }
  const pct=d.replyRate;
  const color=pct>=80?'#4A7C59':pct>=40?'#C99A4A':'#B3362A';
  container.innerHTML=`<div class="kg g3">
    <div class="kpi"><div class="kl">Reply Rate</div><div class="kv" style="color:${color}">${pct}%</div><div class="ks">of posts with comments got a reply</div></div>
    <div class="kpi"><div class="kl">Posts With Comments</div><div class="kv">${d.postsWithComments}</div><div class="ks">this period</div></div>
    <div class="kpi"><div class="kl">Posts You Replied To</div><div class="kv">${d.postsWithReply}</div><div class="ks">at least one reply</div></div>
  </div>`;
}

// ── UPCOMING POSTS (from GHL Social Planner) ──────────
// A fixed "what's scheduled in the next 60 days" list, independent of
// whatever historical date range the rest of the dashboard is navigated
// to -- fetched once per session and cached, same pattern as the growth
// trend. Renders nothing (not even an empty section) if GHL isn't
// configured or the account has nothing scheduled, so this degrades
// invisibly for anyone who hasn't set up GHL_API_KEY/GHL_LOCATION_ID.
let UPCOMING_DATA=null;

async function loadUpcoming(){
  const sec=document.getElementById('upcoming-sec');
  const container=document.getElementById('upcoming-container');
  if(!sec||!container) return;
  if(UPCOMING_DATA){ renderUpcomingSection(); return; }
  try{
    const resp=await fetch('/api/upcoming');
    const body=await resp.json().catch(()=>null);
    UPCOMING_DATA=body;
    renderUpcomingSection();
  }catch(err){
    UPCOMING_DATA=null;
    sec.style.display='none';
    container.innerHTML='';
  }
}

function renderUpcomingSection(){
  const sec=document.getElementById('upcoming-sec');
  const container=document.getElementById('upcoming-container');
  if(sec&&container){
    const d=UPCOMING_DATA;
    if(!d||!d.available||!d.upcoming||d.upcoming.length===0){
      sec.style.display='none';
      container.innerHTML='';
    } else {
      sec.style.display='';
      container.innerHTML='<div class="pgrid">'+d.upcoming.slice(0,9).map(renderUpcomingCard).join('')+'</div>';
    }
  }
  // The calendar renders from allPosts computed at call time, so it needs
  // to be redrawn now that UPCOMING_DATA has actually arrived -- the first
  // renderPostCalendar() call (before this fetch resolved) had none of it.
  const calContainer=document.getElementById('cal-container');
  if(calContainer) calContainer.innerHTML=renderPostCalendar();
}

function renderUpcomingCard(p){
  const dt=new Date(p.scheduleDate);
  const dateLabel=isNaN(dt.getTime())?'':dt.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' · '+dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
  const isVideo=(p.mediaType||'').startsWith('video');
  const platBadges=(p.instagram?'<span class="cal-plat ig-plat" style="position:static;margin-right:3px;">IG</span>':'')+(p.facebook?'<span class="cal-plat fb-plat" style="position:static;">FB</span>':'');
  return `
    <div class="pc" style="cursor:default;">
      <div class="piw">
        ${imgTag(p.mediaUrl,'pimg','pph',isVideo?'▶':'🏠')}
        <span class="ptyp" style="background:rgba(36,52,71,.85);">📅 Scheduled</span>
      </div>
      <div class="pb">
        <div class="pcap">${(p.caption||'No caption').replace(/\n/g,' ')}</div>
        <div class="pmets" style="align-items:center;">
          <span style="font-size:11px;color:#6B6F73;">${dateLabel}</span>
          ${platBadges}
        </div>
      </div>
    </div>`;
}

function renderInsights(){
  const ig=igM(),fb=fbM();
  const roi=calcContentROI();
  const maxROI=Math.max(1,...roi.map(r=>r.avgEng));
  const funnelSteps=[
    {label:'Reach',value:ig.totalReach,color:'#C99A4A',icon:'👁'},
    {label:'Accts Engaged',value:ig.accsEng,color:'#4E5D73',icon:'💬'},
    {label:'Profile Views',value:ig.profViews,color:'#4A7C59',icon:'👤'},
    {label:'Website Clicks',value:ig.webClicks,color:'#833ab4',icon:'🔗'}
  ];
  const maxF=Math.max(1,funnelSteps[0].value);
  const roiCards=roi.map(r=>{
    return '<div class="kpi"><div class="kl">'+r.emoji+' '+r.label+'</div>'+
      '<div class="kv">'+r.avgEng+'<span style="font-size:14px;color:#6B6F73;font-weight:400"> avg eng</span></div>'+
      '<div class="ks">'+r.count+' post'+(r.count!==1?'s':'')+' &middot; '+r.totalEng+' total</div>'+
      '<div style="height:4px;background:#EFE9DE;border-radius:2px;margin-top:10px;">'+
      '<div style="height:100%;width:'+Math.round(r.avgEng/maxROI*100)+'%;background:#C99A4A;border-radius:2px;"></div></div></div>';
  }).join('');
  const funnelHTML=funnelSteps.map((step,i)=>{
    const pct=Math.round(step.value/maxF*100);
    const drop=i>0&&funnelSteps[i-1].value>0?Math.round((1-step.value/funnelSteps[i-1].value)*100):null;
    return '<div style="margin-bottom:14px;">'+
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px;">'+
      '<span style="font-size:12px;font-weight:600;color:#182433;">'+step.icon+' '+step.label+'</span>'+
      '<span style="font-size:14px;font-weight:700;color:'+step.color+';">'+step.value.toLocaleString()+
      (drop!==null?' <span style="font-size:10px;color:#e74c3c;font-weight:400;">&darr;'+drop+'% drop</span>':'')+
      '</span></div>'+
      '<div style="height:30px;background:#EFE9DE;border-radius:6px;overflow:hidden;">'+
      '<div style="height:100%;width:'+pct+'%;background:'+step.color+';border-radius:6px;display:flex;align-items:center;padding-left:10px;">'+
      (pct>12?'<span style="font-size:10px;color:#fff;font-weight:700;">'+pct+'%</span>':'')+
      '</div></div></div>';
  }).join('');
  const engRatePct=ig.totalReach>0?(ig.totalEng/ig.totalReach)*100:0;
  const followRatePct=ig.totalReach>0?(ig.newFol/ig.totalReach)*100:0;
  document.getElementById('tab-insights').innerHTML=
    renderLiveBar()+
    '<div class="sec">📈 Growth Trend <span class="pill" style="background:#243447;color:#fff;font-size:10px;">Last 6 Months</span></div>'+
    '<div id="trend-container">'+
    '<div class="crow c11" style="margin-bottom:12px;">'+
    '<div class="cc"><div class="ct">Reach</div><div class="cst">Unique accounts/people reached per month</div><div class="cw"><canvas id="c-trend-reach"></canvas></div></div>'+
    '<div class="cc"><div class="ct">Engagement</div><div class="cst">IG accounts engaged vs FB post engagements per month</div><div class="cw"><canvas id="c-trend-eng"></canvas></div></div>'+
    '</div>'+
    '<div class="cc" style="margin-bottom:18px;"><div class="ct">Follower / Page-Like Growth</div><div class="cst">New IG followers vs new FB Page likes per month</div><div class="cw"><canvas id="c-trend-followers"></canvas></div></div>'+
    '</div>'+
    '<div class="sec">📊 Content Type ROI <span class="pill p-ig">IG</span></div>'+
    '<div class="kg g3">'+(roiCards||'<div class="nd">No posts this period.</div>')+'</div>'+
    '<div class="sec">🎯 Performance vs. Benchmark</div>'+
    '<div class="cc" style="margin-bottom:18px;">'+
    renderBenchmarkBar('IG Engagement Rate',engRatePct,2,4,'luxury home builder average')+
    renderBenchmarkBar('IG Follow Rate',followRatePct,0.5,1,'reach-to-new-follower conversion')+
    '</div>'+
    '<div class="sec">🕐 Best Day to Post <span class="pill" style="background:#4E5D73;color:#fff;font-size:10px;">IG + FB combined</span></div>'+
    '<div class="crow c11">'+
    '<div class="cc"><div class="ct">Avg Engagement by Day</div>'+
    '<div class="cst">Which days earn the most engagement on average</div>'+
    '<div class="cw"><canvas id="c-best-day"></canvas></div></div>'+
    '<div class="cc"><div class="ct">Post Volume by Day</div>'+
    '<div class="cst">How often you publish each day — compare to find gaps</div>'+
    '<div class="cw"><canvas id="c-post-vol"></canvas></div></div></div>'+
    '<div class="sec">📉 IG Engagement Funnel</div>'+
    '<div class="cc" style="margin-bottom:16px;"><div class="ct">Reach → Action</div>'+
    '<div class="cst">Where your audience drops off between seeing content and taking action</div>'+
    '<div style="padding:16px 8px;">'+funnelHTML+'</div></div>'+
    '<div class="sec" id="community-sec" style="display:none;">💬 Community Management</div>'+
    '<div id="community-container" style="margin-bottom:18px;"></div>'+
    '<div class="sec">🧠 Insights &amp; Recommendations</div>'+
    '<div id="ai-insights-panel" style="background:#fff;border-radius:12px;padding:20px 24px;border:1px solid #E4DCC9;margin-bottom:20px;">'+
    '<div id="ai-insights-content" style="color:#182433;font-size:13px;line-height:1.8;">'+buildRuleInsights()+'</div></div>';
  loadTrend();
  loadCommunity();
}

// ── CHARTS ────────────────────────────────────────────
function initCharts(t){
  if(cinit[t]) return;
  cinit[t]=true;
  if(typeof Chart==='undefined'){
    console.warn('Chart.js failed to load (CDN blocked/offline?) — skipping charts for this tab.');
    return;
  }
  const ig=igM(), fb=fbM();

  if(t==='overview'){
    dc('c-combo');
    const rd=ig.reachByDay;
    if(rd.length){
      const lbls=chartLabels(rd);
      const fbMap={};
      fb.engByDay.forEach(v=>{ const d=new Date(v.end_time); fbMap[`${d.getMonth()+1}/${d.getDate()}`]=v.value||0; });
      charts['c-combo']=new Chart(document.getElementById('c-combo'),{
        type:'line',
        data:{labels:lbls,datasets:[
          {label:'IG Reach',data:rd.map(v=>v.value),borderColor:'#833ab4',backgroundColor:'rgba(131,58,180,.08)',borderWidth:2,pointRadius:2,fill:true,tension:.3,yAxisID:'y'},
          {label:'FB Eng.',data:lbls.map(l=>fbMap[l]||0),borderColor:'#1877F2',backgroundColor:'rgba(24,119,242,.08)',borderWidth:2,pointRadius:2,fill:true,tension:.3,yAxisID:'y2'}
        ]},
        options:{responsive:true,maintainAspectRatio:false,
          plugins:{legend:{position:'top',labels:{font:{size:11},padding:10}}},
          scales:{
            x:{grid:{display:false},ticks:{font:{size:9},maxTicksLimit:10}},
            y:{grid:{color:'#EFE9DE'},ticks:{font:{size:9}},position:'left',title:{display:true,text:'IG Reach',color:'#833ab4',font:{size:9}}},
            y2:{grid:{display:false},ticks:{font:{size:9}},position:'right',title:{display:true,text:'FB Eng.',color:'#1877F2',font:{size:9}}}
          }}
      });
    }
    dc('c-mix');
    const vc=s.igPosts.filter(p=>p.media_type==='VIDEO').length;
    const cc=s.igPosts.filter(p=>p.media_type==='CAROUSEL_ALBUM').length;
    const ic=s.igPosts.filter(p=>p.media_type==='IMAGE').length;
    if(vc+cc+ic>0){
      charts['c-mix']=new Chart(document.getElementById('c-mix'),{
        type:'doughnut',
        data:{labels:['Carousel','Reel/Video','Image'],datasets:[{data:[cc,vc,ic],backgroundColor:['#C99A4A','#4E5D73','#8B93A0'],borderWidth:0}]},
        options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:11},padding:12}}},cutout:'62%'}
      });
    }
  }

  if(t==='ig'){
    dc('c-ig-reach');
    if(ig.reachByDay.length){
      charts['c-ig-reach']=new Chart(document.getElementById('c-ig-reach'),{
        type:'bar',
        data:{labels:chartLabels(ig.reachByDay),datasets:[{data:ig.reachByDay.map(v=>v.value),backgroundColor:ig.reachByDay.map(v=>(v.value||0)>=100?'#C99A4A':'#D8B36C'),borderRadius:3}]},
        options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{font:{size:9},maxTicksLimit:10}},y:{grid:{color:'#EFE9DE'},ticks:{font:{size:10}}}}}
      });
    }
    dc('c-ig-fc');
    if(ig.folByDay.length){
      charts['c-ig-fc']=new Chart(document.getElementById('c-ig-fc'),{
        type:'bar',
        data:{labels:chartLabels(ig.folByDay),datasets:[{data:ig.folByDay.map(v=>v.value),backgroundColor:'#4A7C59',borderRadius:3}]},
        options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{font:{size:9},maxTicksLimit:10}},y:{grid:{color:'#EFE9DE'},ticks:{font:{size:10},stepSize:1},min:0}}}
      });
    }
  }

  if(t==='insights'){
    const times=calcBestTimes();
    const maxEng=Math.max(1,...times.byDay.map(d=>d.avgEng));
    dc('c-best-day');
    if(document.getElementById('c-best-day')){
      charts['c-best-day']=new Chart(document.getElementById('c-best-day'),{
        type:'bar',
        data:{labels:times.byDay.map(d=>d.name),datasets:[{
          data:times.byDay.map(d=>d.avgEng),
          backgroundColor:times.byDay.map(d=>d.avgEng===maxEng&&d.avgEng>0?'#C99A4A':'#D8B36C'),
          borderRadius:4
        }]},
        options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
          scales:{x:{grid:{display:false},ticks:{font:{size:10}}},y:{grid:{color:'#EFE9DE'},ticks:{font:{size:9}},beginAtZero:true}}}
      });
    }
    dc('c-post-vol');
    if(document.getElementById('c-post-vol')){
      charts['c-post-vol']=new Chart(document.getElementById('c-post-vol'),{
        type:'bar',
        data:{labels:times.byDay.map(d=>d.name),datasets:[{
          data:times.byDay.map(d=>d.count),
          backgroundColor:'#D8B36C',borderRadius:4
        }]},
        options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
          scales:{x:{grid:{display:false},ticks:{font:{size:10}}},y:{grid:{color:'#EFE9DE'},ticks:{font:{size:9},stepSize:1},beginAtZero:true}}}
      });
    }
  }
  if(t==='fb'){
    dc('c-fb-eng');
    if(fb.engByDay.length){
      charts['c-fb-eng']=new Chart(document.getElementById('c-fb-eng'),{
        type:'bar',
        data:{labels:chartLabels(fb.engByDay),datasets:[{data:fb.engByDay.map(v=>v.value),backgroundColor:fb.engByDay.map(v=>(v.value||0)>=50?'#1877F2':'#93B5F5'),borderRadius:3}]},
        options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{font:{size:9},maxTicksLimit:10}},y:{grid:{color:'#EFE9DE'},ticks:{font:{size:10}}}}}
      });
    }
    dc('c-fb-views');
    if(fb.viewsByDay.length){
      charts['c-fb-views']=new Chart(document.getElementById('c-fb-views'),{
        type:'line',
        data:{labels:chartLabels(fb.viewsByDay),datasets:[{data:fb.viewsByDay.map(v=>v.value),borderColor:'#1877F2',backgroundColor:'rgba(24,119,242,.1)',borderWidth:2,pointRadius:2,fill:true,tension:.3}]},
        options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{font:{size:9},maxTicksLimit:10}},y:{grid:{color:'#EFE9DE'},ticks:{font:{size:10}}}}}
      });
    }
  }
}

// ── TAB SWITCH ────────────────────────────────────────
function setTab(t, force){
  if(t===tab&&!force) return;
  tab=t; localStorage.setItem('ru_tab',t);
  document.querySelectorAll('.tab').forEach(el=>el.classList.toggle('on',el.dataset.tab===t));
  document.querySelectorAll('.panel').forEach(el=>{
    const show=el.id===`tab-${t}`;
    el.style.display=show?'block':'none';
    el.classList.toggle('on',show);
  });
  requestAnimationFrame(()=>requestAnimationFrame(()=>initCharts(t)));
}

// ── SHARE ─────────────────────────────────────────────
document.getElementById('shareBtn').addEventListener('click',()=>{
  document.querySelectorAll('.panel').forEach(p=>p.style.display='block');
  window.print();
  setTimeout(()=>setTab(tab,true),600);
});
document.getElementById('mclose').addEventListener('click',()=>document.getElementById('modal').style.display='none');
document.getElementById('modal').addEventListener('click',e=>{if(e.target===document.getElementById('modal')) document.getElementById('modal').style.display='none';});
document.getElementById('opt-pdf').addEventListener('click',()=>{
  document.getElementById('modal').style.display='none';
  document.querySelectorAll('.panel').forEach(p=>p.style.display='block');
  window.print();
  setTimeout(()=>setTab(tab,true),600);
});

// ── NAV ───────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(el=>el.addEventListener('click',()=>setTab(el.dataset.tab)));

function syncDrInputs(){
  const r=getRange();
  document.getElementById('drFrom').value=r.since;
  document.getElementById('drTo').value=r.until;
}

document.getElementById('prevBtn').addEventListener('click',()=>{
  if(view==='custom'){ view='month'; customRange=null; document.getElementById('drClear').style.display='none'; document.getElementById('monthBtn').classList.add('on'); document.getElementById('weekBtn').classList.remove('on'); }
  if(view==='month') navDate=new Date(navDate.getFullYear(),navDate.getMonth()-1,1);
  else navDate=new Date(navDate.getTime()-7*86400000);
  syncDrInputs();
  loadData();
});
document.getElementById('nextBtn').addEventListener('click',()=>{
  if(view==='custom'){ view='month'; customRange=null; document.getElementById('drClear').style.display='none'; document.getElementById('monthBtn').classList.add('on'); document.getElementById('weekBtn').classList.remove('on'); }
  if(view==='month') navDate=new Date(navDate.getFullYear(),navDate.getMonth()+1,1);
  else navDate=new Date(navDate.getTime()+7*86400000);
  syncDrInputs();
  loadData();
});
document.getElementById('monthBtn').addEventListener('click',()=>{
  view='month'; customRange=null; localStorage.setItem('ru_view','month');
  document.getElementById('monthBtn').classList.add('on');
  document.getElementById('weekBtn').classList.remove('on');
  document.getElementById('drClear').style.display='none';
  navDate=new Date(navDate.getFullYear(),navDate.getMonth(),1);
  syncDrInputs();
  loadData();
});
document.getElementById('weekBtn').addEventListener('click',()=>{
  view='week'; customRange=null; localStorage.setItem('ru_view','week');
  document.getElementById('weekBtn').classList.add('on');
  document.getElementById('monthBtn').classList.remove('on');
  document.getElementById('drClear').style.display='none';
  const now=new Date(); navDate=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  syncDrInputs();
  loadData();
});

// ── DATE RANGE ────────────────────────────────────────
syncDrInputs();

document.getElementById('drApply').addEventListener('click',()=>{
  const from=document.getElementById('drFrom').value;
  const to=document.getElementById('drTo').value;
  if(!from||!to){ alert('Please select both a start and end date.'); return; }
  if(from>to){ alert('Start date must be before end date.'); return; }
  customRange={since:from,until:to};
  view='custom';
  document.getElementById('drClear').style.display='inline-block';
  document.getElementById('monthBtn').classList.remove('on');
  document.getElementById('weekBtn').classList.remove('on');
  loadData();
});

document.getElementById('drClear').addEventListener('click',()=>{
  customRange=null;
  view='month'; localStorage.setItem('ru_view','month');
  document.getElementById('drClear').style.display='none';
  document.getElementById('monthBtn').classList.add('on');
  document.getElementById('weekBtn').classList.remove('on');
  syncDrInputs();
  loadData();
});

// ── AUTO-REFRESH ──────────────────────────────────────
// Refetches the currently-viewed date range on an interval so a client with
// this page open sees new posts/numbers without having to click Reload.
// Paused while the tab isn't visible so a browser left open overnight isn't
// silently hammering the Meta API the whole time.
const AUTO_REFRESH_MS = 5 * 60 * 1000;
let autoRefreshTimer = null;
function startAutoRefresh(){
  stopAutoRefresh();
  autoRefreshTimer = setInterval(()=>{ if(document.visibilityState==='visible') loadData(); }, AUTO_REFRESH_MS);
}
function stopAutoRefresh(){
  if(autoRefreshTimer){ clearInterval(autoRefreshTimer); autoRefreshTimer=null; }
}
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible') loadData(); // catch up immediately on return
});

// ── INIT ──────────────────────────────────────────────
// Reflect the year-to-date default: neither Month nor Week is "on", and
// the Clear Range button is available to drop back to the current month.
document.getElementById('monthBtn').classList.remove('on');
document.getElementById('drClear').style.display='inline-block';
setTab(tab, true);
loadData();
startAutoRefresh();
