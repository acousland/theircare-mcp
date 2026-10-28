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

const OWNER='owner@example.com', REDIRECT='https://client.example/callback';
const google={clientId:'test-client.apps.googleusercontent.com',clientSecret:'test-secret',ownerEmail:OWNER};
// Fake Google token endpoint: returns an ID token carrying whatever claims the test queued.
let nextClaims=null, tokenRequests=[];
const fakeGoogle=async(url,opts)=>{
  tokenRequests.push({url,body:new URLSearchParams(opts.body)});
  if(!nextClaims) return Response.json({error:'invalid_grant'},{status:400});
  const part=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
  return Response.json({id_token:part({alg:'RS256'})+'.'+part(nextClaims)+'.sig'});
};
async function start(dataDir) {
  const srv=http.createServer();await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const base='http://localhost:'+srv.address().port;
  const portal=new TheirCare({fetchImpl:demoFetch()});portal.authenticated=true;
  const remote=await createRemote({publicUrl:base,google,dataDir,portal,fetchImpl:fakeGoogle});
  srv.on('request',remote.app);
  return {base,remote,close:()=>new Promise(r=>srv.close(r))};
}
const get=(url,opts={})=>fetch(url,{redirect:'manual',...opts});
const postForm=(url,body,cookie)=>get(url,{method:'POST',body:new URLSearchParams(body),headers:{'Content-Type':'application/x-www-form-urlencoded',...(cookie&&{Cookie:cookie})}});
const cookieOf=res=>res.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
// Runs the Google sign-in round trip; claims(nonce) builds the ID token Google would return.
async function googleSignIn(base,next='/',claims=nonce=>({iss:'https://accounts.google.com',aud:google.clientId,exp:Date.now()/1000+300,nonce,email:OWNER,email_verified:true})) {
  const begin=await get(base+'/login?next='+encodeURIComponent(next));
  const auth=new URL(begin.headers.get('location'));
  assert.equal(auth.origin,'https://accounts.google.com');
  assert.equal(auth.searchParams.get('redirect_uri'),base+'/login/google/callback');
  nextClaims=claims(auth.searchParams.get('nonce'));
  const res=await get(base+'/login/google/callback?'+new URLSearchParams({code:'google-code',state:auth.searchParams.get('state')}),{headers:{Cookie:cookieOf(begin)}});
  nextClaims=null;
  return {res,cookie:res.headers.getSetCookie().filter(c=>c.startsWith('tc_owner=')).map(c=>c.split(';')[0]).join('; ')};
}
async function signIn(base) {return (await googleSignIn(base)).cookie;}
async function authorize(base,cookie,decision='approve') {
  const reg=await (await get(base+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Test client',redirect_uris:[REDIRECT],token_endpoint_auth_method:'none'})})).json();
  const verifier=randomBytes(32).toString('base64url'), challenge=createHash('sha256').update(verifier).digest('base64url');
  const q=new URLSearchParams({response_type:'code',client_id:reg.client_id,redirect_uri:REDIRECT,code_challenge:challenge,code_challenge_method:'S256',state:'xyz',resource:base+'/mcp'});
  const start=await get(base+'/authorize?'+q);
  assert.equal(start.status,303);
  const consentUrl=new URL(start.headers.get('location'),base);
  const page=await (await get(consentUrl,{headers:{Cookie:cookie}})).text();
  const csrf=page.match(/name="csrf" value="([^"]+)"/)[1];
  const done=await postForm(base+'/oauth/consent',{request:consentUrl.searchParams.get('request'),csrf,decision},cookie);
  return {client:reg,verifier,redirect:new URL(done.headers.get('location')),consentUrl,csrf};
}
const token=(base,body)=>get(base+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
const mcp=(base,access,body)=>get(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify(body)});

test('Google sign-in admits only the verified owner email with a matching nonce',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'tc-remote-'));
  const s=await start(dir);
  try {
    const base={iss:'https://accounts.google.com',aud:google.clientId,exp:Date.now()/1000+300,email:OWNER,email_verified:true};
    tokenRequests=[];
    const ok=await googleSignIn(s.base,'/oauth/consent?request=abc');
    assert.equal(ok.res.status,303);assert.equal(ok.res.headers.get('location'),'/oauth/consent?request=abc');assert.ok(ok.cookie);
    const sent=tokenRequests[0].body;
    assert.equal(sent.get('client_secret'),'test-secret');assert.ok(sent.get('code_verifier'),'PKCE is used with Google');
    for(const [why,claims] of [
      ['other account',n=>({...base,nonce:n,email:'someone@example.com'})],
      ['unverified email',n=>({...base,nonce:n,email_verified:false})],
      ['wrong audience',n=>({...base,nonce:n,aud:'other-client'})],
      ['wrong issuer',n=>({...base,nonce:n,iss:'https://evil.example'})],
      ['expired',n=>({...base,nonce:n,exp:Date.now()/1000-10})],
      ['replayed nonce',()=>({...base,nonce:'other'})]
    ]) {
      const bad=await googleSignIn(s.base,'/',claims);
      assert.equal(bad.res.status,403,why);assert.equal(bad.cookie,'',why);
    }
    const begin=await get(s.base+'/login');
    const state=new URL(begin.headers.get('location')).searchParams.get('state');
    const noCookie=await get(s.base+'/login/google/callback?'+new URLSearchParams({code:'c',state}));
    assert.equal(noCookie.status,403,'a sign-in started in another browser cannot be finished here');
    const offsite=await googleSignIn(s.base,'//evil.example');
    assert.equal(offsite.res.headers.get('location'),'/');
  } finally {await s.remote.oauth.flush();await s.close();await rm(dir,{recursive:true,force:true});}
});

