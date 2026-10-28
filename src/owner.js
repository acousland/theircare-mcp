import { randomBytes, createHash } from 'node:crypto';
export const readCookie=(req,name)=>(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1);
const GOOGLE_AUTH='https://accounts.google.com/o/oauth2/v2/auth', GOOGLE_TOKEN='https://oauth2.googleapis.com/token';
const secret=()=>randomBytes(32).toString('base64url');
// Single-owner "Sign in with Google" for the remote companion and OAuth consent.
// Only ownerEmail is let in. Sessions and in-flight sign-ins live in memory only.
export function createOwner({clientId,clientSecret,ownerEmail,redirectUri,secure=true,sessionHours=12,fetchImpl=fetch,now=Date.now}) {
  if(!clientId||!clientSecret||!/^[^@\s]+@[^@\s]+$/.test(ownerEmail||'')) throw Error('Google sign-in needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and THEIRCARE_OWNER_EMAIL.');
  const sessions=new Map(), logins=new Map(), cookie='tc_owner', loginCookie='tc_login';
  const opts={httpOnly:true,secure,sameSite:'lax',path:'/'};
  function check(req) {
    const id=readCookie(req,cookie), session=id&&sessions.get(id);
    if(!session) return null;
    if(session.expires<=now()) {sessions.delete(id);return null;}
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
    if(!login||login.expires<=now()||readCookie(req,loginCookie)!==state) return {ok:false,error:'This sign-in expired. Try again.'};
    if(req.query.error||!req.query.code) return {ok:false,error:'Google sign-in was cancelled.'};
    const response=await fetchImpl(GOOGLE_TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},signal:AbortSignal.timeout(15000),
      body:new URLSearchParams({code:String(req.query.code),client_id:clientId,client_secret:clientSecret,redirect_uri:redirectUri,grant_type:'authorization_code',code_verifier:login.verifier})});
    const tokens=await response.json().catch(()=>({}));
    if(!response.ok||typeof tokens.id_token!=='string') return {ok:false,error:'Google did not accept the sign-in.'};
    let claims;
    try {claims=JSON.parse(Buffer.from(tokens.id_token.split('.')[1],'base64url').toString('utf8'));} catch {return {ok:false,error:'Google returned an unreadable sign-in.'};}
    const valid=['https://accounts.google.com','accounts.google.com'].includes(claims.iss)&&claims.aud===clientId&&claims.exp*1000>now()&&claims.nonce===login.nonce;
    if(!valid) return {ok:false,error:'Google returned an invalid sign-in.'};
    if(claims.email_verified!==true||String(claims.email).toLowerCase()!==ownerEmail.toLowerCase()) return {ok:false,error:'This Google account is not allowed.'};
    for(const [k,s] of sessions) if(s.expires<=now()) sessions.delete(k);
    const id=secret();
    sessions.set(id,{expires:now()+sessionHours*3600000,csrf:randomBytes(24).toString('base64url')});
    res.cookie(cookie,id,{...opts,maxAge:sessionHours*3600000});
    return {ok:true,next:login.next};
  }
  return {check,start,finish};
}
