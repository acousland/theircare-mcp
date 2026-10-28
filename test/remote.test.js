import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { TheirCare } from '../src/portal.js';
import { demoFetch } from '../src/demo.js';
import { createRemote } from '../src/remote.js';

const OWNER='owner@example.com', PASSWORD='correct horse', REDIRECT='https://chatgpt.com/connector/oauth/test-connector';
// Fake TheirCare with real sign-in and one session per account: end() is a sign-in elsewhere or an idle timeout.
function fakeTheirCare() {
  const demo=demoFetch({allowSave:true}), t={password:PASSWORD,live:false,logins:0,attempts:0,commits:0};
  const redirect=location=>new Response(null,{status:302,headers:{location}});
  t.fetch=async(url,o={})=>{
    const u=new URL(url), body=new URLSearchParams(o.body);
    if(u.pathname==='/family/login') return new Response('<form id="signInFrm" action="/family/j_spring_security_check"><input name="_csrf" value="c"></form>');
    if(u.pathname==='/family/j_spring_security_check') {
      t.attempts++;
      if(body.get('j_username')!==OWNER||body.get('j_password')!==t.password) return redirect('/family/login?error');
      t.live=true;t.logins++;return redirect('/family/dashboard');
    }
    if(!t.live) return redirect('/family/login');
    if(body.get('action')==='submitConfirm') t.commits++;
    return demo(url,o);
  };
  t.end=()=>{t.live=false;};
  return t;
}
async function start(dataDir,{tc=fakeTheirCare(),port=0,now=Date.now}={}) {
  const srv=http.createServer();await new Promise(r=>srv.listen(port,'127.0.0.1',r));
  const base='http://localhost:'+srv.address().port;
  const remote=await createRemote({publicUrl:base,ownerEmail:OWNER,dataDir,now,portal:new TheirCare({fetchImpl:tc.fetch})});
  srv.on('request',remote.app);
  return {base,remote,tc,close:async()=>{await remote.oauth.flush();await new Promise(r=>srv.close(r));}};
}
const get=(url,opts={})=>fetch(url,{redirect:'manual',...opts});
const postForm=(url,body,cookie)=>get(url,{method:'POST',body:new URLSearchParams(body),headers:{'Content-Type':'application/x-www-form-urlencoded',...(cookie&&{Cookie:cookie})}});
const cookieOf=res=>res.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
// Starts an authorization request and opens the consent page; submit() posts the TheirCare sign-in form.
async function beginConnect(base) {
  const reg=await (await get(base+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Test client',redirect_uris:[REDIRECT],token_endpoint_auth_method:'none'})})).json();
  const verifier=randomBytes(32).toString('base64url'), challenge=createHash('sha256').update(verifier).digest('base64url');
  const q=new URLSearchParams({response_type:'code',client_id:reg.client_id,redirect_uri:REDIRECT,code_challenge:challenge,code_challenge_method:'S256',state:'xyz',resource:base+'/mcp'});
  const begin=await get(base+'/authorize?'+q);
  assert.equal(begin.status,303);
  const consentUrl=new URL(begin.headers.get('location'),base), request=consentUrl.searchParams.get('request');
  const consent=await get(consentUrl);
  const cookie=cookieOf(consent);
  const submit=(fields={},c=cookie)=>postForm(base+'/oauth/consent',{request,email:OWNER,password:PASSWORD,decision:'approve',...fields},c);
  return {client:reg,verifier,consent,submit};
}
const token=(base,body)=>get(base+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
async function connect(base) {
  const c=await beginConnect(base);
  const done=await c.submit();
  assert.equal(done.status,303);
  const redirect=new URL(done.headers.get('location'));
  const tokens=await (await token(base,{grant_type:'authorization_code',client_id:c.client.client_id,code:redirect.searchParams.get('code'),code_verifier:c.verifier,redirect_uri:REDIRECT,resource:base+'/mcp'})).json();
  return {...c,redirect,tokens};
}
const mcp=(base,access,body)=>get(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify(body)});
function tools(base,access) {
  let id=1;
  return async(name,args={})=>{
    const res=await mcp(base,access,{jsonrpc:'2.0',id:id++,method:'tools/call',params:{name,arguments:args}});
    if(res.status!==200) return {status:res.status};
    const r=(await res.json()).result, text=r.content[0].text;
    let data;try{data=JSON.parse(text);}catch{data=text;}
    return {...r,data};
  };
}
const withDir=fn=>async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'tc-remote-'));
  try {await fn(dir);} finally {await rm(dir,{recursive:true,force:true});}
};