test('remote OAuth flow issues tokens that unlock MCP tools, and survive a restart',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'tc-remote-'));
  let s=await start(dir);
  try {
    const unauth=await mcp(s.base,'bad',{jsonrpc:'2.0',id:1,method:'tools/list'});
    assert.equal(unauth.status,401);
    assert.match(unauth.headers.get('www-authenticate'),/resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp"/);
    const prm=await (await get(s.base+'/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(prm.resource,s.base+'/mcp');
    const asm=await (await get(s.base+'/.well-known/oauth-authorization-server')).json();
    assert.ok(asm.registration_endpoint&&asm.code_challenge_methods_supported.includes('S256'));

    const {client,verifier,redirect}=await authorize(s.base,await signIn(s.base));
    assert.equal(redirect.origin+redirect.pathname,REDIRECT);
    assert.equal(redirect.searchParams.get('state'),'xyz');
    const code=redirect.searchParams.get('code');
    const bad=await token(s.base,{grant_type:'authorization_code',client_id:client.client_id,code,code_verifier:'wrong'.repeat(10),redirect_uri:REDIRECT});
    assert.equal(bad.status,400);
    const issued=await (await token(s.base,{grant_type:'authorization_code',client_id:client.client_id,code,code_verifier:verifier,redirect_uri:REDIRECT,resource:s.base+'/mcp'})).json();
    assert.ok(issued.access_token&&issued.refresh_token);
    const replay=await token(s.base,{grant_type:'authorization_code',client_id:client.client_id,code,code_verifier:verifier,redirect_uri:REDIRECT});
    assert.equal(replay.status,400,'codes are single use');

    const list=await (await mcp(s.base,issued.access_token,{jsonrpc:'2.0',id:1,method:'tools/list'})).json();
    assert.equal(list.result.tools.length,6);
    assert.ok(!list.result.tools.some(t=>/confirm|save/.test(t.name)));
    const status=await (await mcp(s.base,issued.access_token,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'theircare_status',arguments:{}}})).json();
    assert.deepEqual(JSON.parse(status.result.content[0].text),{signed_in:true,demo:false,companion_url:s.base,remote:true});
    const preview=await (await mcp(s.base,issued.access_token,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'theircare_preview_changes',arguments:{child_id:'1',care_type_id:'10',year:2026,changes:[{date:'2026-10-28',action:'book'}]}}})).json();
    assert.equal(JSON.parse(preview.result.content[0].text).review_url,s.base+'/#review');

    const stored=await readFile(path.join(dir,'oauth.json'),'utf8');
    assert.ok(!stored.includes(issued.access_token)&&!stored.includes(issued.refresh_token),'tokens are stored hashed');
    const ownerCookie=await signIn(s.base);
    const sessions=await readFile(path.join(dir,'sessions.json'),'utf8');
    assert.ok(!sessions.includes(ownerCookie.split('=')[1]),'session ids are stored hashed');
    await s.remote.oauth.flush();await s.remote.owner.flush();await s.close();
    s=await start(dir);
    const after=await get(s.base+'/api/status',{headers:{Cookie:ownerCookie,'X-TheirCare-UI':'1'}});
    assert.equal(after.status,200,'owner sign-in survives a restart');
    // A new port means a new origin, so only check that refresh survives via the stored client and token.
    const refreshed=await token(s.base,{grant_type:'refresh_token',client_id:client.client_id,refresh_token:issued.refresh_token});
    assert.equal(refreshed.status,200);
    const again=await token(s.base,{grant_type:'refresh_token',client_id:client.client_id,refresh_token:issued.refresh_token});
    assert.equal(again.status,400,'refresh tokens rotate');
  } finally {await s.remote.oauth.flush();await s.close();await rm(dir,{recursive:true,force:true});}
});

