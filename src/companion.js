import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { TheirCare, PortalError } from './portal.js';
import { ROOT, writeConnection, readConnection } from './runtime.js';
import { demoFetch } from './demo.js';

export const errorBody=err=>err instanceof PortalError?{error:err.message,code:err.code}:{error:'The companion encountered an error.',code:'INTERNAL_ERROR'};
export const readCookie=(req,name)=>(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1);

// allowAiSave lets MCP clients confirm previews (THEIRCARE_ALLOW_AI_SAVE=true); otherwise only the human UI can save.
export const aiSaveEnabled=()=>process.env.THEIRCARE_ALLOW_AI_SAVE==='true';
// Tool operations shared by the local companion and remote mode. reviewUrl is the human review page, if there is one.
export function createOps({portal,allowAiSave,reviewUrl=null,isDemo=()=>false,status=()=>({})}) {
  // Same checks for the human UI and, when enabled, MCP clients: explicit terms acceptance, never in sample mode.
  // portal.confirm re-runs the review, refuses changed fees/terms, submits once and verifies the saved calendar.
  function confirm(body,human) {
    if(!human&&!allowAiSave) throw new PortalError('Review and accept the terms yourself in the companion.','HUMAN_CONFIRMATION_REQUIRED');
    if(body?.accept_terms!==true) throw new PortalError(human?'Review and accept the terms yourself in the companion.':'Confirm only after the user accepts the terms; pass accept_terms: true.','HUMAN_CONFIRMATION_REQUIRED');
    if(isDemo()) throw new PortalError('Sample mode cannot save real bookings.','DEMO_ONLY');
    return portal.confirm(String(body.id||''));
  }
  const note='Not saved. Show the user these exact changes, fees, cancellation policy and terms. Only after they explicitly agree, call theircare_confirm_changes with this id'+(reviewUrl?', or they can confirm at review_url.':'.');
  const ops={
    status:()=>({signed_in:portal.authenticated,demo:isDemo(),ai_can_save:allowAiSave,...status()}),
    context:()=>portal.context(),
    bookings:args=>portal.bookings(args),
    availability:args=>portal.availability(args),
    preview:async args=>({...await portal.previewChanges(args),...(reviewUrl&&{review_url:reviewUrl}),...(allowAiSave&&{note})}),
    discard:()=>{portal.preview=null;return {discarded:true};},
    confirm:args=>confirm(args,false)
  };
  return {ops,confirm};
}

export function createCompanion({portal=new TheirCare(),token=randomBytes(32).toString('hex'),origin='http://127.0.0.1:43817',allowAiSave=aiSaveEnabled()}={}) {
  const app=express(), uiToken=randomBytes(32).toString('hex'), host=new URL(origin).host;
  let demo=false;
  const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    // DNS-rebinding defence, not authentication.
    if(req.headers.host!==host) return res.status(403).json({error:'Invalid host.'});
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
    next();
  });
  app.use(express.json({limit:'32kb'}));
  const {ops,confirm}=createOps({portal,allowAiSave,reviewUrl:origin+'/#review',isDemo:()=>demo,status:()=>({companion_url:origin})});
  app.use('/api',(req,res,next)=>{
    const bearer=equal(req.headers.authorization,'Bearer '+token);
    // The custom header forces a CORS preflight; the cookie is SameSite=Strict.
    const ui=req.headers['x-theircare-ui']==='1'&&equal(readCookie(req,'tc_ui'),uiToken);
    if(req.headers.origin && req.headers.origin!==origin) return res.status(403).json({error:'Cross-site request blocked.'});
    if(!bearer&&!ui) return res.status(401).json({error:'Local authorization required.'});
    req.isHumanUI=ui;
    next();
  });
  const route=(fn)=>async(req,res,next)=>{
    try {res.json(await portal.serial(()=>fn(req)));} catch(e){next(e);}
  };
  app.get('/api/status',route(()=>ops.status()));
  app.post('/api/login',route(async req=>{
    if(!req.isHumanUI) throw new PortalError('Sign in personally in the companion.','UI_REQUIRED');
    portal.fetchImpl=fetch; demo=false;
    try {return await portal.login(String(req.body.email||''),String(req.body.password||''));}
    finally {if(req.body) {req.body.password='';req.body.email='';}}
  }));
  app.post('/api/demo',route(req=>{
    if(!req.isHumanUI) throw new PortalError('Use the companion to enter sample mode.','UI_REQUIRED');
    const referenceDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Melbourne',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    portal.reset();portal.fetchImpl=demoFetch({referenceDate});portal.authenticated=true;demo=true;
    return {signed_in:true,demo:true};
  }));
  app.post('/api/logout',route(req=>{
    if(!req.isHumanUI) throw new PortalError('Use the companion to disconnect.','UI_REQUIRED');
    portal.reset();portal.fetchImpl=fetch;demo=false;
    return {signed_in:false};
  }));
  app.get('/api/context',route(()=>ops.context()));
  app.post('/api/bookings',route(req=>ops.bookings(req.body)));
  app.post('/api/availability',route(req=>ops.availability(req.body)));
  app.post('/api/preview',route(req=>ops.preview(req.body)));
  app.get('/api/preview',route(()=>portal.preview?portal.getPreview(portal.preview.publicPart.id).publicPart:null));
  app.post('/api/discard',route(()=>ops.discard()));
  app.post('/api/confirm',route(req=>confirm(req.body,req.isHumanUI)));
  app.get('/',(req,res)=>{
    res.cookie('tc_ui',uiToken,{httpOnly:true,sameSite:'strict',path:'/'});
    res.sendFile(path.join(ROOT,'public/index.html'));
  });
  app.use(express.static(path.join(ROOT,'public'),{index:false}));
  app.use((err,req,res,next)=>{
    res.status(err instanceof PortalError?400:500).json(errorBody(err));
  });
  return {app,portal,token};
}
if(process.argv[1]===path.join(ROOT,'src/companion.js')) {
  let previousToken;
  try { previousToken=(await readConnection()).token; } catch {}
  const {app,token}=createCompanion({token:previousToken});
  const server=app.listen(43817,'127.0.0.1',async()=>{
    await writeConnection({origin:'http://127.0.0.1:43817',token,pid:process.pid});
    console.error('TheirCare companion ready at http://127.0.0.1:43817');
  });
  server.on('error',err=>{console.error('Companion startup failed: '+err.code);process.exitCode=1;});
}
