import test from 'node:test';
import assert from 'node:assert/strict';
import { TheirCare, parseCalendar, parseReview, makePlan, isoDate, dateRange, melbourneMidnight } from '../src/portal.js';
import { calendarFixture, reviewFixture, demoFetch } from '../src/demo.js';
import { createCompanion } from '../src/companion.js';
import http from 'node:http';
const args={child_id:'1',care_type_id:'10',year:2026};
const change={date:'2026-10-28',action:'book'};
function client(fetchImpl=demoFetch()){const p=new TheirCare({fetchImpl});p.authenticated=true;return p;}
test('real dates and bounded ranges',()=>{
  assert.throws(()=>isoDate('2026-02-30'));assert.throws(()=>isoDate('tomorrow'));
  assert.throws(()=>dateRange('2026-10-20','2026-10-19'));
  assert.throws(()=>dateRange('2026-01-01','2026-12-31'));
  assert.equal(isoDate('2028-02-29'),'2028-02-29');
});
test('Melbourne date bounds handle daylight-saving transitions at midnight',()=>{
  assert.equal(melbourneMidnight('2026-10-04'),'2026-10-04T00:00:00+10:00');
  assert.equal(melbourneMidnight('2026-10-05'),'2026-10-05T00:00:00+11:00');
  assert.equal(melbourneMidnight('2026-04-05'),'2026-04-05T00:00:00+11:00');
  assert.equal(melbourneMidnight('2026-04-06'),'2026-04-06T00:00:00+10:00');
});
test('calendar parses saved status separately from empty submission fields',()=>{
  const c=parseCalendar(calendarFixture({saved:{'2026-10-23':'BOOKED'}}));
  assert.equal(c.days.find(d=>d.date==='2026-10-23').booked,true);
  assert.equal(c.days.find(d=>d.date==='2026-10-28').available,true);
  assert.equal(makePlan(c,[change])[0].status,'BOOKED');
  assert.equal(makePlan(c,[{date:'2026-10-23',action:'cancel'}])[0].status,'CANCELLED');
});
test('refuse duplicate, full, past and invalid actions',()=>{
  const c=parseCalendar(calendarFixture());
  assert.throws(()=>makePlan(c,[change,change]));
  assert.throws(()=>makePlan(c,[{...change,action:'cancel'}]));
  c.days.find(d=>d.date===change.date).past=true;
  assert.throws(()=>makePlan(c,[change]));
});
test('mismatched or additional review changes are rejected',()=>{
  const plan=[{date:change.date,status:'BOOKED'}];
  assert.throws(()=>parseReview(reviewFixture([...plan,{date:'2026-10-29',status:'BOOKED'}]),plan),{code:'PREVIEW_MISMATCH'});
  assert.throws(()=>parseReview('<form id="entityForm">Error</form>',plan),{code:'PREVIEW_REJECTED'});
});
test('context outputs only children and service choices',async()=>{
  const c=await client().context();assert.equal(c.children[0].name,'Maya Sample');assert.equal(c.care_types.length,2);
  assert.deepEqual(Object.keys(c).sort(),['care_types','children','services']);
});
test('date filter excludes events at the exclusive end',async()=>{
  const b=await client().bookings({start:'2026-10-23',end:'2026-10-27'});
  assert.equal(b.bookings.length,2);assert.ok(b.bookings.every(e=>e.start.startsWith('2026-10-23')));
});
test('preview does not save, and never exposes CSRF/request tokens',async()=>{
  let commits=0;const fake=demoFetch();const p=client(async(url,o)=>{if(new URLSearchParams(o.body).get('action')==='submitConfirm')commits++;return fake(url,o);});
  const preview=await p.previewChanges({...args,changes:[change]});
  assert.equal(commits,0);assert.equal(preview.changes[0].date,change.date);
  assert.ok(!JSON.stringify(preview).includes('sample-token'));
  const after=await p.availability({...args,start:'2026-10-28',end:'2026-10-29'});
  assert.equal(after.days[0].booked,false);
});
test('save refreshes review, submits once, verifies saved calendar and cannot replay',async()=>{
  let commits=0,previews=0;const fake=demoFetch({allowSave:true});const p=client(async(url,o)=>{
    const action=new URLSearchParams(o.body).get('action');
    if(action==='submitConfirm')commits++;if(action==='submitCal')previews++;return fake(url,o);
  });
  const preview=await p.previewChanges({...args,changes:[change]});
  const result=await p.confirm(preview.id);
  assert.equal(result.verified,true);assert.equal(commits,1);assert.equal(previews,2);
  await assert.rejects(()=>p.confirm(preview.id),{code:'PREVIEW_EXPIRED'});
});
test('expired previews cannot commit',async()=>{
  const p=client(),v=await p.previewChanges({...args,changes:[change]});
  p.preview.publicPart.expires_at='2000-01-01T00:00:00Z';
  await assert.rejects(()=>p.confirm(v.id),{code:'PREVIEW_EXPIRED'});
});
test('new booking state invalidates pending action before save',async()=>{
  const fake=demoFetch();let changed=false,commits=0;
  const p=client(async(url,o)=>{
    const action=new URLSearchParams(o.body).get('action');if(action==='submitConfirm')commits++;
    if(changed&&o.method==='GET'&&new URL(url).searchParams.get('child')) return new Response(calendarFixture({saved:{[change.date]:'BOOKED'}}));
    return fake(url,o);
  });
  const v=await p.previewChanges({...args,changes:[change]});changed=true;
  await assert.rejects(()=>p.confirm(v.id),{code:'UNAVAILABLE'});assert.equal(commits,0);assert.equal(p.preview,null);
});
test('changed terms cannot be silently accepted',async()=>{
  const fake=demoFetch();let changed=false,commits=0;
  const p=client(async(url,o)=>{
    const fields=new URLSearchParams(o.body);
    if(fields.get('action')==='submitConfirm')commits++;
    if(changed&&fields.get('action')==='submitCal') return new Response(reviewFixture([{date:change.date,status:'BOOKED'}],{extra:' NEW FEE'}));
    return fake(url,o);
  });
  const v=await p.previewChanges({...args,changes:[change]});changed=true;
  await assert.rejects(()=>p.confirm(v.id),{code:'PREVIEW_CHANGED'});assert.equal(commits,0);
});
test('ambiguous save failure is consumed and never automatically retried',async()=>{
  const fake=demoFetch();let commits=0;const p=client(async(url,o)=>{
    if(new URLSearchParams(o.body).get('action')==='submitConfirm'){commits++;throw Error('Lost connection');}
    return fake(url,o);
  });
  const v=await p.previewChanges({...args,changes:[change]});
  await assert.rejects(()=>p.confirm(v.id),/uncertain/);
  await assert.rejects(()=>p.confirm(v.id),{code:'PREVIEW_EXPIRED'});assert.equal(commits,1);
});
test('session expiry clears auth and previews',async()=>{
  const p=client(async()=>new Response(null,{status:302,headers:{location:'/family/login'}}));
  p.fetchImpl=async(url)=>new Response('<form id="signInFrm"></form>');
  await assert.rejects(()=>p.context(),{code:'LOGIN_REQUIRED'});assert.equal(p.authenticated,false);
});
test('external redirects never receive cookies or credentials',async()=>{
  let calls=0;const p=client(async()=>{calls++;return new Response(null,{status:307,headers:{location:'https://example.com/family/steal'}});});
  await assert.rejects(()=>p.request('/family/login',{method:'POST',fields:new URLSearchParams({j_password:'fictional'}),allowLogin:true}),{code:'DESTINATION_BLOCKED'});
  assert.equal(calls,1);
});
test('concurrent operations serialize rather than overwrite pending review tokens',async()=>{
  const p=client(),order=[];
  await Promise.all([p.serial(async()=>{order.push(1);await new Promise(r=>setTimeout(r,10));order.push(2);}),p.serial(async()=>order.push(3))]);
  assert.deepEqual(order,[1,2,3]);
});
test('companion rejects cross-site requests, unknown hosts and AI final save',async()=>{
  // Native fetch normalizes Host. Use HTTP directly to exercise DNS-rebinding checks.
  const request=(url,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
    const req=http.request(url,{method,headers},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,json:async()=>JSON.parse(Buffer.concat(chunks))}));
    });req.on('error',reject);if(body)req.write(body);req.end();
  });
  const {app,token}=createCompanion({portal:client()});
  const srv=app.listen(0,'127.0.0.1');await new Promise(r=>srv.once('listening',r));
  const base='http://127.0.0.1:'+srv.address().port,host='127.0.0.1:43817';
  try {
    assert.equal((await request(base+'/api/status',{headers:{Host:host}})).status,401);
    assert.equal((await request(base+'/api/status',{headers:{Host:'evil.example',Authorization:'Bearer '+token}})).status,403);
    assert.equal((await request(base+'/api/status',{headers:{Host:host,Origin:'https://evil.example',Authorization:'Bearer '+token}})).status,403);
    assert.equal((await request(base+'/api/status',{headers:{Host:host,Authorization:'Bearer '+token}})).status,200);
    const saved=await request(base+'/api/confirm',{method:'POST',headers:{Host:host,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({id:'whatever',accept_terms:true})});
    assert.equal(saved.status,400);assert.equal((await saved.json()).code,'HUMAN_CONFIRMATION_REQUIRED');
  } finally {await new Promise(r=>srv.close(r));}
});
test('password login sends CSRF and cookies only to the official destination',async()=>{
  const calls=[];
  const p=new TheirCare({fetchImpl:async(url,opts)=>{
    calls.push({url,method:opts.method});
    if(url.endsWith('/family/login')) return new Response('<form id="signInFrm" action="j_spring_security_check"><input name="_csrf" value="fixture-csrf"></form>',{headers:{'Set-Cookie':'JSESSIONID=fixture-only; Path=/family; Secure; HttpOnly'}});
    if(url.endsWith('/family/j_spring_security_check')) {
      const fields=new URLSearchParams(opts.body);
      assert.equal(fields.get('_csrf'),'fixture-csrf');
      assert.equal(fields.get('j_username'),'sample@example.invalid');
      assert.equal(fields.get('j_password'),'fictional-password');
      assert.match(opts.headers.Cookie,/JSESSIONID=fixture-only/);
      return new Response(null,{status:302,headers:{Location:'/family/dashboard'}});
    }
    return new Response('<h1>Dashboard</h1>');
  }});
  await p.login('sample@example.invalid','fictional-password');assert.equal(p.authenticated,true);
  assert.ok(calls.every(c=>c.url.startsWith('https://theircare.fullybookedccms.com.au/family/')));
});
test('successful-looking save without updated calendar is not reported as verified',async()=>{
  const fake=demoFetch(),p=client(async(url,opts)=>{
    if(new URLSearchParams(opts.body).get('action')==='submitConfirm') return new Response('<p>Success</p>');
    return fake(url,opts);
  });
  const v=await p.previewChanges({...args,changes:[change]});
  await assert.rejects(()=>p.confirm(v.id),{code:'SAVE_UNVERIFIED'});
});
test('relative booking links work when the dashboard has unloaded AJAX cards',async()=>{
  const p=client(async(url)=>{
    const u=new URL(url);
    if(u.pathname==='/family/dashboard')return new Response('<div class="card" data-url="portlet/children"><h3>Children</h3></div>');
    if(u.pathname==='/family/bookings/edit')return new Response('<button class="dropdown-toggle">Sample School</button><a href="edit?careType=10&child=&year=2026">After School Care</a><a href="edit?careType=&child=1&year=2026">Maya Sample</a>');
    throw Error('Unexpected URL');
  });
  const context=await p.context();
  assert.deepEqual(context.children,[{id:'1',name:'Maya Sample'}]);
  assert.deepEqual(context.care_types,[{id:'10',name:'After School Care'}]);
});
test('only the declared Children card is fetched when menu omits children',async()=>{
  const requested=[];const p=client(async(url)=>{
    const u=new URL(url);requested.push(u.pathname);
    if(u.pathname==='/family/dashboard')return new Response('<div class="card" data-url="portlet/children"><h3>Children</h3></div><div class="card" data-url="portlet/contacts"><h3>Parents</h3></div>');
    if(u.pathname==='/family/bookings/edit')return new Response('<a href="edit?careType=10">After School Care</a>');
    if(u.pathname==='/family/portlet/children')return new Response('<table><tr><td>Maya Sample</td><td><a href="/family/child/1/edit">Update Child</a></td></tr></table>');
    throw Error('Unexpected URL');
  });
  const context=await p.context();assert.equal(context.children[0].name,'Maya Sample');
  assert.ok(!requested.includes('/family/portlet/contacts'));
});
test('FullyBooked Z-marked clock values match the portal local display',async()=>{
  const p=client(async()=>Response.json([{id:'fixture',title:'After School Care: Sample',start:'2026-10-23T15:30:00.000Z',end:'2026-10-23T18:30:00.000Z'}]));
  const b=await p.bookings({start:'2026-10-23',end:'2026-10-24'});
  assert.equal(b.bookings[0].start,'2026-10-23T15:30:00.000+11:00');
  assert.equal(b.bookings[0].end,'2026-10-23T18:30:00.000+11:00');
  assert.equal(new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Melbourne',hour:'numeric',minute:'2-digit'}).format(new Date(b.bookings[0].start)),'3:30 pm');
});
test('preview preserves historical and unrelated booked statuses exactly',async()=>{
  const saved={'2026-01-28':'BOOKED','2026-10-23':'BOOKED'},fake=demoFetch();
  let checked=false;
  const p=client(async(url,opts)=>{
    const u=new URL(url);
    if(opts.method==='GET'&&u.pathname==='/family/bookings/edit'&&u.searchParams.get('child'))
      return new Response(calendarFixture({saved}));
    const fields=new URLSearchParams(opts.body);
    if(fields.get('action')==='submitCal'){
      assert.equal(fields.get('bookings[28-01-2026].bookingStatus'),'BOOKED');
      assert.equal(fields.get('bookings[23-10-2026].bookingStatus'),'BOOKED');
      assert.equal(fields.get('bookings[28-10-2026].bookingStatus'),'BOOKED');
      assert.equal(fields.get('bookings[29-10-2026].bookingStatus'),'');
      checked=true;
      return new Response(reviewFixture([{date:'2026-10-28',status:'BOOKED'}]));
    }
    return fake(url,opts);
  });
  await p.previewChanges({...args,changes:[change]});assert.equal(checked,true);
});