test('remote companion pages and consent require the owner sign-in',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'tc-remote-'));
  const s=await start(dir);
  try {
    const home=await get(s.base+'/');
    assert.equal(home.status,303);assert.equal(home.headers.get('location'),'/login');
    const cookie=await signIn(s.base);
    const ui=await get(s.base+'/');
    const uiCookie=cookieOf(await get(s.base+'/',{headers:{Cookie:cookie}}));
    assert.equal(ui.status,303);
    const signedOut=await get(s.base+'/api/status',{headers:{Cookie:uiCookie,'X-TheirCare-UI':'1'}});
    assert.equal(signedOut.status,401,'UI cookie alone is not enough');
    const signedIn=await get(s.base+'/api/status',{headers:{Cookie:cookie,'X-TheirCare-UI':'1'}});
    assert.equal(signedIn.status,200);
    const noHeader=await get(s.base+'/api/status',{headers:{Cookie:cookie}});
    assert.equal(noHeader.status,401,'the UI header is still required');
    const {consentUrl}=await authorize(s.base,cookie,'deny').then(async r=>{
      assert.equal(r.redirect.searchParams.get('error'),'access_denied');return r;});
    const anon=await get(consentUrl);
    assert.equal(anon.status,303);assert.match(anon.headers.get('location'),/^\/login\?next=/);
    const {consentUrl:pending}=await (async()=>{
      const reg=await (await get(s.base+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({redirect_uris:[REDIRECT],token_endpoint_auth_method:'none'})})).json();
      const st=await get(s.base+'/authorize?'+new URLSearchParams({response_type:'code',client_id:reg.client_id,redirect_uri:REDIRECT,code_challenge:'x'.repeat(43),code_challenge_method:'S256'}));
      return {consentUrl:new URL(st.headers.get('location'),s.base)};
    })();
    const forged=await postForm(s.base+'/oauth/consent',{request:pending.searchParams.get('request'),csrf:'forged',decision:'approve'},cookie);
    assert.equal(forged.status,403);
    // fetch cannot override Host, so use node:http for DNS-rebinding checks.
    const withHost=(p,host)=>new Promise((resolve,reject)=>http.get(s.base+p,{headers:{Host:host}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
    assert.equal(await withHost('/login','evil.example'),403);
    assert.equal(await withHost('/healthz','127.0.0.1:43817'),200);
    const bearerOnly=await get(s.base+'/api/status',{headers:{Authorization:'Bearer '+s.remote.token}});
    assert.equal(bearerOnly.status,401,'the local bridge token is disabled remotely');
  } finally {await s.remote.oauth.flush();await s.close();await rm(dir,{recursive:true,force:true});}
});

test('remote URL must be a bare origin',async()=>{
  await assert.rejects(createRemote({publicUrl:'https://example.ts.net:8443/theircare',google,dataDir:tmpdir()}),/no path/);
});
