// ── POST ADMIN (CMG only) ───────────────────────────────────────────────────
// Add, edit and remove posts on Renew Urban's Approvals tab without touching
// code. Posts and images are stored in Supabase by the server. Saving a post
// puts it (back) in front of the reviewer as Pending.
(function(){
  const app=document.getElementById('app');
  const TZ='America/New_York';
  const IG_MAX_TAGS=5, IG_MAX_CAP=2200;
  const store={
    get(k){ try{ return sessionStorage.getItem(k); }catch(e){ return null; } },
    set(k,v){ try{ v==null?sessionStorage.removeItem(k):sessionStorage.setItem(k,v); }catch(e){} },
  };
  let pass=store.get('ru_admin_pass');
  let posts=[];
  let editing=null; // {id|null, images:[], ...}

  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const tags=t=>(String(t||'').match(/#[\p{L}\p{N}_]+/gu)||[]).length;
  const fmtWhen=iso=>{ const d=new Date(iso); return isNaN(d)?'No time set':d.toLocaleString('en-US',{timeZone:TZ,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' ET'; };

  // Eastern date + time -> UTC ISO string (handles daylight saving).
  function etToIso(date,time){
    if(!date||!time) return '';
    const [y,m,d]=date.split('-').map(Number), [h,mi]=time.split(':').map(Number);
    let guess=Date.UTC(y,m-1,d,h,mi);
    for(let i=0;i<2;i++){
      const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:TZ,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date(guess)).map(x=>[x.type,x.value]));
      const shown=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute);
      guess+=Date.UTC(y,m-1,d,h,mi)-shown;
    }
    return new Date(guess).toISOString();
  }
  function isoToEt(iso){
    const d=new Date(iso); if(!iso||isNaN(d)) return {date:'',time:''};
    const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:TZ,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(d).map(x=>[x.type,x.value]));
    return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};
  }

  async function api(path,opts={}){
    const resp=await fetch('/api/admin'+path,{...opts,headers:{'Content-Type':'application/json','x-admin-passcode':pass||'',...(opts.headers||{})}});
    const body=await resp.json().catch(()=>({}));
    if(!resp.ok){ const e=new Error(body.error||('Request failed ('+resp.status+')')); e.status=resp.status; e.body=body; throw e; }
    return body;
  }

  function gate(msg){
    app.innerHTML=`<div class="ad-card" style="max-width:420px;margin:40px auto">
      <div class="ad-h">Post admin</div>
      <p class="ad-sub">Add posts to Renew Urban's Approvals tab. Enter the admin passcode.</p>
      <form id="gf"><div class="ad-f"><input id="gp" type="password" placeholder="Admin passcode" autocomplete="current-password" required></div>
      <button class="ad-btn ad-pri" type="submit">Open</button></form>
      ${msg?`<div class="ad-msg ad-err">${esc(msg)}</div>`:''}</div>`;
    document.getElementById('gf').onsubmit=e=>{ e.preventDefault(); pass=document.getElementById('gp').value.trim(); store.set('ru_admin_pass',pass); load(); };
  }

  async function load(flash){
    if(!pass){ gate(); return; }
    try{ posts=(await api('/posts')).posts||[]; }
    catch(e){ if(e.status===401||e.status===429||e.status===503){ store.set('ru_admin_pass',null); pass=null; gate(e.message); return; } app.innerHTML=`<div class="ad-msg ad-err">${esc(e.message)}</div>`; return; }
    renderList(flash);
  }

  function statusLine(p){
    const chip=`<span class="ad-chip c-${esc(p.status)}">${p.status==='changes_requested'?'Changes requested':esc(p.status)}</span>`;
    let extra='';
    if(p.status==='approved'&&p.schedule){
      const s=p.schedule.state;
      extra=s==='scheduled'?'Scheduled in Blotato':s==='partial'?'Only partly scheduled: '+esc(p.schedule.error||''):s==='failed'?'Scheduling failed: '+esc(p.schedule.error||''):s==='needs_new_time'?'Approved too late. Pick a new time and save.':s==='manual'?'Auto-scheduling is off. Schedule it by hand.':esc(s||'');
    }
    return chip+(p.reviewerName?`by ${esc(p.reviewerName)} `:'')+extra;
  }

  function renderList(flash){
    const rows=posts.map(p=>`
      <div class="ad-list-item">
        ${p.images[0]?`<img src="${esc(p.images[0])}" alt="">`:p.video?'<div class="ad-vthumb">▶ Video</div>':'<img alt="">'}
        <div class="ad-li-main">
          <div class="ad-li-t">${esc(p.title)}</div>
          <div class="ad-li-s">${esc(fmtWhen(p.plannedAt))} · ${esc(p.format||'')} · ${p.video?'video':`${p.images.length} image${p.images.length===1?'':'s'}`}${p.source==='file'?' · <em>added in code</em>':''}</div>
          <div class="ad-li-s">${statusLine(p)}${p.status==='pending'&&p.source==='admin'?(p.submittedAt?` · <span style="color:var(--green)">Sent to Paige &amp; Andy ${esc(fmtWhen(p.submittedAt))}</span>`:' · <strong style="color:var(--amber)">Not sent yet</strong>'):''}</div>
          ${p.status==='changes_requested'&&p.reviewerNotes?`<div class="ad-note"><strong>${esc(p.reviewerName||'Reviewer')}:</strong> ${esc(p.reviewerNotes)}</div>`:''}
          ${p.status==='pending'&&p.previousRound&&p.previousRound.notes?`<div class="ad-note">Last round, ${esc(p.previousRound.reviewerName||'reviewer')} asked: ${esc(p.previousRound.notes)}</div>`:''}
          ${(p.checks&&p.checks.errors.length)?`<div class="ad-msg ad-err">${p.checks.errors.map(esc).join('<br>')}</div>`:''}
        </div>
        <div class="ad-li-a">
          ${p.source==='admin'?`<button class="ad-btn ad-sec" data-edit="${esc(p.id)}">Edit</button>
          <button class="ad-btn ad-dan" data-del="${esc(p.id)}">Remove</button>`:''}
        </div>
      </div>`).join('');
    app.innerHTML=`
      <div class="ad-card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
          <div><div class="ad-h">Posts on the Approvals tab</div>
          <div class="ad-sub" style="margin:0">Saving a post sends it to Renew Urban as Pending. When they approve it, it schedules itself in Blotato.</div></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="ad-btn ad-sec" id="newBtn">+ New post</button>
            <button class="ad-btn ad-pri" id="submitBtn" ${posts.some(p=>p.status==='pending'&&!(p.checks&&p.checks.errors.length))?'':'disabled'}>Submit for approval</button>
          </div>
        </div>
        ${flash?`<div class="ad-msg ${flash.cls}">${esc(flash.text)}</div>`:''}
        <div style="margin-top:10px">${rows||'<p class="ad-sub" style="margin:12px 0 0">Nothing is waiting for review.</p>'}</div>
      </div>`;
    document.getElementById('newBtn').onclick=()=>openForm(null);
    document.getElementById('submitBtn').onclick=submitForApproval;
    app.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openForm(posts.find(p=>p.id===b.dataset.edit)));
    app.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{
      const p=posts.find(x=>x.id===b.dataset.del);
      if(!confirm(`Remove "${p.title}" from the Approvals tab? This doesn't delete anything already scheduled in Blotato.`)) return;
      b.disabled=true;
      try{ await api('/posts/'+encodeURIComponent(p.id),{method:'DELETE'}); load({cls:'ad-ok',text:`Removed "${p.title}".`}); }
      catch(e){ b.disabled=false; alert(e.message); }
    });
  }

  function openForm(p){
    const et=isoToEt(p&&p.plannedAt);
    editing={id:p?p.id:null,images:p?[...p.images]:[],video:p&&p.video?{...p.video}:null};
    const ig=(p&&p.instagram)||{}, fb=(p&&p.facebook)||{};
    const src=((p&&p.sources)||[]).map(s=>[s.name,s.url].filter(Boolean).join(' | ')).join('\n');
    app.innerHTML=`
      <div class="ad-card">
        <div class="ad-h">${p?'Edit post':'New post'}</div>
        <p class="ad-sub">${p?'Saving sends this back to Renew Urban as Pending, even if they already answered.':'Fill this in and save. It shows up on the Approvals tab right away.'}</p>
        ${p&&p.status==='changes_requested'&&p.reviewerNotes?`<div class="ad-note" style="margin-bottom:12px"><strong>${esc(p.reviewerName||'Reviewer')} asked:</strong> ${esc(p.reviewerNotes)}</div>`:''}
        <div class="ad-f"><label for="f-title">Title</label><input id="f-title" value="${esc(p?p.title:'')}" placeholder="e.g. 3 things that shape a Charleston custom home"></div>
        <div class="ad-row">
          <div class="ad-f"><label for="f-date">Post date (Eastern)</label><input id="f-date" type="date" value="${esc(et.date)}"></div>
          <div class="ad-f"><label for="f-time">Post time (Eastern)</label><input id="f-time" type="time" value="${esc(et.time||'10:00')}"></div>
          <div class="ad-f"><label for="f-format">Format (optional)</label><input id="f-format" value="${esc(p?p.format:'')}" placeholder="Filled in from the image count"></div>
        </div>
        <div class="ad-f"><label>Video (for a Reel)</label>
          <div id="vbox"></div>
          <div class="ad-drop" id="vdrop">Drop a finished MP4 or MOV here, or click to choose. Vertical 9:16 works best on Instagram.<input id="vfile" type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" class="ad-hidden"></div>
          <div id="vmsg"></div>
        </div>
        <div class="ad-f"><label id="imgLabel">Images, in order</label>
          <div class="ad-imgs" id="imgs"></div>
          <div class="ad-drop" id="drop">Drop JPG or PNG files here, or click to choose. The first image is the cover.<input id="file" type="file" accept="image/jpeg,image/png,image/webp" multiple class="ad-hidden"></div>
          <div id="upmsg"></div>
        </div>
        <div class="ad-f"><label for="f-igcap">Instagram caption</label><textarea id="f-igcap" rows="9">${esc(ig.caption||'')}</textarea><div class="ad-meter" id="m-ig"></div></div>
        <div class="ad-row">
          <div class="ad-f"><label for="f-igalt">Instagram alt text</label><input id="f-igalt" value="${esc(ig.altText||'')}"></div>
          <div class="ad-f"><label for="f-igfc">Instagram first comment (optional)</label><input id="f-igfc" value="${esc(ig.firstComment||'')}"></div>
        </div>
        <div class="ad-f"><label for="f-fbcap">Facebook caption <button type="button" class="ad-btn ad-sec" id="copyBtn" style="padding:3px 10px;font-size:11px;margin-left:6px;text-transform:none;letter-spacing:0">Copy from Instagram</button></label><textarea id="f-fbcap" rows="9">${esc(fb.caption||'')}</textarea></div>
        <div class="ad-f"><label for="f-fbfc">Facebook first comment (optional)</label><input id="f-fbfc" value="${esc(fb.firstComment||'')}"></div>
        <div class="ad-f"><label for="f-src">Sources for the reviewer (one per line: name | link)</label><textarea id="f-src" rows="3" style="min-height:70px">${esc(src)}</textarea></div>
        <div class="ad-f"><label for="f-notes">Note to the reviewer (optional)</label><input id="f-notes" value="${esc(p?p.notesForReviewer:'')}" placeholder="e.g. Please confirm the 2 ft flood rule is still current."></div>
        <div id="formmsg"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="ad-btn ad-pri" id="saveBtn">${p?'Save and send for review':'Add for review'}</button>
          <button class="ad-btn ad-sec" id="cancelBtn">Cancel</button>
        </div>
      </div>`;
    const $=id=>document.getElementById(id);
    const meter=()=>{
      const c=$('f-igcap').value, n=tags(c);
      $('m-ig').innerHTML=`<span class="${c.length>IG_MAX_CAP?'bad':''}">${c.length} / ${IG_MAX_CAP} characters</span><span class="${n>IG_MAX_TAGS?'bad':''}">${n} / ${IG_MAX_TAGS} hashtags${n>IG_MAX_TAGS?' — Instagram will reject this':''}</span>`;
    };
    $('f-igcap').oninput=meter; meter();
    $('copyBtn').onclick=()=>{ if(!$('f-fbcap').value.trim()||confirm('Replace the Facebook caption?')) $('f-fbcap').value=$('f-igcap').value; };
    $('cancelBtn').onclick=()=>load();
    renderImgs(); renderVideo();
    const vdrop=$('vdrop'), vfile=$('vfile');
    vdrop.onclick=e=>{ if(e.target!==vfile) vfile.click(); };
    vfile.onchange=()=>{ if(vfile.files[0]) uploadVideo(vfile.files[0]); vfile.value=''; };
    vdrop.ondragover=e=>{ e.preventDefault(); vdrop.classList.add('over'); };
    vdrop.ondragleave=()=>vdrop.classList.remove('over');
    vdrop.ondrop=e=>{ e.preventDefault(); vdrop.classList.remove('over'); const f=e.dataTransfer.files[0]; if(f) uploadVideo(f); };
    const drop=$('drop'), file=$('file');
    drop.onclick=e=>{ if(e.target!==file) file.click(); };
    file.onchange=()=>{ upload([...file.files]); file.value=''; };
    drop.ondragover=e=>{ e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave=()=>drop.classList.remove('over');
    drop.ondrop=e=>{ e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); };
    $('saveBtn').onclick=save;
  }

  function renderImgs(){
    const box=document.getElementById('imgs');
    box.innerHTML=editing.images.map((u,i)=>`
      <div class="ad-img"><img src="${esc(u)}" alt="Slide ${i+1}">
        <div class="ad-ic"><button data-l="${i}" title="Move left" ${i===0?'disabled':''}>◀</button><span>${i+1}</span><button data-r="${i}" title="Move right" ${i===editing.images.length-1?'disabled':''}>▶</button><button data-x="${i}" title="Remove">✕</button></div>
      </div>`).join('');
    box.querySelectorAll('[data-l]').forEach(b=>b.onclick=()=>{ const i=+b.dataset.l; [editing.images[i-1],editing.images[i]]=[editing.images[i],editing.images[i-1]]; renderImgs(); });
    box.querySelectorAll('[data-r]').forEach(b=>b.onclick=()=>{ const i=+b.dataset.r; [editing.images[i+1],editing.images[i]]=[editing.images[i],editing.images[i+1]]; renderImgs(); });
    box.querySelectorAll('[data-x]').forEach(b=>b.onclick=()=>{ editing.images.splice(+b.dataset.x,1); renderImgs(); });
  }

  const toB64=f=>new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(String(r.result).split(',')[1]); r.onerror=()=>rej(r.error); r.readAsDataURL(f); });

  async function upload(files){
    const msg=document.getElementById('upmsg');
    files=files.filter(f=>/^image\/(jpeg|png|webp)$/.test(f.type)).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
    if(!files.length){ msg.innerHTML='<div class="ad-msg ad-err">Only JPG, PNG or WebP images.</div>'; return; }
    let done=0;
    for(const f of files){
      msg.innerHTML=`<div class="ad-msg ad-warn">Uploading ${done+1} of ${files.length}: ${esc(f.name)}…</div>`;
      if(f.size>12*1024*1024){ msg.innerHTML=`<div class="ad-msg ad-err">${esc(f.name)} is over 12 MB.</div>`; return; }
      try{
        const {url}=await api('/images',{method:'POST',body:JSON.stringify({filename:f.name,contentType:f.type,data:await toB64(f)})});
        editing.images.push(url); done++; renderImgs();
      }catch(e){ msg.innerHTML=`<div class="ad-msg ad-err">${esc(f.name)}: ${esc(e.message)}</div>`; return; }
    }
    msg.innerHTML=`<div class="ad-msg ad-ok">Uploaded ${done} image${done===1?'':'s'}.</div>`;
  }

  function renderVideo(){
    const box=document.getElementById('vbox'), lbl=document.getElementById('imgLabel'); if(!box) return;
    const v=editing.video;
    box.innerHTML=v?`<div class="ad-vid"><video src="${esc(v.url)}" controls playsinline preload="metadata"></video>
      <div class="ad-li-s">${v.width&&v.height?`${v.width}×${v.height}`:''}${v.duration?` · ${v.duration}s`:''}${v.width&&v.height&&Math.abs(v.width/v.height-9/16)>0.02?' · <strong style="color:var(--red)">Not vertical 9:16 — it will be letterboxed on Instagram</strong>':''}</div>
      <button type="button" class="ad-btn ad-dan" id="vrm" style="padding:4px 12px;font-size:12px;margin-top:6px">Remove video</button></div>`:'';
    document.getElementById('vdrop').classList.toggle('ad-hidden',!!v);
    lbl.textContent=v?'Cover image (optional, one image)':'Images, in order';
    if(v) document.getElementById('vrm').onclick=()=>{ editing.video=null; renderVideo(); };
  }

  function videoMeta(file){
    return new Promise(res=>{ const el=document.createElement('video'); el.preload='metadata'; const u=URL.createObjectURL(file);
      el.onloadedmetadata=()=>{ res({width:el.videoWidth,height:el.videoHeight,duration:Math.round(el.duration)}); URL.revokeObjectURL(u); };
      el.onerror=()=>{ res({}); URL.revokeObjectURL(u); }; el.src=u; });
  }

  async function uploadVideo(f){
    const msg=document.getElementById('vmsg');
    if(!/\.(mp4|mov|m4v)$/i.test(f.name)){ msg.innerHTML='<div class="ad-msg ad-err">Use an MP4 or MOV file.</div>'; return; }
    msg.innerHTML=`<div class="ad-msg ad-warn">Preparing upload…</div>`;
    try{
      const meta=await videoMeta(f);
      const {uploadUrl,publicUrl}=await api('/video-upload',{method:'POST',body:JSON.stringify({filename:f.name})});
      await new Promise((res,rej)=>{
        const x=new XMLHttpRequest(); x.open('PUT',uploadUrl); x.setRequestHeader('Content-Type',f.type||'video/mp4');
        x.upload.onprogress=e=>{ if(e.lengthComputable) msg.innerHTML=`<div class="ad-msg ad-warn">Uploading ${esc(f.name)}: ${Math.round(e.loaded/e.total*100)}%</div>`; };
        x.onload=()=>x.status>=200&&x.status<300?res():rej(new Error('Upload failed ('+x.status+')'));
        x.onerror=()=>rej(new Error('Upload failed. Check your connection and try again.'));
        x.send(f);
      });
      editing.video={url:publicUrl,...meta};
      if(editing.images.length>1) editing.images=editing.images.slice(0,1);
      renderVideo(); renderImgs();
      msg.innerHTML=`<div class="ad-msg ad-ok">Uploaded ${esc(f.name)} (${(f.size/1048576).toFixed(0)} MB).</div>`;
    }catch(e){ msg.innerHTML=`<div class="ad-msg ad-err">${esc(e.message)}</div>`; }
  }

  async function submitForApproval(){
    const ready=posts.filter(p=>p.status==='pending'&&!(p.checks&&p.checks.errors.length));
    if(!ready.length) return;
    const list=ready.map(p=>'• '+p.title+' ('+fmtWhen(p.plannedAt)+')').join('\n');
    if(!confirm(`Email Paige and Andy to review ${ready.length} post${ready.length===1?'':'s'}?\n\n${list}`)) return;
    const b=document.getElementById('submitBtn'); b.disabled=true; b.textContent='Sending…';
    try{ const r=await api('/submit',{method:'POST',body:'{}'}); load({cls:'ad-ok',text:`Sent to ${r.to.join(' and ')}: ${r.sent} post${r.sent===1?'':'s'} waiting for approval.`}); }
    catch(e){ b.disabled=false; b.textContent='Submit for approval'; load({cls:'ad-err',text:e.message}); }
  }

  async function save(){
    const $=id=>document.getElementById(id), msg=$('formmsg'), btn=$('saveBtn');
    const sources=$('f-src').value.split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{
      const [a,b]=l.split('|').map(x=>x.trim()); return /^https?:\/\//i.test(a)&&!b?{name:a,url:a}:{name:a||b,url:b||''};
    });
    const post={
      title:$('f-title').value, format:$('f-format').value,
      plannedAt:etToIso($('f-date').value,$('f-time').value),
      images:editing.images, video:editing.video,
      instagram:{caption:$('f-igcap').value,altText:$('f-igalt').value,firstComment:$('f-igfc').value},
      facebook:{caption:$('f-fbcap').value,firstComment:$('f-fbfc').value},
      sources, notesForReviewer:$('f-notes').value,
    };
    btn.disabled=true; msg.innerHTML='';
    try{
      const r=await api('/posts',{method:'POST',body:JSON.stringify({id:editing.id,post})});
      load({cls:r.warnings&&r.warnings.length?'ad-warn':'ad-ok',text:`Saved "${post.title}". It's on the Approvals tab as Pending.`+(r.warnings&&r.warnings.length?' '+r.warnings.join(' '):'')});
    }catch(e){
      btn.disabled=false;
      const errs=(e.body&&e.body.errors)||[e.message];
      msg.innerHTML=`<div class="ad-msg ad-err">${errs.map(esc).join('<br>')}</div>`;
    }
  }

  load();
})();
