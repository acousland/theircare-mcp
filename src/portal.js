import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import { randomUUID, createHash } from 'node:crypto';

export const ORIGIN = 'https://theircare.fullybookedccms.com.au';
export class PortalError extends Error {
  constructor(message, code = 'PORTAL_ERROR') { super(message); this.code = code; }
}
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const fail = (message, code) => { throw new PortalError(message, code); };
export function isoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(Date.parse(value+'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0,10) !== value)
    fail('Use a real date in YYYY-MM-DD format.', 'INVALID_INPUT');
  return value;
}
export function dateRange(start, end) {
  isoDate(start); isoDate(end);
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  if (days < 1 || days > 93) fail('Choose a range of 1 to 93 days; end is exclusive.', 'INVALID_INPUT');
}
export function melbourneMidnight(date) {
  isoDate(date);
  const nominal=Date.parse(date+'T00:00:00Z');
  let instant=nominal, offset='';
  for(let i=0;i<3;i++) {
    offset=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Melbourne',timeZoneName:'longOffset'}).formatToParts(new Date(instant)).find(p=>p.type==='timeZoneName').value.replace('GMT','');
    const sign=offset[0]==='-'?-1:1, [h,m]=offset.slice(1).split(':').map(Number);
    instant=nominal-sign*(h*60+m)*60000;
  }
  return date+'T00:00:00'+offset;
}
// FullyBooked's calendar emits local clock components with a trailing Z.
// Its own FullCalendar view preserves those components (UTC coercion), e.g.
// feed 15:30Z is displayed as 3:30 PM, not 2:30 AM the following day.
export function calendarTime(value) {
  if(typeof value!=='string') return value;
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value))
    return value.slice(0,-1)+melbourneMidnight(value.slice(0,10)).slice(19);
  return value;
}
const dmy = iso => iso.split('-').reverse().join('-');
const fromDMY = s => s.split('-').reverse().join('-');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fieldDate(name) {
  const m = /^bookings\[['"]?(\d{2}-\d{2}-\d{4})['"]?\]\.bookingStatus$/.exec(name);
  return m ? fromDMY(m[1]) : null;
}
export function formFields($, form) {
  const result = new URLSearchParams();
  form.find('input[name],select[name],textarea[name]').each((_, el) => {
    const e = $(el), type = (e.attr('type') || '').toLowerCase();
    if (e.is(':disabled') || ['submit','button','file','reset'].includes(type)) return;
    if (['checkbox','radio'].includes(type) && !e.is(':checked')) return;
    if (e.is('select')) {
      const opts = e.find('option:selected');
      const selection = opts.length ? opts : e.find('option').first();
      selection.each((_, o) => result.append(e.attr('name'), $(o).attr('value') ?? $(o).text()));
    } else result.append(e.attr('name'), e.attr('value') ?? (e.is('textarea') ? e.text() : ''));
  });
  return result;
}
export function parseCalendar(html, { start, end } = {}) {
  const $ = cheerio.load(html), form = $('#entityForm');
  if (!form.length || !form.find('[name="_requestToken"]').length || !$('#multimonth').length)
    fail('The booking page has changed or needs additional account setup. Open TheirCare to check.', 'UNSUPPORTED_PAGE');
  const days = [];
  $('#multimonth td[data-fb-date]').each((_, el) => {
    const e = $(el), date = fromDMY(e.attr('data-fb-date'));
    if ((start && date < start) || (end && date >= end)) return;
    const classes = (e.attr('class') || '').split(/\s+/), has = c => classes.includes(c);
    days.push({ date, status: e.attr('data-original-value') || '',
      available: has('available'), booked: has('savedBooking') || has('booked'),
      can_cancel: has('allowCancel'), waitlist_available: has('waitlistAvailable'),
      on_waitlist: has('waitlistBooked'), full: has('full'), almost_full: has('almostFull'),
      past: has('past'), description: clean(cheerio.load(e.attr('data-content') || '').text()) });
  });
  const dropdowns = form.find('.dropdown-toggle').map((_,e) => clean($(e).text())).get();
  return { $, form, days, conditions: clean($('#bookingMessageBlock').text().replace(/Close/g,'')), dropdowns };
}
export function makePlan(calendar, changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 31) fail('Select 1 to 31 dates.', 'INVALID_INPUT');
  const seen = new Set();
  const result = changes.map(c => {
    isoDate(c.date);
    if (seen.has(c.date)) fail('Each date can appear only once.', 'INVALID_INPUT');
    seen.add(c.date);
    if (!['book','cancel','waitlist'].includes(c.action)) fail('Action must be book, cancel or waitlist.', 'INVALID_INPUT');
    const day = calendar.days.find(d => d.date === c.date);
    if (!day || day.past) fail('Date is unavailable: ' + c.date, 'UNAVAILABLE');
    let status;
    if (c.action === 'book' && day.available && !day.booked) status = 'BOOKED';
    if (c.action === 'cancel' && day.can_cancel && (day.booked || day.on_waitlist)) status = 'CANCELLED';
    if (c.action === 'waitlist' && day.waitlist_available && !day.on_waitlist) status = 'AWAITING_BOOKING';
    if (!status) fail('This action is not allowed for ' + c.date + '. Refresh availability.', 'UNAVAILABLE');
    return { date:c.date, action:c.action, status, original_status:day.status };
  });
  return result.sort((a,b)=>a.date.localeCompare(b.date));
}
export function parseReview(html, expected) {
  const $ = cheerio.load(html), form = $('#entityForm');
  if (!form.find('button[name="action"][value="submitConfirm"]').length)
    fail('TheirCare did not return a final review. ' + clean($('.alert-text,.alert-danger').text()).slice(0,300), 'PREVIEW_REJECTED');
  const fields = formFields($,form), actual = [];
  for (const [name,value] of fields) { const date = fieldDate(name); if (date && value) actual.push({date,status:value}); }
  actual.sort((a,b)=>a.date.localeCompare(b.date));
  const wanted = expected.map(({date,status})=>({date,status})).sort((a,b)=>a.date.localeCompare(b.date));
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail('TheirCare review differs from the requested dates. Nothing was saved.', 'PREVIEW_MISMATCH');
  if (!fields.get('_csrf') || !fields.get('_requestToken')) fail('Missing confirmation tokens.', 'UNSUPPORTED_PAGE');
  fields.delete('optinBookingConfirmation');
  return { fields, conditions: clean($('#cancellationPolicyCard').text()), terms: clean($('#bookingTermsCard').text()),
    summary: form.find('table').map((_,e)=>clean($(e).text())).get(),
    fingerprint:hash({actual, conditions:clean($('#cancellationPolicyCard').text()),terms:clean($('#bookingTermsCard').text())}) };
}

export class TheirCare {
  constructor({fetchImpl = fetch} = {}) {
    this.fetchImpl = fetchImpl; this.reset(); this.queue = Promise.resolve();
  }
  reset() { this.jar = new CookieJar(); this.authenticated = false; this.preview = null; this.generation = randomUUID(); }
  async serial(fn) {
    const task = this.queue.then(fn,fn); this.queue = task.catch(()=>{}); return task;
  }
  async request(path, {method='GET',fields,allowLogin=false} = {}) {
    let url = new URL(path,ORIGIN), body = fields?.toString();
    for (let redirects=0; redirects<8; redirects++) {
      if (url.origin !== ORIGIN || !url.pathname.startsWith('/family/')) fail('Unexpected destination blocked.', 'DESTINATION_BLOCKED');
      const headers = {'User-Agent':'TheirCareLocalPrototype/0.1', Accept:'text/html,application/json'};
      const cookie = await this.jar.getCookieString(url.href); if(cookie) headers.Cookie=cookie;
      if(body !== undefined) headers['Content-Type']='application/x-www-form-urlencoded';
      let response;
      try { response = await this.fetchImpl(url.href,{method,headers,body,redirect:'manual',signal:AbortSignal.timeout(25000)}); }
      catch { fail('TheirCare could not be reached. If saving, check bookings before retrying.', 'NETWORK_ERROR'); }
      for(const c of response.headers.getSetCookie()) await this.jar.setCookie(c,url.href);
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location'); if (!location) fail('Invalid redirect.');
        url = new URL(location,url);
        if([301,302,303].includes(response.status)) { method='GET'; body=undefined; }
        continue;
      }
      const text = await response.text();
      if(!response.ok) fail('TheirCare returned HTTP ' + response.status + '.', 'UPSTREAM_ERROR');
      if (!allowLogin && (url.pathname.endsWith('/login') || text.includes('id="signInFrm"'))) {
        this.authenticated=false; this.preview=null;
        fail('Sign in again in the local companion.', 'LOGIN_REQUIRED');
      }
      if(text.length > 8e6) fail('TheirCare response is too large.', 'UPSTREAM_ERROR');
      return {text,url:url.href,contentType:response.headers.get('content-type')||''};
    }
    fail('Too many redirects.', 'UPSTREAM_ERROR');
  }
  async login(username,password) {
    this.reset();
    if(!username || !password) fail('Enter your TheirCare email and password.', 'INVALID_INPUT');
    const {text} = await this.request('/family/login',{allowLogin:true});
    const $=cheerio.load(text), form=$('#signInFrm');
    const csrf=form.find('[name="_csrf"]').attr('value');
    if(!csrf) fail('The TheirCare login page has changed.');
    const fields=new URLSearchParams({_csrf:csrf,j_username:username,j_password:password});
    const action=new URL(form.attr('action'),ORIGIN+'/family/login');
    const result=await this.request(action.href,{method:'POST',fields,allowLogin:true});
    if(result.text.includes('id="signInFrm"') || result.url.includes('/login')) {
      this.reset(); fail('Sign-in was not accepted. Check your details or sign in on TheirCare to check for extra steps.', 'LOGIN_FAILED');
    }
    await this.request('/family/dashboard'); this.authenticated=true;
    return {signed_in:true};
  }
  requireLogin() { if(!this.authenticated) fail('Sign in in the local companion first.', 'LOGIN_REQUIRED'); }
  async context() {
    this.requireLogin();
    const dash=cheerio.load((await this.request('/family/dashboard')).text);
    const childMap=new Map();
    const collectChildren=($,page=ORIGIN+'/family/bookings/edit')=>$('a[href]').each((_,el)=>{
      const e=$(el),url=new URL(e.attr('href'),page);
      if(url.origin!==ORIGIN) return;
      const match=/\/family\/child\/(\d+)\/edit$/.exec(url.pathname);
      const queryId=url.pathname==='/family/bookings/edit'?url.searchParams.get('child'):null;
      const id=match?.[1]||queryId;
      if(id && /^\d+$/.test(id)) {
        const name=clean(match?e.closest('tr').find('td').first().text():e.text());
        if(name) childMap.set(id,{id,name});
      }
    });
    collectChildren(dash,ORIGIN+'/family/dashboard');
    const $=cheerio.load((await this.request('/family/bookings/edit')).text), careTypes=new Map(), services=new Map();
    $('a[href]').each((_,el)=>{
      const e=$(el), url=new URL(e.attr('href'),ORIGIN+'/family/bookings/edit');
      if(url.origin!==ORIGIN || url.pathname!=='/family/bookings/edit') return;
      const care=url.searchParams.get('careType'), service=url.searchParams.get('childcareService');
      if(care && !url.searchParams.get('child')) careTypes.set(care,{id:care,name:clean(e.text())});
      if(service && !care && !url.searchParams.get('child')) services.set(service,{id:service,name:clean(e.text())});
    });
    collectChildren($);
    if(!childMap.size) {
      // Dashboard cards load their bodies through declared AJAX URLs.
      // Only fetch the Children widget; avoid contacts, finance and medical cards.
      const cards=dash('.card[data-url]').toArray().filter(el=>/\bchildren\b/i.test(dash(el).find('h3,.card-title').text()));
      for(const el of cards) collectChildren(cheerio.load((await this.request(new URL(dash(el).attr('data-url'),ORIGIN+'/family/dashboard').href)).text));
    }
    if(!services.size) {
      const name=clean($('.dropdown-toggle').first().text()).replace(/[\uF000-\uF8FF]/g,'').trim();
      services.set('',{id:'',name:name||'Default enrolled service'});
    }
    if(!childMap.size || !careTypes.size) fail('Could not identify children or care types. The portal may need account setup.', 'UNSUPPORTED_PAGE');
    return {children:[...childMap.values()],care_types:[...careTypes.values()],services:[...services.values()]};
  }
  async bookings({start,end}) {
    this.requireLogin(); dateRange(start,end);
    const q=new URLSearchParams({start:melbourneMidnight(start),end:melbourneMidnight(end),timeZone:'Australia/Melbourne'});
    const {text}=await this.request('/family/portlet/bookings.json?'+q);
    let data; try { data=JSON.parse(text); } catch { fail('TheirCare booking feed was not JSON.', 'UNSUPPORTED_PAGE'); }
    const events=Array.isArray(data)?data:data.events;
    if(!Array.isArray(events)) fail('Unknown booking feed structure.', 'UNSUPPORTED_PAGE');
    return {start,end,time_zone:'Australia/Melbourne',bookings:events.filter(e=>String(e.start).slice(0,10)>=start&&String(e.start).slice(0,10)<end).map(e=>({
      id:String(e.id),title:clean(e.title),start:calendarTime(e.start),end:e.end?calendarTime(e.end):null
    }))};
  }
  async calendar({child_id,care_type_id,service_id='',year}) {
    this.requireLogin();
    if(!/^\d+$/.test(child_id||'')||!/^\d+$/.test(care_type_id||'')||(service_id&&!/^\d+$/.test(service_id))) fail('Choose a child, care type and service from account_context.', 'INVALID_INPUT');
    if(!Number.isInteger(year)||year<2020||year>2100) fail('Choose a valid year.', 'INVALID_INPUT');
    const q=new URLSearchParams({child:child_id,careType:care_type_id,year:String(year)});
    if(service_id) q.set('childcareService',service_id);
    const {text}=await this.request('/family/bookings/edit?'+q);
    const calendar=parseCalendar(text);
    const fields=formFields(calendar.$,calendar.form);
    if(fields.get('child')!==child_id||fields.get('careType')!==care_type_id||fields.get('year')!==String(year))
      fail('TheirCare returned a different child, care type or year.', 'CONTEXT_MISMATCH');
    if(service_id && fields.get('childcareService')!==service_id) fail('TheirCare returned a different service.', 'CONTEXT_MISMATCH');
    return calendar;
  }
  async availability(args) {
    dateRange(args.start,args.end);
    if(args.start.slice(0,4)!==String(args.year)||args.end>String(args.year+1)+'-01-01') fail('Range must fall within the selected year.', 'INVALID_INPUT');
    const cal=await this.calendar(args);
    return {child_id:args.child_id,care_type_id:args.care_type_id,year:args.year,time_zone:'Australia/Melbourne',
      conditions:cal.conditions,days:cal.days.filter(d=>d.date>=args.start&&d.date<args.end)};
  }
  async previewChanges(args) {
    this.preview=null;
    const cal=await this.calendar(args), plan=makePlan(cal,args.changes);
    if(plan.some(p=>!p.date.startsWith(String(args.year)+'-'))) fail('All changes must be in the selected year.', 'INVALID_INPUT');
    const fields=formFields(cal.$,cal.form);
    // Preserve every untouched field exactly as rendered. Blank historical
    // statuses can be interpreted as cancellations by the server.
    for(const p of plan) {
      const name='bookings['+dmy(p.date)+'].bookingStatus';
      if(!fields.has(name)) fail('Booking field missing for requested date.', 'UNSUPPORTED_PAGE');
      fields.set(name,p.status);
    }
    fields.set('action','submitCal');
    const {text}=await this.request('/family/bookings/edit',{method:'POST',fields});
    const review=parseReview(text,plan);
    if (review.fields.get('child')!==args.child_id || review.fields.get('careType')!==args.care_type_id || review.fields.get('year')!==String(args.year) || review.fields.get('childcareService')!==fields.get('childcareService'))
      fail('TheirCare review changed the selected child, service or care type. Nothing was saved.', 'CONTEXT_MISMATCH');
    const context=await this.context();
    const publicPart={id:randomUUID(),expires_at:new Date(Date.now()+5*60000).toISOString(),
      child:context.children.find(c=>c.id===args.child_id)?.name||args.child_id,
      care_type:context.care_types.find(c=>c.id===args.care_type_id)?.name||args.care_type_id,
      service:cal.dropdowns[0]||cal.$('#childcareService').attr('value'),
      changes:plan.map(({date,action})=>({date,action})),session_conditions:cal.conditions,
      summary:review.summary,cancellation_policy:review.conditions,terms:review.terms,
      note:'Not saved. Review and confirm in the local companion. The AI cannot confirm changes.'};
    this.preview={publicPart,review,args:structuredClone(args),plan,generation:this.generation};
    return publicPart;
  }
  getPreview(id) {
    const p=this.preview;
    if(!p || p.publicPart.id!==id || p.generation!==this.generation) fail('Preview not found. Create a new preview.', 'PREVIEW_EXPIRED');
    if(Date.parse(p.publicPart.expires_at)<Date.now()) { this.preview=null; fail('Preview expired. Create a fresh preview.', 'PREVIEW_EXPIRED'); }
    return p;
  }
  async confirm(id) {
    // Called by the human review UI, or by MCP clients when THEIRCARE_ALLOW_AI_SAVE is on.
    const p=this.getPreview(id); this.preview=null;
    // Reload availability and regenerate the server review immediately before saving.
    // Any new fee/term/state change requires the user to review a new preview.
    let fresh;
    try {
      await this.previewChanges(p.args);
      fresh=this.preview;
      if (fresh.review.fingerprint!==p.review.fingerprint || fresh.publicPart.session_conditions!==p.publicPart.session_conditions)
        fail('TheirCare conditions changed. Review a fresh preview before saving.', 'PREVIEW_CHANGED');
    } finally { this.preview=null; }
    const fields=new URLSearchParams(fresh.review.fields); fields.set('action','submitConfirm');
    let result;
    try { result=await this.request('/family/bookings/edit',{method:'POST',fields}); }
    catch(e) { e.message='Save result is uncertain. Refresh saved bookings before trying again. '+e.message; throw e; }
    const $=cheerio.load(result.text);
    if($('button[value="submitConfirm"]').length || $('.alert-danger').length)
      fail('TheirCare did not confirm the save. Refresh bookings before retrying.', 'SAVE_UNVERIFIED');
    const cal=await this.calendar(p.args);
    const checks=p.plan.map(c=>{
      const day=cal.days.find(d=>d.date===c.date);
      const verified=day && (c.action==='book'?day.booked : c.action==='waitlist'?day.on_waitlist : !day.booked&&!day.on_waitlist);
      return {date:c.date,action:c.action,verified:Boolean(verified)};
    });
    if(checks.some(c=>!c.verified)) fail('The saved calendar does not match all requested changes. Check TheirCare before retrying.', 'SAVE_UNVERIFIED');
    return {saved:true,verified:true,changes:checks};
  }
}
