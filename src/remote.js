import express from 'express';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createCompanion, errorBody } from './companion.js';
import { createOwner } from './owner.js';
import { createOAuthProvider } from './oauth.js';
import { registerTools } from './tools.js';
import { TheirCare } from './portal.js';
import { ROOT } from './runtime.js';

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const page=(title,body)=>'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(title)+'</title><link rel="stylesheet" href="/style.css"></head><body><header><a class="brand" href="/"><span class="mark">tc</span><span>TheirCare <b>companion</b></span></a></header><main><section id="welcome"><div class="intro"><span class="eyebrow">Home server</span><h1>'+esc(title)+'</h1></div><div class="login panel">'+body+'</div></section></main></body></html>';
const safeNext=n=>typeof n==='string'&&n.startsWith('/')&&!n.startsWith('//')&&!n.includes('\\')?n:'/';

// Remote mode: the companion, an OAuth authorization server and a Streamable HTTP MCP endpoint on one origin.
// publicUrl is the HTTPS origin the proxy (e.g. Tailscale Funnel) serves at its root.
export async function createRemote({publicUrl,passwordHash,dataDir,portal=new TheirCare()}) {
  const origin=new URL(publicUrl);
  if(origin.origin!==publicUrl.replace(/\/$/,'')) throw Error('THEIRCARE_PUBLIC_URL must be an origin with no path, e.g. https://homeserver.example.ts.net:8443');
  const resource=new URL('/mcp',origin);
  const owner=createOwner({passwordHash,secure:origin.protocol==='https:'});
  const oauth=await createOAuthProvider({dataDir,resource});
  const form=express.urlencoded({extended:false,limit:'8kb'});
  function routes(app,{run}) {
    app.use(mcpAuthRouter({provider:oauth.provider,issuerUrl:origin,resourceServerUrl:resource,resourceName:'TheirCare',scopesSupported:['theircare']}));
    app.get('/login',(req,res)=>res.type('html').send(page('Sign in',loginForm(req.query.next))));
    app.post('/login',form,async(req,res)=>{
      const result=await owner.login(res,req.body.password);
      if(result.ok) return res.redirect(303,safeNext(req.body.next));
      res.status(result.locked?429:401).type('html').send(page('Sign in',
        '<p class="error">'+(result.locked?'Too many attempts. Try again in 15 minutes.':'That password was not accepted.')+'</p>'+loginForm(req.body.next)));
    });
    app.get('/oauth/consent',(req,res)=>{
      const next='/oauth/consent?request='+encodeURIComponent(String(req.query.request||''));
      const session=owner.check(req);
      if(!session) return res.redirect(303,'/login?next='+encodeURIComponent(next));
      const p=oauth.consent.get(String(req.query.request||''));
      if(!p) return res.status(400).type('html').send(page('Request expired','<p class="muted">Start connecting again from your AI app.</p>'));
      const target=new URL(p.redirectUri), action=['http:','https:'].includes(target.protocol)?target.origin:target.protocol;
      // Browsers apply form-action to the redirect that follows the POST.
      res.set('Content-Security-Policy',"default-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' "+action);
      res.type('html').send(page('Allow access?',
        '<span class="eyebrow">Connection request</span><h2>'+esc(p.client?.client_name||'An AI app')+'</h2>'+
        '<p class="muted">wants to read your TheirCare bookings and prepare unsaved previews. It cannot save bookings or accept terms; you still confirm in this companion.</p>'+
        '<p class="fine">Returns to <b>'+esc(target.protocol+'//'+target.host)+'</b>. Only approve if you just started connecting from that app.</p>'+
        '<form id="login" method="post" action="/oauth/consent"><input type="hidden" name="request" value="'+esc(req.query.request)+'"><input type="hidden" name="csrf" value="'+esc(session.csrf)+'">'+
        '<button class="primary" name="decision" value="approve">Allow access <span>→</span></button><button class="secondary" name="decision" value="deny">Deny</button></form>'));
    });
    app.post('/oauth/consent',form,(req,res)=>{
      const session=owner.check(req);
      if(!session||req.body.csrf!==session.csrf) return res.status(403).type('html').send(page('Not allowed','<p class="muted">Sign in and try again.</p>'));
      const redirect=oauth.consent.decide(String(req.body.request||''),req.body.decision==='approve');
      if(!redirect) return res.status(400).type('html').send(page('Request expired','<p class="muted">Start connecting again from your AI app.</p>'));
      res.redirect(303,redirect);
    });
    const bearer=requireBearerAuth({verifier:oauth.provider,resourceMetadataUrl:getOAuthProtectedResourceMetadataUrl(resource),expectedResource:resource});
    app.post('/mcp',bearer,async(req,res)=>{
      // Stateless: one server and transport per request.
      const server=new McpServer({name:'theircare',version:'0.1.0'});
      registerTools(server,async(op,args)=>{
        try {return {data:await run(op,args),ok:true};} catch(e) {return {data:errorBody(e),ok:false};}
      });
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      res.on('close',()=>{transport.close();server.close();});
      try {await server.connect(transport);await transport.handleRequest(req,res,req.body);}
      catch(e) {if(!res.headersSent) res.status(500).json({jsonrpc:'2.0',error:{code:-32603,message:'Internal error'},id:null});}
    });
    app.all('/mcp',bearer,(req,res)=>res.status(405).set('Allow','POST').json({jsonrpc:'2.0',error:{code:-32000,message:'Method not allowed.'},id:null}));
  }
  const loginForm=next=>'<span class="eyebrow">Owner sign-in</span><h2>Unlock the companion</h2><p class="muted">Use the owner password set on the server. This is not your TheirCare password.</p>'+
    '<form id="login" method="post" action="/login"><input type="hidden" name="next" value="'+esc(safeNext(next))+'"><label>Owner password<input name="password" type="password" autocomplete="current-password" required autofocus></label><button class="primary">Continue <span>→</span></button></form>';
  const companion=createCompanion({portal,origin:origin.origin,remote:{owner,routes}});
  return {...companion,oauth,owner};
}

if(process.argv[1]===path.join(ROOT,'src/remote.js')) {
  const env=process.env, need=name=>env[name]||(console.error('Missing '+name+'. See .env.example.'),process.exit(1));
  try {
    const {app}=await createRemote({publicUrl:need('THEIRCARE_PUBLIC_URL'),passwordHash:need('THEIRCARE_OWNER_PASSWORD_HASH'),dataDir:env.THEIRCARE_DATA_DIR||path.join(ROOT,'.runtime')});
    const host=env.THEIRCARE_HOST||'127.0.0.1', port=Number(env.THEIRCARE_PORT||43817);
    const server=app.listen(port,host,()=>console.error('TheirCare remote companion listening on '+host+':'+port+' for '+env.THEIRCARE_PUBLIC_URL));
    server.on('error',err=>{console.error('Remote startup failed: '+err.code);process.exitCode=1;});
    for(const sig of ['SIGTERM','SIGINT']) process.on(sig,()=>server.close(()=>process.exit(0)));
  } catch(e) {console.error(e.message);process.exitCode=1;}
}