test('connecting signs in to TheirCare once and issues tokens that unlock every tool, across restarts',withDir(async dir=>{
  let s=await start(dir);
  try {
    const unauth=await mcp(s.base,'bad',{jsonrpc:'2.0',id:1,method:'tools/list'});
    assert.equal(unauth.status,401);
    assert.match(unauth.headers.get('www-authenticate'),/resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp"/);
    const prm=await (await get(s.base+'/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(prm.resource,s.base+'/mcp');
    const asm=await (await get(s.base+'/.well-known/oauth-authorization-server')).json();
    assert.ok(asm.registration_endpoint&&asm.code_challenge_methods_supported.includes('S256'));

    const c=await connect(s.base);
    assert.equal(c.redirect.origin+c.redirect.pathname,REDIRECT);assert.equal(c.redirect.searchParams.get('state'),'xyz');
    assert.match(await c.consent.text(),/book or cancel sessions/);
    assert.equal(s.tc.logins,1,'the consent page signs in to check the password');
    const {access_token,refresh_token}=c.tokens;
    assert.ok(access_token&&refresh_token);

    const list=await (await mcp(s.base,access_token,{jsonrpc:'2.0',id:1,method:'tools/list'})).json();
    assert.ok(list.result.tools.some(t=>t.name==='theircare_confirm_changes'));
    const call=tools(s.base,access_token);
    assert.deepEqual((await call('theircare_status')).data,{signed_in:true,demo:false,ai_can_save:true,remote:true});
    const preview=await call('theircare_preview_changes',{child_id:'1',care_type_id:'10',year:2026,changes:[{date:'2026-10-28',action:'book'}]});
    assert.equal(preview.data.review_url,undefined,'there is no review page remotely');
    assert.match(preview.data.note,/explicitly agree/);

    const stored=await readFile(path.join(dir,'oauth.json'),'utf8');
    for(const secret of [access_token,refresh_token,access_token.split('.')[1],PASSWORD])
      assert.ok(!stored.includes(secret),'tokens, vault keys and the password are never stored in the clear');

    await s.close();
    s=await start(dir,{port:Number(new URL(s.base).port)});
    assert.equal(s.tc.logins,0);
    const refreshed=await token(s.base,{grant_type:'refresh_token',client_id:c.client.client_id,refresh_token});
    assert.equal(refreshed.status,200);
    const again=await token(s.base,{grant_type:'refresh_token',client_id:c.client.client_id,refresh_token});
    assert.equal(again.status,400,'refresh tokens rotate');
    const fresh=await refreshed.json();
    const bookings=await tools(s.base,fresh.access_token)('theircare_list_bookings',{start:'2026-10-20',end:'2026-11-20'});
    assert.equal(bookings.isError,false,'after a restart the server signs in with the sealed credentials');
    assert.equal(s.tc.logins,1);
  } finally {await s.close();}
}));

test('a TheirCare session ended elsewhere is restored automatically, but saving is never retried',withDir(async dir=>{
  const s=await start(dir);
  try {
    const call=tools(s.base,(await connect(s.base)).tokens.access_token);
    s.tc.end();
    const bookings=await call('theircare_list_bookings',{start:'2026-10-20',end:'2026-11-20'});
    assert.equal(bookings.isError,false);assert.equal(s.tc.logins,2);

    const preview=await call('theircare_preview_changes',{child_id:'1',care_type_id:'10',year:2026,changes:[{date:'2026-10-28',action:'book'}]});
    s.tc.end();
    const lost=await call('theircare_confirm_changes',{preview_id:preview.data.id,accept_terms:true});
    assert.equal(lost.isError,true);assert.equal(s.tc.commits,0);

    const retry=await call('theircare_preview_changes',{child_id:'1',care_type_id:'10',year:2026,changes:[{date:'2026-10-28',action:'book'}]});
    const notAccepted=await call('theircare_confirm_changes',{preview_id:retry.data.id,accept_terms:false});
    assert.equal(notAccepted.isError,true,'accept_terms must be true');
    const saved=await call('theircare_confirm_changes',{preview_id:retry.data.id,accept_terms:true});
    assert.deepEqual(saved.data,{saved:true,verified:true,changes:[{date:'2026-10-28',action:'book',verified:true}]});
    const replay=await call('theircare_confirm_changes',{preview_id:retry.data.id,accept_terms:true});
    assert.equal(replay.data.code,'PREVIEW_EXPIRED');assert.equal(s.tc.commits,1);
  } finally {await s.close();}
}));

test('a changed TheirCare password drops the connection after one attempt',withDir(async dir=>{
  const s=await start(dir);
  try {
    const call=tools(s.base,(await connect(s.base)).tokens.access_token);
    s.tc.password='changed';s.tc.end();
    const attempts=s.tc.attempts;
    const failed=await call('theircare_list_bookings',{start:'2026-10-20',end:'2026-11-20'});
    assert.equal(failed.data.code,'RECONNECT_REQUIRED');
    assert.equal(s.tc.attempts,attempts+1,'one sign-in attempt, so the account is not locked');
    assert.equal((await call('theircare_status')).status,401,'the AI app is asked to reconnect');
    await s.remote.oauth.flush();
    const stored=JSON.parse(await readFile(path.join(dir,'oauth.json'),'utf8'));
    assert.deepEqual(stored.vaults,{});assert.deepEqual(stored.tokens,{});
  } finally {await s.close();}
}));

test('the consent page admits only the owner, binds to the browser and limits failed attempts',withDir(async dir=>{
  const s=await start(dir);
  try {
    assert.match(await (await get(s.base+'/')).text(),/\/mcp/);
    const c=await beginConnect(s.base);
    assert.equal((await c.submit({},'')).status,403,'a POST without the consent cookie is refused');
    const other=await c.submit({email:'someone@example.com'});
    assert.equal(other.status,400);assert.match(await other.text(),/not allowed/);
    assert.equal(s.tc.attempts,0,'other accounts are refused before contacting TheirCare');
    const wrong=await c.submit({password:'wrong'});
    assert.equal(wrong.status,400);assert.equal(s.tc.attempts,1);
    for(let i=0;i<3;i++) await c.submit({password:'wrong'});
    const limited=await c.submit();
    assert.match(await limited.text(),/Too many failed attempts/);assert.equal(s.tc.attempts,4);
    const deny=await (await beginConnect(s.base)).submit({decision:'deny',password:''});
    assert.equal(new URL(deny.headers.get('location')).searchParams.get('error'),'access_denied');
    // fetch cannot override Host, so use node:http for DNS-rebinding checks.
    const withHost=(p,host)=>new Promise((resolve,reject)=>http.get(s.base+p,{headers:{Host:host}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
    assert.equal(await withHost('/','evil.example'),403);
    assert.equal(await withHost('/healthz','127.0.0.1:43817'),200);
  } finally {await s.close();}
}));

test('only allowed AI apps can register, so approval links cannot send the sign-in elsewhere',withDir(async dir=>{
  const s=await start(dir);
  try {
    const register=redirect_uris=>get(s.base+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'ChatGPT',redirect_uris,token_endpoint_auth_method:'none'})});
    for(const uris of [['https://evil.example/callback'],['https://chatgpt.com.evil.example/connector/oauth/x'],['https://chatgpt.com/connector/oauth/../../evil'],[REDIRECT,'https://evil.example/cb'],['https://chatgpt.com/other']]) {
      const res=await register(uris);
      assert.equal(res.status,400,uris.join(' '));assert.equal((await res.json()).error,'invalid_client_metadata');
    }
    assert.equal((await register([REDIRECT])).status,201);
    assert.equal((await register(['https://claude.ai/api/mcp/auth_callback'])).status,201);
  } finally {await s.close();}
}));

test('a reused refresh token ends the connection, except for a quick retry',withDir(async dir=>{
  let clock=Date.now();
  const s=await start(dir,{now:()=>clock});
  try {
    const c=await connect(s.base);
    const refresh=t=>token(s.base,{grant_type:'refresh_token',client_id:c.client.client_id,refresh_token:t});
    const first=await (await refresh(c.tokens.refresh_token)).json();
    assert.ok(first.refresh_token);
    assert.equal((await refresh(c.tokens.refresh_token)).status,400,'a quick retry is refused');
    const second=await (await refresh(first.refresh_token)).json();
    assert.ok(second.access_token,'and the connection carries on');
    clock+=5*60000;
    assert.equal((await refresh(first.refresh_token)).status,400);
    assert.equal((await tools(s.base,second.access_token)('theircare_status')).status,401,'a later reuse revokes every token');
    assert.equal((await refresh(second.refresh_token)).status,400);
    await s.remote.oauth.flush();
    assert.deepEqual(JSON.parse(await readFile(path.join(dir,'oauth.json'),'utf8')).vaults,{});
  } finally {await s.close();}
}));

test('remote mode needs a bare origin and an owner email',async()=>{
  await assert.rejects(createRemote({publicUrl:'https://example.ts.net:8443/theircare',ownerEmail:OWNER,dataDir:tmpdir()}),/no path/);
  await assert.rejects(createRemote({publicUrl:'https://example.ts.net',dataDir:tmpdir()}),/OWNER_EMAIL/);
});
