const $=id=>document.getElementById(id);
const state={context:null,demo:false,preview:null,selection:new Map(),availabilityArgs:null};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const localDate=d=>new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Melbourne',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const plus=(s,n)=>new Date(Date.parse(s+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const pretty=s=>new Intl.DateTimeFormat('en-AU',{day:'numeric',month:'short',weekday:'short',timeZone:'UTC'}).format(new Date(s+'T00:00:00Z'));
const clock=s=>s?new Intl.DateTimeFormat('en-AU',{hour:'numeric',minute:'2-digit',timeZone:'Australia/Melbourne'}).format(new Date(s)):'';
let noticeTimer;
function notice(message,error=false) {
  $('notice').textContent=message;$('notice').hidden=false;$('notice').style.background=error?'#88452d':'#153d37';
  clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('notice').hidden=true,error?14000:6500);
}
async function api(path,body) {
  const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-TheirCare-UI':'1'},body:body?JSON.stringify(body):undefined});
  const data=await r.json(); if(!r.ok) throw Error(data.error||'Could not complete the request.'); return data;
}
function tab(name) {
  document.querySelectorAll('.view').forEach(e=>e.hidden=e.id!==name);
  document.querySelectorAll('nav button').forEach(e=>e.classList.toggle('active',e.dataset.tab===name));
}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{tab(b.dataset.tab);if(b.dataset.tab==='review')refreshPreview().catch(e=>notice(e.message,true));});
async function busy(element,fn) {
  element.classList.add('loading');try{return await fn();}catch(e){notice(e.message,true);}finally{element.classList.remove('loading');}
}
function options(id,items){$(id).innerHTML=items.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join('');}
async function connected() {
  const status=await api('status');
  state.demo=status.demo;
  $('badge').textContent=status.demo?'Sample mode':status.signed_in?'Connected · '+(status.remote?'Home server':'This Mac'):status.remote?'Home server':'Local prototype';
  $('welcome').hidden=status.signed_in;$('workspace').hidden=!status.signed_in;$('logout').hidden=!status.signed_in;
  $('demo-banner').hidden=!status.demo;
  if(!status.signed_in) return;
  state.context=await api('context');
  options('child',state.context.children);options('care',state.context.care_types);options('service',state.context.services);
  $('service-label').textContent=state.context.services[0]?.name||'Your family';
  await loadBookings();await refreshPreview();
}
$('login').onsubmit=e=>{e.preventDefault();busy($('login'),async()=>{
  const f=new FormData(e.target),body={email:f.get('email'),password:f.get('password')};
  e.target.elements.password.value='';
  try{await api('login',body);}finally{body.password='';}
  await connected();notice('Connected to TheirCare.');
});};
$('demo').onclick=()=>busy($('welcome'),async()=>{await api('demo',{});await connected();});
$('logout').onclick=()=>busy($('workspace'),async()=>{await api('logout',{});state.preview=null;state.selection.clear();await connected();});
async function loadBookings() {
  const result=await api('bookings',{start:$('book-start').value,end:plus($('book-end').value,1)});
  $('booking-results').innerHTML=result.bookings.length?result.bookings.sort((a,b)=>a.start.localeCompare(b.start)).map(b=>{
    const date=b.start.slice(0,10),parts=pretty(date).split(' ');
    return '<article class="booking-row"><div class="date-block">'+esc(parts[0])+'<strong>'+esc(date.slice(8))+'</strong>'+esc(parts.at(-1))+'</div><div><h3>'+esc(b.title)+'</h3><p>'+esc(clock(b.start))+' – '+esc(clock(b.end))+'</p></div><span class="tag">Booked</span></article>';
  }).join(''):'<div class="empty"><h2>A little breathing room.</h2><p>No saved bookings in this date range.</p></div>';
}
$('booking-range').onsubmit=e=>{e.preventDefault();busy($('bookings'),loadBookings);};
function selectionBar() {
  $('selection-bar').hidden=!state.selection.size;
  $('selection-count').textContent=state.selection.size+' '+(state.selection.size===1?'change':'changes')+' selected';
}
$('availability-form').onsubmit=e=>{e.preventDefault();busy($('availability-form'),async()=>{
  const start=$('avail-start').value,end=plus($('avail-end').value,1);
  const args={child_id:$('child').value,care_type_id:$('care').value,service_id:$('service').value,year:Number(start.slice(0,4)),start,end};
  const data=await api('availability',args);
  state.availabilityArgs=args;state.selection.clear();selectionBar();
  $('conditions').textContent=data.conditions;$('conditions').hidden=!data.conditions;
  $('availability-results').innerHTML=data.days.map(d=>{
    const action=d.booked||d.on_waitlist?(d.can_cancel?'cancel':null):d.available?'book':d.waitlist_available?'waitlist':null;
    const label=d.booked?'Booked':d.on_waitlist?'On waitlist':d.available?'Available':d.waitlist_available?'Waitlist available':d.full?'Full':'Unavailable';
    return '<button class="day" data-date="'+esc(d.date)+'" data-action="'+esc(action||'')+'" '+(!action||d.past?'disabled':'')+'><small>'+esc(pretty(d.date))+'</small><strong>'+esc(d.date.slice(8))+'</strong><span class="tag">'+esc(label)+'</span><small style="display:block;margin-top:8px">'+(action==='cancel'?'Select to cancel':action==='waitlist'?'Select to join waitlist':action==='book'?'Select to book':'')+'</small></button>';
  }).join('')||'<div class="empty">No sessions in this range.</div>';
  document.querySelectorAll('.day').forEach(b=>b.onclick=()=>{
    const date=b.dataset.date;
    if(state.selection.has(date)) state.selection.delete(date);else state.selection.set(date,b.dataset.action);
    b.classList.toggle('selected',state.selection.has(date));selectionBar();
  });
});};
$('make-preview').onclick=()=>busy($('availability'),async()=>{
  if(!state.selection.size)return;
  const data=await api('preview',{...state.availabilityArgs,changes:[...state.selection].map(([date,action])=>({date,action}))});
  renderPreview(data);tab('review');notice('Preview ready. Nothing has been saved.');
});
function renderPreview(p) {
  state.preview=p;$('review-empty').hidden=!!p;$('review-content').hidden=!p;
  $('review-count').textContent=p?'· '+p.changes.length:'';
  if(!p) { $('review-content').innerHTML='';return; }
  const changes=p.changes.map(c=>'<div class="change"><strong>'+esc(pretty(c.date))+'</strong><span>'+esc(c.action==='book'?'Add booking':c.action==='cancel'?'Cancel booking':'Join waitlist')+'</span></div>').join('');
  $('review-content').innerHTML='<article class="panel review-panel"><div class="review-title"><span class="eyebrow">Review before saving</span><span class="tag">Not saved</span></div><h2>'+esc(p.child)+' · '+esc(p.care_type)+'</h2><p class="muted">'+esc(p.service)+'</p>'+changes+
    '<details open><summary>Session information & fees</summary><p>'+esc(p.session_conditions)+'</p></details>'+
    '<details open><summary>Cancellation policy</summary><p>'+esc(p.cancellation_policy)+'</p></details>'+
    '<details><summary>Booking terms & conditions — read before saving</summary><p>'+esc(p.terms)+'</p></details>'+
    '<label class="accept"><input type="checkbox" id="accept-terms">I have reviewed these exact changes and the conditions above, and accept TheirCare’s booking terms.</label>'+
    '<div class="review-actions"><button class="primary" id="confirm" disabled>'+(state.demo?'Sample preview only':'Confirm & save to TheirCare')+'</button><button class="quiet" id="discard">Discard preview</button></div>'+
    '<p class="expiry">Preview expires '+esc(new Date(p.expires_at).toLocaleTimeString('en-AU',{hour:'numeric',minute:'2-digit'}))+'. Saved bookings will be checked after submission.</p></article>';
  $('accept-terms').onchange=()=>{$('confirm').disabled=state.demo||!$('accept-terms').checked||Date.now()>=Date.parse(p.expires_at);};
  $('discard').onclick=()=>busy($('review-content'),async()=>{await api('discard',{});renderPreview(null);state.selection.clear();selectionBar();notice('Unsaved preview discarded.');});
  $('confirm').onclick=()=>busy($('review-content'),async()=>{
    if(!$('accept-terms').checked||state.demo)return;
    $('confirm').disabled=true;
    try{const result=await api('confirm',{id:p.id,accept_terms:true});renderPreview(null);await loadBookings();tab('bookings');notice(result.verified?'Saved and checked against TheirCare’s calendar.':'Check TheirCare for the result.');}
    catch(e){renderPreview(null);throw e;}
  });
}
async function refreshPreview(){renderPreview(await api('preview'));}
const today=localDate(new Date());
$('today').textContent=new Intl.DateTimeFormat('en-AU',{dateStyle:'long',timeZone:'Australia/Melbourne'}).format(new Date());
$('book-start').value=today;$('book-end').value=plus(today,28);$('avail-start').value=today;$('avail-end').value=plus(today,14);
connected().catch(e=>notice(e.message,true));
setInterval(async()=>{if(!$('workspace').hidden){try{const p=await api('preview');if(p?.id!==state.preview?.id)renderPreview(p);}catch{}}},10000);
