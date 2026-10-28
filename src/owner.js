import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
export const readCookie=(req,name)=>(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1);
const GOOGLE_AUTH='https://accounts.google.com/o/oauth2/v2/auth', GOOGLE_TOKEN='https://oauth2.googleapis.com/token';
const secret=()=>randomBytes(32).toString('base64url');
const digest=s=>createHash('sha256').update(String(s)).digest('base64url');
// Single-owner "Sign in with Google" for the remote companion and OAuth consent.
// Only ownerEmail is let in. Sessions persist (hashed) in file when given, so restarts do not sign the owner out.
export function createOwner({clientId,clientSecret,ownerEmail,redirectUri,file,secure=true,sessionDays=30,fetchImpl=fetch,now=Date.now}) {
  if(!clientId||!clientSecret||!/^[^@\s]+@[^@\s]+$/.test(ownerEmail||'')) throw Error('Google sign-in needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and THEIRCARE_OWNER_EMAIL.');
  const sessions=new Map(), logins=new Map(), cookie='tc_owner', loginCookie='tc_login';
  if(file) try {for(const [k,v] of Object.entries(JSON.parse(readFileSync(file,'utf8')))) sessions.set(k,v);} catch(e) {if(e.code!=='ENOENT') throw e;}
  let writing=Promise.resolve();
  function save() {
    for(const [k,s] of sessions) if(s.expires<=now()) sessions.delete(k);
    if(!file) return writing;
    const body=JSON.stringify(Object.fromEntries(sessions));
    writing=writing.then(async()=>{
      await mkdir(path.dirname(file),{recursive:true,mode:0o700});
      await writeFile(file+'.tmp',body,{mode:0o600});await rename(file+'.tmp',file);
    });
    return writing;
  }
  const opts={httpOnly:true,secure,sameSite:'lax',path:'/'};
  function check(req) {
    const id=readCookie(req,cookie), key=id&&digest(id), session=key&&sessions.get(key);
    if(!session) return null;
    if(session.expires<=now()) {sessions.delete(key);save();return null;}
    return session;
  }
  // Redirect to Google. The state is also set as a cookie so a sign-in started elsewhere cannot be completed here.
  function start(res,next) {
    for(const [k,l] of logins) if(l.expires<=now()) logins.delete(k);
    const state=secret(), nonce=secret(), verifier=secret();
    logins.set(state,{nonce,verifier,next,expires:now()+10*60000});
    res.cookie(loginCookie,state,{...opts,maxAge:10*60000});
    const url=new URL(GOOGLE_AUTH);
    url.search=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:'openid email',state,nonce,
      code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',login_hint:ownerEmail,prompt:'select_account'});
    res.redirect(303,url.href);
  }
  // Returns {ok,next} or {ok:false,error}. The ID token comes straight from Google's token endpoint over TLS,
  // so its claims can be checked without verifying the signature (OpenID Connect Core 3.1.3.7).
  async function finish(req,res) {
    const state=String(req.query.state||''), login=logins.get(state);
    logins.delete(state);res.clearCookie(loginCookie,opts);
    if(!login||login.expires<=now()) return {ok:false,error:'This sign-in expired. Try again.',reason:'unknown or expired state'};
    if(readCookie(req,loginCookie)!==state) return {ok:false,error:'Finish signing in in the same browser you started in.',reason:'state cookie missing or different'};
    if(req.query.error||!req.query.code) return {ok:false,error:'Google sign-in was cancelled.',reason:'google error '+String(req.query.error||'no code').slice(0,40)};
    const response=await fetchImpl(GOOGLE_TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},signal:AbortSignal.timeout(15000),
      body:new URLSearchParams({code:String(req.query.code),client_id:clientId,client_secret:clientSecret,redirect_uri:redirectUri,grant_type:'authorization_code',code_verifier:login.verifier})});
    const tokens=await response.json().catch(()=>({}));
    if(!response.ok||typeof tokens.id_token!=='string') return {ok:false,error:'Google did not accept the sign-in.',reason:'token endpoint '+response.status+' '+String(tokens.error||'').slice(0,40)};
    let claims;
    try {claims=JSON.parse(Buffer.from(tokens.id_token.split('.')[1],'base64url').toString('utf8'));} catch {return {ok:false,error:'Google returned an unreadable sign-in.',reason:'unreadable id token'};}
    const valid=['https://accounts.google.com','accounts.google.com'].includes(claims.iss)&&claims.aud===clientId&&claims.exp*1000>now()&&claims.nonce===login.nonce;
    if(!valid) return {ok:false,error:'Google returned an invalid sign-in.',reason:'id token claims invalid'};
    if(claims.email_verified!==true||String(claims.email).toLowerCase()!==ownerEmail.toLowerCase()) return {ok:false,error:'This Google account is not allowed.',reason:'account not allowed'};
    const id=secret();
    sessions.set(digest(id),{expires:now()+sessionDays*86400000,csrf:randomBytes(24).toString('base64url')});
    await save();
    res.cookie(cookie,id,{...opts,maxAge:sessionDays*86400000});
    return {ok:true,next:login.next};
  }
  return {check,start,finish,flush:()=>writing};
}
