// ── APPROVALS TAB ───────────────────────────────────────────────────────────
// Renew Urban reviews each post here before it's scheduled. Talks only to
// /api/approvals on this server; the passcode is sent as a header and kept in
// sessionStorage for the tab's lifetime so the reviewer doesn't retype it.
(function(){
  const panel=document.getElementById('tab-approvals');
  if(!panel) return;

  const TZ='America/New_York';
  const store={
    get(k){ try{ return sessionStorage.getItem(k); }catch(e){ return null; } },
    set(k,v){ try{ v==null?sessionStorage.removeItem(k):sessionStorage.setItem(k,v); }catch(e){} },
    getLocal(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
    setLocal(k,v){ try{ localStorage.setItem(k,v); }catch(e){} },
  };
  let passcode=store.get('ru_review_pass');
  let posts=null, autoSchedule=true, loading=false;
  const slideIdx={}, capTab={};

  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtWhen=iso=>{
    const d=new Date(iso); if(isNaN(d)) return 'Time not set';
    return d.toLocaleString('en-US',{timeZone:TZ,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' ET';
  };
  // CMG-only entry to the admin page (it has its own passcode).
  const adminLink='<div class="ap-foot ap-admin"><a class="ap-admin-btn" href="/admin.html">Manage posts (CMG admin) →</a></div>';
  const safeUrl=u=>/^https?:\/\//i.test(u||'')?u:'#';

  // Keep the date controls and loading banners out of the way on this tab.
  const syncBody=()=>document.body.classList.toggle('on-approvals',panel.classList.contains('on'));
  new MutationObserver(syncBody).observe(panel,{attributes:true,attributeFilter:['class']});
  syncBody();

  async function api(path,opts={}){
    const resp=await fetch('/api/approvals'+path,{
      ...opts,
      headers:{'Content-Type':'application/json','x-review-passcode':passcode||'',...(opts.headers||{})},
    });
    const body=await resp.json().catch(()=>({}));
    if(!resp.ok){ const e=new Error(body.error||('Request failed ('+resp.status+')')); e.status=resp.status; throw e; }
    return body;
  }

  function renderGate(msg){
    panel.innerHTML=`
      <div class="ap-gate">
        <div class="ap-gate-t">Posts for your approval</div>
        <p class="ap-gate-s">Enter the review passcode from Charleston Media Group to see what's waiting.</p>
        <form id="ap-gate-form" class="ap-gate-f" autocomplete="off">
          <input id="ap-pass" type="password" placeholder="Passcode" aria-label="Review passcode" required>
          <button type="submit" class="ap-btn ap-approve">View posts</button>
        </form>
        ${msg?`<div class="ap-err">${esc(msg)}</div>`:''}
      </div>${adminLink}`;
    document.getElementById('ap-gate-form').addEventListener('submit',e=>{
      e.preventDefault();
      passcode=document.getElementById('ap-pass').value.trim();
      store.set('ru_review_pass',passcode);
      load();
    });
  }

  async function load(){
    if(!passcode){ renderGate(); return; }
    if(loading) return; loading=true;
    panel.innerHTML='<div class="ldg" style="display:flex"><div class="spin"></div>Loading posts…</div>';
    try{
      const body=await api('');
      posts=body.posts||[]; autoSchedule=body.autoSchedule!==false;
      renderList();
    }catch(err){
      if(err.status===401||err.status===429){ passcode=null; store.set('ru_review_pass',null); renderGate(err.message); }
      else panel.innerHTML=`<div class="ap-err ap-err-block">${esc(err.message)}</div>`;
    }finally{ loading=false; }
  }

  function statusPill(p){
    const map={pending:['Waiting for you','ap-s-pending'],approved:['Approved','ap-s-approved'],changes_requested:['Changes requested','ap-s-changes']};
    const [label,cls]=map[p.status]||map.pending;
    return `<span class="ap-pill ${cls}">${label}</span>`;
  }

  function scheduleLine(p){
    if(p.status!=='approved'||!p.schedule) return '';
    const s=p.schedule.state;
    if(s==='scheduled') return `Scheduled to post ${esc(fmtWhen(p.plannedAt))}.`;
    if(s==='needs_new_time') return 'Approved after its planned time, so Barry will pick a new time.';
    if(s==='manual') return 'Barry will schedule it.';
    if(s==='partial') return 'Scheduled on one platform only. Barry will finish the other.';
    if(s==='failed') return 'Scheduling hit a problem. Barry will schedule it manually.';
    return '';
  }

  function decisionBlock(p){
    const locked=p.status==='approved'&&p.schedule&&['scheduled','partial'].includes(p.schedule.state);
    const who=p.reviewerName?` by ${esc(p.reviewerName)}`:'';
    const when=p.decidedAt?` · ${esc(new Date(p.decidedAt).toLocaleDateString('en-US',{timeZone:TZ,month:'short',day:'numeric'}))}`:'';
    let summary='';
    if(p.status==='approved') summary=`<div class="ap-dec ap-dec-ok"><strong>Approved${who}${when}.</strong> ${scheduleLine(p)}</div>`;
    if(p.status==='changes_requested') summary=`<div class="ap-dec ap-dec-ch"><strong>Changes requested${who}${when}:</strong><div class="ap-notes">${esc(p.reviewerNotes)}</div>Barry will revise it and send it back.</div>`;
    if(locked) return summary+`<div class="ap-lock">This post is scheduled. To change or pull it, contact Barry.</div>`;
    const name=esc(store.getLocal('ru_reviewer_name')||'');
    const prev=p.previousRound?`<div class="ap-prev">Revised after the last round${p.previousRound.notes?`: “${esc(p.previousRound.notes)}”`:'.'}</div>`:'';
    return `${summary}${prev}
      <div class="ap-form" data-id="${esc(p.id)}">
        <div class="ap-row">
          <input class="ap-name" type="text" placeholder="Your name" value="${name}" aria-label="Your name">
        </div>
        <textarea class="ap-notes-in" rows="3" placeholder="Notes (required if you're requesting changes)" aria-label="Notes"></textarea>
        <div class="ap-actions">
          <button type="button" class="ap-btn ap-approve" data-act="approved">${p.status==='approved'?'Approve again':'Approve'}</button>
          <button type="button" class="ap-btn ap-change" data-act="changes_requested">Request changes</button>
        </div>
        <div class="ap-err" hidden></div>
      </div>`;
  }

  function slides(p){
    if(p.video&&p.video.url) return `<div class="ap-stage ap-vstage"><video src="${esc(p.video.url)}" ${p.images&&p.images[0]?`poster="${esc(p.images[0])}"`:''} controls playsinline preload="metadata"></video></div>`;
    const imgs=p.images||[]; if(!imgs.length) return '<div class="ap-noimg">No image</div>';
    const i=Math.min(slideIdx[p.id]||0,imgs.length-1);
    const nav=imgs.length>1?`
      <button type="button" class="ap-nav ap-prev-s" data-id="${esc(p.id)}" data-d="-1" aria-label="Previous slide">‹</button>
      <button type="button" class="ap-nav ap-next-s" data-id="${esc(p.id)}" data-d="1" aria-label="Next slide">›</button>
      <div class="ap-count">${i+1} / ${imgs.length}</div>`:'';
    const thumbs=imgs.length>1?`<div class="ap-thumbs">${imgs.map((u,j)=>`<button type="button" class="ap-th${j===i?' on':''}" data-id="${esc(p.id)}" data-j="${j}"><img src="${esc(u)}" alt="Slide ${j+1}" loading="lazy"></button>`).join('')}</div>`:'';
    return `<div class="ap-stage"><img src="${esc(imgs[i])}" alt="${esc((p.instagram&&p.instagram.altText)||p.title)}">${nav}</div>${thumbs}`;
  }

  function captions(p){
    const t=capTab[p.id]||(p.instagram?'ig':'fb');
    const c=t==='ig'?p.instagram:p.facebook;
    const tabs=`<div class="ap-ctabs">${p.instagram?`<button type="button" class="ap-ct${t==='ig'?' on':''}" data-id="${esc(p.id)}" data-t="ig">Instagram</button>`:''}${p.facebook?`<button type="button" class="ap-ct${t==='fb'?' on':''}" data-id="${esc(p.id)}" data-t="fb">Facebook</button>`:''}</div>`;
    if(!c) return tabs;
    return `${tabs}<div class="ap-cap">${esc(c.caption)}</div>
      ${c.firstComment?`<div class="ap-lbl">First comment</div><div class="ap-cap ap-cap-sm">${esc(c.firstComment)}</div>`:''}`;
  }

  function card(p){
    const sources=(p.sources||[]).length?`<div class="ap-lbl">Sources</div><ul class="ap-src">${p.sources.map(s=>`<li><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a></li>`).join('')}</ul>`:'';
    const plats=[p.instagram?'<span class="pill p-ig">IG</span>':'',p.facebook?'<span class="pill p-fb">FB</span>':''].join(' ');
    return `
      <article class="ap-card" id="ap-${esc(p.id)}">
        <div class="ap-media">${slides(p)}</div>
        <div class="ap-body">
          <div class="ap-head">
            <div>
              <div class="ap-title">${esc(p.title)}</div>
              <div class="ap-meta">${esc(fmtWhen(p.plannedAt))} · ${esc(p.format||'')} ${plats}</div>
            </div>
            ${statusPill(p)}
          </div>
          ${p.notesForReviewer?`<div class="ap-ask"><strong>Please check:</strong> ${esc(p.notesForReviewer)}</div>`:''}
          ${captions(p)}
          ${sources}
          ${decisionBlock(p)}
        </div>
      </article>`;
  }

  function renderList(){
    const n=s=>posts.filter(p=>p.status===s).length;
    const head=`
      <div class="ap-top">
        <div>
          <div class="ap-h1">Posts for your approval</div>
          <div class="ap-sub">Nothing is scheduled until you approve it${autoSchedule?'. Approved posts are scheduled automatically for the time shown':''}. No answer means the post doesn't go out.</div>
        </div>
        <div class="ap-counts"><span><b>${n('pending')}</b> waiting</span><span><b>${n('approved')}</b> approved</span><span><b>${n('changes_requested')}</b> changes</span></div>
      </div>`;
    const order={pending:0,changes_requested:1,approved:2};
    const sorted=posts.slice().sort((a,b)=>(order[a.status]-order[b.status])||(new Date(a.plannedAt)-new Date(b.plannedAt)));
    panel.innerHTML=head+(sorted.length?sorted.map(card).join(''):'<div class="ap-empty">Nothing waiting for approval right now.</div>')
      +'<div class="ap-foot"><button type="button" class="ap-link" id="ap-signout">Sign out of approvals</button></div>'+adminLink;
  }

  function rerenderCard(id){
    const p=posts.find(x=>x.id===id); const el=document.getElementById('ap-'+id);
    if(p&&el) el.outerHTML=card(p);
  }

  panel.addEventListener('click',async e=>{
    const t=e.target.closest('button'); if(!t) return;
    if(t.id==='ap-signout'){ passcode=null; store.set('ru_review_pass',null); renderGate(); return; }
    const id=t.dataset.id;
    if(t.classList.contains('ap-nav')){ const p=posts.find(x=>x.id===id); const len=p.images.length; slideIdx[id]=((slideIdx[id]||0)+Number(t.dataset.d)+len)%len; rerenderCard(id); return; }
    if(t.classList.contains('ap-th')){ slideIdx[id]=Number(t.dataset.j); rerenderCard(id); return; }
    if(t.classList.contains('ap-ct')){ capTab[id]=t.dataset.t; rerenderCard(id); return; }
    if(t.dataset.act){
      const form=t.closest('.ap-form'); const pid=form.dataset.id;
      const name=form.querySelector('.ap-name').value.trim();
      const notes=form.querySelector('.ap-notes-in').value.trim();
      const err=form.querySelector('.ap-err');
      const showErr=m=>{ err.textContent=m; err.hidden=false; };
      if(!name) return showErr('Please add your name.');
      if(t.dataset.act==='changes_requested'&&!notes) return showErr('Please say what should change.');
      store.setLocal('ru_reviewer_name',name);
      form.querySelectorAll('button').forEach(b=>b.disabled=true);
      t.textContent=t.dataset.act==='approved'?'Approving…':'Sending…';
      try{
        const body=await api('/'+encodeURIComponent(pid)+'/decision',{method:'POST',body:JSON.stringify({decision:t.dataset.act,reviewerName:name,notes})});
        const i=posts.findIndex(x=>x.id===pid); if(i>=0) posts[i]=body.post;
        renderList();
        const el=document.getElementById('ap-'+pid); if(el) el.scrollIntoView({behavior:'smooth',block:'start'});
      }catch(ex){
        if(ex.status===401){ passcode=null; store.set('ru_review_pass',null); renderGate(ex.message); return; }
        form.querySelectorAll('button').forEach(b=>b.disabled=false);
        t.textContent=t.dataset.act==='approved'?'Approve':'Request changes';
        showErr(ex.message);
      }
    }
  });

  // Load when the tab is opened (and on page load if it's the saved tab).
  document.querySelector('.tab[data-tab="approvals"]').addEventListener('click',()=>{ if(!posts) load(); });
  const wantsApprovals=/(^|[?&])(tab=approvals|review)(&|$)/.test(location.search.slice(1))||location.hash==='#approvals';
  if(wantsApprovals&&typeof setTab==='function') setTab('approvals');
  if(panel.classList.contains('on')||wantsApprovals) load();
})();
