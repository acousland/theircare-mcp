import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { TheirCare, PortalError } from './portal.js';
import { ROOT, writeConnection, readConnection } from './runtime.js';
import { demoFetch } from './demo.js';

export function createCompanion({portal=new TheirCare(),token=randomBytes(32).toString('hex'),origin='http://127.0.0.1:43817'}={}) {
  const app=express(), uiToken=randomBytes(32).toString('hex');
  let demo=false;
  const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    if(req.headers.host!==new URL(origin).host) return res.status(403).json({error:'Invalid host.'});
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
    next();
  });
  app.use(express.json({limit:'32kb'}));
  app.use('/api',(req,res,next)=>{
    const bearer=equal(req.headers.authorization,'Bearer '+token);
    const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('tc_ui='))?.slice(6);
    const ui=equal(cookie,uiToken)&&req.headers['x-theircare-ui']==='1';
    if(req.headers.origin && req.headers.origin!==origin) return res.status(403).json({error:'Cross-site request blocked.'});
    if(!bearer&&!ui) return res.status(401).json({error:'Local authorization required.'});
    req.isHumanUI=ui;
    next();
  });
  const route=(fn)=>async(req,res,next)=>{
    try {res.json(await portal.serial(()=>fn(req)));} catch(e){next(e);}
  };
  app.get('/api/status',route(()=>({signed_in:portal.authenticated,demo,companion_url:origin})));
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
  app.get('/api/context',route(()=>portal.context()));
  app.post('/api/bookings',route(req=>portal.bookings(req.body)));
  app.post('/api/availability',route(req=>portal.availability(req.body)));
  app.post('/api/preview',route(async req=>({...await portal.previewChanges(req.body),review_url:origin+'/#review'})));
  app.get('/api/preview',route(()=>portal.preview?portal.getPreview(portal.preview.publicPart.id).publicPart:null));
  app.post('/api/discard',route(()=>{portal.preview=null;return {discarded:true};}));
  app.post('/api/confirm',route(async req=>{
    if(!req.isHumanUI || req.body.accept_terms!==true) throw new PortalError('Review and accept the terms yourself in the companion.','HUMAN_CONFIRMATION_REQUIRED');
    if(demo) throw new PortalError('Sample mode cannot save real bookings.','DEMO_ONLY');
    return portal.confirm(req.body.id);
  }));
  app.get('/',(req,res)=>{
    res.cookie('tc_ui',uiToken,{httpOnly:true,sameSite:'strict',path:'/'});
    res.sendFile(path.join(ROOT,'public/index.html'));
  });
  app.use(express.static(path.join(ROOT,'public'),{index:false}));
  app.use((err,req,res,next)=>{
    const known=err instanceof PortalError;
    res.status(known?400:500).json({error:known?err.message:'The local companion encountered an error.',code:known?err.code:'INTERNAL_ERROR'});
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
