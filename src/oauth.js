import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { InvalidGrantError, InvalidTokenError, InvalidTargetError, InvalidScopeError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
const SCOPE='theircare', MAX_CLIENTS=50;
const digest=s=>createHash('sha256').update(String(s)).digest('base64url');
const secret=()=>randomBytes(32).toString('base64url');
const sameResource=(a,b)=>String(a).replace(/#.*$/,'').replace(/\/$/,'')===String(b).replace(/#.*$/,'').replace(/\/$/,'');
// OAuth 2.1 authorization server for one owner. Registered clients and hashed tokens persist in
// <dataDir>/oauth.json so connectors survive restarts; codes and pending consents stay in memory.
export async function createOAuthProvider({dataDir,resource,now=Date.now,accessSeconds=3600,refreshDays=30}) {
  const file=path.join(dataDir,'oauth.json');
  let state={clients:{},tokens:{}};
  try {state={...state,...JSON.parse(await readFile(file,'utf8'))};} catch(e) {if(e.code!=='ENOENT') throw e;}
  const codes=new Map(), pending=new Map();
  let writing=Promise.resolve();
  function save() {
    for(const [k,t] of Object.entries(state.tokens)) if(t.expires<=now()) delete state.tokens[k];
    const body=JSON.stringify(state);
    writing=writing.then(async()=>{
      await mkdir(dataDir,{recursive:true,mode:0o700});
      await writeFile(file+'.tmp',body,{mode:0o600});await rename(file+'.tmp',file);
    });
    return writing;
  }
  async function issue(clientId,scopes,tokenResource) {
    const access=secret(), refresh=secret();
    state.tokens[digest(access)]={type:'access',clientId,scopes,resource:tokenResource,expires:now()+accessSeconds*1000};
    state.tokens[digest(refresh)]={type:'refresh',clientId,scopes,resource:tokenResource,expires:now()+refreshDays*86400000};
    if(state.clients[clientId]) state.clients[clientId].last_used_at=now();
    await save();
    return {access_token:access,token_type:'bearer',expires_in:accessSeconds,refresh_token:refresh,scope:scopes.join(' ')};
  }
  function take(map,key) {const v=map.get(key);map.delete(key);return v&&v.expires>now()?v:null;}
  const clientsStore={
    getClient:id=>state.clients[id],
    async registerClient(client) {
      // Registration is open (MCP clients self-register), so bound it; consent still needs the owner password.
      const ids=Object.keys(state.clients);
      if(ids.length>=MAX_CLIENTS) {
        const live=new Set(Object.values(state.tokens).map(t=>t.clientId));
        const stale=ids.filter(id=>!live.has(id)).sort((a,b)=>(state.clients[a].last_used_at||0)-(state.clients[b].last_used_at||0))[0];
        delete state.clients[stale??ids[0]];
      }
      const full={...client,client_id:client.client_id??randomUUID(),client_id_issued_at:client.client_id_issued_at??Math.floor(now()/1000)};
      state.clients[full.client_id]=full;await save();
      return full;
    }
  };
  const provider={
    clientsStore,
    // Park the request and send the browser to the consent page, which requires the owner sign-in.
    async authorize(client,params,res) {
      if(params.resource && !sameResource(params.resource,resource)) throw new InvalidTargetError('This server only issues tokens for '+resource.href);
      const scopes=params.scopes?.length?params.scopes:[SCOPE];
      if(scopes.some(s=>s!==SCOPE)) throw new InvalidScopeError('Only the '+SCOPE+' scope is supported.');
      for(const [k,p] of pending) if(p.expires<=now()) pending.delete(k);
      const id=secret();
      pending.set(id,{clientId:client.client_id,...params,scopes,expires:now()+10*60000});
      res.redirect(303,'/oauth/consent?request='+encodeURIComponent(id));
    },
    async challengeForAuthorizationCode(client,code) {
      const c=codes.get(digest(code));
      if(!c||c.clientId!==client.client_id||c.expires<=now()) throw new InvalidGrantError('Invalid or expired authorization code.');
      return c.codeChallenge;
    },
    async exchangeAuthorizationCode(client,code,verifier,redirectUri,requested) {
      const c=take(codes,digest(code));
      if(!c||c.clientId!==client.client_id) throw new InvalidGrantError('Invalid or expired authorization code.');
      if(redirectUri && redirectUri!==c.redirectUri) throw new InvalidGrantError('redirect_uri does not match the authorization request.');
      if(requested && !sameResource(requested,resource)) throw new InvalidTargetError('This server only issues tokens for '+resource.href);
      return issue(client.client_id,c.scopes,resource.href);
    },
    async exchangeRefreshToken(client,refresh,scopes,requested) {
      const key=digest(refresh), t=state.tokens[key];
      if(!t||t.type!=='refresh'||t.clientId!==client.client_id||t.expires<=now()) throw new InvalidGrantError('Invalid or expired refresh token.');
      if(scopes?.some(s=>!t.scopes.includes(s))) throw new InvalidScopeError('Cannot widen scopes on refresh.');
      if(requested && !sameResource(requested,resource)) throw new InvalidTargetError('This server only issues tokens for '+resource.href);
      delete state.tokens[key];
      return issue(client.client_id,scopes?.length?scopes:t.scopes,t.resource);
    },
    async verifyAccessToken(token) {
      const t=state.tokens[digest(token)];
      if(!t||t.type!=='access'||t.expires<=now()) throw new InvalidTokenError('Invalid or expired access token.');
      return {token,clientId:t.clientId,scopes:t.scopes,expiresAt:Math.floor(t.expires/1000),resource:new URL(t.resource)};
    },
    async revokeToken(client,{token}) {
      const key=digest(token);
      if(state.tokens[key]?.clientId===client.client_id) {delete state.tokens[key];await save();}
    }
  };
  // Consent helpers used by the companion's /oauth/consent routes.
  const consent={
    get(id) {const p=pending.get(id);return p&&p.expires>now()?{...p,client:state.clients[p.clientId]}:null;},
    decide(id,approve) {
      const p=take(pending,id);
      if(!p) return null;
      const url=new URL(p.redirectUri);
      if(p.state!==undefined) url.searchParams.set('state',p.state);
      if(!approve) {url.searchParams.set('error','access_denied');return url.href;}
      const code=secret();
      codes.set(digest(code),{clientId:p.clientId,codeChallenge:p.codeChallenge,redirectUri:p.redirectUri,scopes:p.scopes,expires:now()+5*60000});
      url.searchParams.set('code',code);
      return url.href;
    },
    async revokeAll() {state.tokens={};await save();}
  };
  return {provider,consent,flush:()=>writing};
}
