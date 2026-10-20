import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ensureServer, readConnection } from './runtime.js';
await ensureServer();
const server=new McpServer({name:'theircare-local',version:'0.1.0'});
const read={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true};
async function api(path,body) {
  const info=await readConnection();
  const response=await fetch(info.origin+'/api/'+path,{method:body?'POST':'GET',
    headers:{Authorization:'Bearer '+info.token,'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(120000)});
  const data=await response.json();
  return {content:[{type:'text',text:JSON.stringify(data,null,2)}],isError:!response.ok};
}
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Melbourne local date, YYYY-MM-DD');
const context={child_id:z.string(),care_type_id:z.string(),service_id:z.string().optional(),year:z.number().int()};
server.registerTool('theircare_status',{description:'Check sign-in status and obtain the local companion URL. User signs in personally; never ask for passwords in chat.',inputSchema:{},annotations:read},()=>api('status'));
server.registerTool('theircare_account_context',{description:'List enrolled children, service choices and care types. Use these IDs in availability and previews.',inputSchema:{},annotations:read},()=>api('context'));
server.registerTool('theircare_list_bookings',{description:'Read saved bookings for a date range of up to 93 days. End date is exclusive. All times are Australia/Melbourne.',inputSchema:{start:date,end:date},annotations:read},args=>api('bookings',args));
server.registerTool('theircare_availability',{description:'Read available/booked/full/waitlist dates and current session conditions for one child, care type and year. End date exclusive.',inputSchema:{...context,start:date,end:date},annotations:read},args=>api('availability',args));
server.registerTool('theircare_preview_changes',{
  description:'Prepare an UNSAVED booking/cancellation/waitlist review for 1–31 dates. Returns exact changes, policies and terms. Does not save or accept terms. Ask the user to review and confirm personally at review_url. Only one preview is active, expires in 5 minutes. Never claim success from a preview.',
  inputSchema:{...context,changes:z.array(z.object({date,action:z.enum(['book','cancel','waitlist'])})).min(1).max(31)},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}
},args=>api('preview',args));
server.registerTool('theircare_discard_preview',{description:'Discard the unsaved local preview. Does not change any saved bookings.',inputSchema:{},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},()=>api('discard',{}));
await server.connect(new StdioServerTransport());
