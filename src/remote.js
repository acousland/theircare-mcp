import express from 'express';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createOps, errorBody, readCookie } from './companion.js';
import { createOAuthProvider } from './oauth.js';
import { registerTools } from './tools.js';
import { TheirCare, PortalError } from './portal.js';
import { ROOT } from './runtime.js';

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const page=(title,body)=>'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(title)+'</title><link rel="stylesheet" href="/style.css"></head><body><header><span class="brand"><span class="mark">tc</span><span>TheirCare <b>connector</b></span></span></header><main><section id="welcome"><div class="intro"><span class="eyebrow">Home server</span><h1>'+esc(title)+'</h1></div><div class="login panel">'+body+'</div></section></main></body></html>';
const FAILURE_WINDOW=15*60000, MAX_FAILURES=5;

// Remote mode: an OAuth authorization server and a Streamable HTTP MCP endpoint on one origin, with no companion UI.
// Connecting an AI app asks for the owner's TheirCare sign-in; it is sealed with a key held only in that app's tokens,
// so the server can sign back in whenever TheirCare ends the session (idle timeout, or a sign-in elsewhere).
// publicUrl is the HTTPS origin the proxy (e.g. Tailscale Funnel) serves at its root. Only ownerEmail can connect.
export async function createRemote({publicUrl,ownerEmail,dataDir,portal=new TheirCare(),now=Date.now,allowedRedirects}) {
  const origin=new URL(publicUrl);
  if(origin.origin!==publicUrl.replace(/\/$/,'')) throw Error('THEIRCARE_PUBLIC_URL must be an origin with no path, e.g. https://homeserver.example.ts.net');
  if(!/^[^@\s]+@[^@\s]+$/.test(ownerEmail||'')) throw Error('THEIRCARE_OWNER_EMAIL must be your TheirCare sign-in email.');
  const resource=new URL('/mcp',origin), host=origin.host, secure=origin.protocol==='https:';
  const metadataUrl=getOAuthProtectedResourceMetadataUrl(resource);
  const oauth=await createOAuthProvider({dataDir,resource,now,allowedRedirects});
  // Without a review page, saving through the AI app (after agreement in chat) is the only way to save.
  const {ops}=createOps({portal,allowAiSave:true,status:()=>({remote:true})});
  const app=express(), form=express.urlencoded({extended:false,limit:'8kb'});
  let failures=[];

  app.disable('x-powered-by');
  app.set('trust proxy',1);
  app.get('/healthz',(req,res)=>res.json({ok:true}));
  // Access log without query strings, which can carry OAuth codes.
  app.use((req,res,next)=>{
    res.on('finish',()=>console.error([new Date().toISOString(),req.method,req.originalUrl.split('?')[0],res.statusCode,req.headers.host,JSON.stringify(req.headers['user-agent']||'')].join(' ')));
    next();
  });
  app.use((req,res,next)=>{
    // Proxies may forward the public name in X-Forwarded-Host. This is DNS-rebinding defence, not authentication.
    if(req.headers.host!==host && req.headers['x-forwarded-host']!==host) return res.status(403).json({error:'Invalid host.'});
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
    if(secure) res.set('Strict-Transport-Security','max-age=31536000');
    next();
  });
  app.get('/style.css',(req,res)=>res.sendFile(path.join(ROOT,'public/style.css')));
  app.get('/',(req,res)=>res.type('html').send(page('TheirCare connector',
    '<p class="muted">Add <b>'+esc(resource.href)+'</b> as a connector in your AI app. It asks you to sign in to TheirCare once.</p>')));
  app.use(mcpAuthRouter({provider:oauth.provider,issuerUrl:origin,resourceServerUrl:resource,resourceName:'TheirCare',scopesSupported:['theircare']}));

  const expired=res=>res.status(400).type('html').send(page('Request expired','<p class="muted">Start connecting again from your AI app.</p>'));
  function consentPage(res,request,p,error) {
    const target=new URL(p.redirectUri), action=['http:','https:'].includes(target.protocol)?target.origin:target.protocol;
    // Browsers apply form-action to the redirect that follows the POST.
    res.set('Content-Security-Policy',"default-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' "+action);
    // Binds the POST to the browser that opened this page.
    res.cookie('tc_consent',request,{httpOnly:true,secure,sameSite:'lax',path:'/oauth/consent',maxAge:10*60000});
    res.status(error?400:200).type('html').send(page('Connect TheirCare',
      '<span class="eyebrow">Connection request</span><h2>'+esc(p.client?.client_name||'An AI app')+'</h2>'+
      '<p class="muted">wants to read your TheirCare bookings and <b>book or cancel sessions</b>, accepting TheirCare\'s terms for you after you agree in chat.</p>'+
      '<p class="fine">Your TheirCare sign-in is kept encrypted and only this app\'s access can unlock it, so you will not be asked again. Disconnecting the app removes it. Returns to <b>'+esc(target.protocol+'//'+target.host)+'</b>; only continue if you just started connecting from that app.</p>'+
      (error?'<p class="error">'+esc(error)+'</p>':'')+
      '<form id="login" method="post" action="/oauth/consent"><input type="hidden" name="request" value="'+esc(request)+'">'+
      '<label>TheirCare email<input name="email" type="email" autocomplete="username" required></label>'+
      '<label>Password<input name="password" type="password" autocomplete="current-password" required></label>'+
      '<button class="primary" name="decision" value="approve">Sign in and connect <span>→</span></button><button class="secondary" name="decision" value="deny" formnovalidate>Deny</button></form>'));
  }
  app.get('/oauth/consent',(req,res)=>{
    const request=String(req.query.request||''), p=oauth.consent.get(request);
    if(!p) return expired(res);
    consentPage(res,request,p);
  });
  app.post('/oauth/consent',form,async(req,res,next)=>{
    const request=String(req.body.request||''), email=String(req.body.email||'').trim(), password=String(req.body.password||'');
    req.body.password='';
    try {
      if(readCookie(req,'tc_consent')!==request) return res.status(403).type('html').send(page('Not allowed','<p class="muted">Start connecting again from your AI app, in this browser.</p>'));
      const p=oauth.consent.get(request);
      if(!p) return expired(res);
      if(req.body.decision!=='approve') return res.redirect(303,oauth.consent.decide(request,false));
      // Bound failed attempts so this page cannot be used to guess the owner's TheirCare password.
      failures=failures.filter(t=>t>now()-FAILURE_WINDOW);
      if(failures.length>=MAX_FAILURES) return consentPage(res,request,p,'Too many failed attempts. Wait 15 minutes and try again.');
      if(email.toLowerCase()!==ownerEmail.toLowerCase()) {failures.push(now());return consentPage(res,request,p,'This TheirCare account is not allowed on this server.');}
      try {await portal.serial(()=>portal.login(email,password));}
      catch(e) {
        if(e.code==='LOGIN_FAILED') failures.push(now());
        return consentPage(res,request,p,errorBody(e).error);
      }
      res.clearCookie('tc_consent',{httpOnly:true,secure,sameSite:'lax',path:'/oauth/consent'});
      res.redirect(303,oauth.consent.decide(request,true,{email,password}));
    } catch(e) {next(e);}
  });

  // Signs in with the connection's sealed credentials whenever TheirCare has no live session. A rejected password
  // drops the vault, so the AI app is asked to reconnect instead of retrying and risking an account lock.
  async function signIn(creds) {
    try {await portal.login(creds.email,creds.password);console.error('TheirCare signed in again');}
    catch(e) {
      if(e.code!=='LOGIN_FAILED') throw e;
      await oauth.forget(creds.vault);
      throw new PortalError('TheirCare no longer accepts the saved sign-in. Reconnect the TheirCare connector in your AI app.','RECONNECT_REQUIRED');
    }
  }
  const run=(creds,op,args)=>portal.serial(async()=>{
    if(!portal.authenticated) await signIn(creds);
    try {return await ops[op](args);}
    catch(e) {
      // Saving is never retried: the preview is gone, and the AI app must review a fresh one.
      if(e.code!=='LOGIN_REQUIRED'||op==='confirm') throw e;
      await signIn(creds);
      return ops[op](args);
    }
  });
  portal.onSessionLost=d=>console.error('TheirCare session ended: '+JSON.stringify(d));

  const bearer=requireBearerAuth({verifier:oauth.provider,resourceMetadataUrl:metadataUrl,expectedResource:resource});
  app.post('/mcp',bearer,express.json({limit:'32kb'}),async(req,res)=>{
    const creds=oauth.credentials(req.auth.token);
    if(!creds) return res.status(401).set('WWW-Authenticate','Bearer error="invalid_token", resource_metadata="'+metadataUrl+'"').json({error:'invalid_token'});
    // Stateless: one server and transport per request.
    const server=new McpServer({name:'theircare',version:'1.0.1'});
    registerTools(server,async(op,args)=>{
      try {const data=await run(creds,op,args);console.error('tool '+op+' ok');return {data,ok:true};}
      catch(e) {const data=errorBody(e);console.error('tool '+op+' failed: '+data.code);return {data,ok:false};}
    },{allowSave:true});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{transport.close();server.close();});
    try {await server.connect(transport);await transport.handleRequest(req,res,req.body);}
    catch(e) {if(!res.headersSent) res.status(500).json({jsonrpc:'2.0',error:{code:-32603,message:'Internal error'},id:null});}
  });
  app.all('/mcp',bearer,(req,res)=>res.status(405).set('Allow','POST').json({jsonrpc:'2.0',error:{code:-32000,message:'Method not allowed.'},id:null}));
  app.use((err,req,res,next)=>res.status(500).json(errorBody(err)));
  return {app,portal,oauth};
}

if(process.argv[1]===path.join(ROOT,'src/remote.js')) {
  const env=process.env, need=name=>env[name]||(console.error('Missing '+name+'. See .env.example.'),process.exit(1));
  try {
    const allowedRedirects=env.THEIRCARE_ALLOWED_REDIRECTS?.split(',').map(s=>s.trim()).filter(Boolean);
    const {app}=await createRemote({publicUrl:need('THEIRCARE_PUBLIC_URL'),ownerEmail:need('THEIRCARE_OWNER_EMAIL'),dataDir:env.THEIRCARE_DATA_DIR||path.join(ROOT,'.runtime'),allowedRedirects});
    const host=env.THEIRCARE_HOST||'127.0.0.1', port=Number(env.THEIRCARE_PORT||43817);
    const server=app.listen(port,host,()=>console.error('TheirCare remote connector listening on '+host+':'+port+' for '+env.THEIRCARE_PUBLIC_URL));
    server.on('error',err=>{console.error('Remote startup failed: '+err.code);process.exitCode=1;});
    for(const sig of ['SIGTERM','SIGINT']) process.on(sig,()=>server.close(()=>process.exit(0)));
  } catch(e) {console.error(e.message);process.exitCode=1;}
}
