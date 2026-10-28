import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scryptAsync=promisify(scrypt);
export const readCookie=(req,name)=>(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1);
const PARAMS={N:16384,r:8,p:1,maxmem:64*1024*1024};
// Stored as scrypt:<salt>:<hash> (base64url) so it survives .env files without $ escaping.
export async function hashPassword(password) {
  const salt=randomBytes(16), hash=await scryptAsync(String(password).normalize('NFKC'),salt,32,PARAMS);
  return 'scrypt:'+salt.toString('base64url')+':'+hash.toString('base64url');
}
export function parseHash(stored) {
  const [kind,salt,hash,extra]=String(stored||'').split(':');
  if(kind!=='scrypt'||!salt||!hash||extra!==undefined) throw Error('Owner password hash must look like scrypt:<salt>:<hash>. Run npm run owner-password.');
  return {salt:Buffer.from(salt,'base64url'),hash:Buffer.from(hash,'base64url')};
}
export async function verifyPassword(password,stored) {
  const {salt,hash}=parseHash(stored);
  const actual=await scryptAsync(String(password).normalize('NFKC'),salt,hash.length,PARAMS);
  return timingSafeEqual(actual,hash);
}
// Single-owner sign-in for the remote companion and OAuth consent. Sessions live in memory only.
export function createOwner({passwordHash,secure=true,sessionHours=12,maxFailures=10,failureWindowMinutes=15,now=Date.now}) {
  parseHash(passwordHash);
  const sessions=new Map(), failures=[], cookie='tc_owner';
  const sessionId=req=>readCookie(req,cookie);
  function check(req) {
    const id=sessionId(req), session=id&&sessions.get(id);
    if(!session) return null;
    if(session.expires<=now()) {sessions.delete(id);return null;}
    return session;
  }
  // A global (not per-IP) limit: forwarded addresses are spoofable, and there is only one owner.
  async function login(res,password) {
    while(failures.length&&failures[0]<=now()-failureWindowMinutes*60000) failures.shift();
    if(failures.length>=maxFailures) return {ok:false,locked:true};
    if(!password||!await verifyPassword(password,passwordHash)) {failures.push(now());return {ok:false};}
    for(const [id,s] of sessions) if(s.expires<=now()) sessions.delete(id);
    const id=randomBytes(32).toString('base64url');
    sessions.set(id,{expires:now()+sessionHours*3600000,csrf:randomBytes(24).toString('base64url')});
    res.cookie(cookie,id,{httpOnly:true,secure,sameSite:'lax',path:'/',maxAge:sessionHours*3600000});
    return {ok:true};
  }
  function logout(req,res) {
    const id=sessionId(req); if(id) sessions.delete(id);
    res.clearCookie(cookie,{httpOnly:true,secure,sameSite:'lax',path:'/'});
  }
  return {check,login,logout};
}
