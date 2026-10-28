import { z } from 'zod';
// Shared by the stdio bridge and the remote HTTP endpoint. call(op,args) resolves to {data,ok}.
// allowSave adds theircare_confirm_changes, which saves a preview to TheirCare.
export function registerTools(server,call,{allowSave=false}={}) {
  const read={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true};
  const result=async(op,args)=>{
    const {data,ok}=await call(op,args);
    return {content:[{type:'text',text:JSON.stringify(data,null,2)}],isError:!ok};
  };
  const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Melbourne local date, YYYY-MM-DD');
  const context={child_id:z.string(),care_type_id:z.string(),service_id:z.string().optional(),year:z.number().int()};
  server.registerTool('theircare_status',{description:'Check sign-in status and obtain the companion URL. User signs in personally; never ask for passwords in chat.',inputSchema:{},annotations:read},()=>result('status'));
  server.registerTool('theircare_account_context',{description:'List enrolled children, service choices and care types. Use these IDs in availability and previews.',inputSchema:{},annotations:read},()=>result('context'));
  server.registerTool('theircare_list_bookings',{description:'Read saved bookings for a date range of up to 93 days. End date is exclusive. All times are Australia/Melbourne.',inputSchema:{start:date,end:date},annotations:read},args=>result('bookings',args));
  server.registerTool('theircare_availability',{description:'Read available/booked/full/waitlist dates and current session conditions for one child, care type and year. End date exclusive.',inputSchema:{...context,start:date,end:date},annotations:read},args=>result('availability',args));
  server.registerTool('theircare_preview_changes',{
    description:'Prepare an UNSAVED booking/cancellation/waitlist review for 1–31 dates. Returns exact changes, policies and terms. Does not save or accept terms. '+
      (allowSave?'To save, show the user the changes, fees and terms, get their explicit agreement, then call theircare_confirm_changes. If review_url is returned, they can also confirm there. ':'Ask the user to review and confirm personally at review_url. ')+
      'Only one preview is active, expires in 5 minutes. Never claim success from a preview.',
    inputSchema:{...context,changes:z.array(z.object({date,action:z.enum(['book','cancel','waitlist'])})).min(1).max(31)},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}
  },args=>result('preview',args));
  if(allowSave) server.registerTool('theircare_confirm_changes',{
    description:'SAVE the active preview to TheirCare: books, cancels or waitlists real sessions and accepts TheirCare booking terms, which may incur fees. '+
      'Only call after showing the user the preview\'s exact changes, fees, cancellation policy and terms and receiving their explicit agreement in this conversation. Never call on your own initiative or to retry an uncertain result; check bookings instead. '+
      'Re-checks the review first and fails if anything changed; returns verified per-date results.',
    inputSchema:{preview_id:z.string().describe('id from theircare_preview_changes'),accept_terms:z.literal(true).describe('true only when the user has explicitly accepted the terms')},
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}
  },args=>result('confirm',{id:args.preview_id,accept_terms:args.accept_terms}));
  server.registerTool('theircare_discard_preview',{description:'Discard the unsaved preview. Does not change any saved bookings.',inputSchema:{},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},()=>result('discard',{}));
}
