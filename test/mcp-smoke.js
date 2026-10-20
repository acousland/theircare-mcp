import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/mcp.js',import.meta.url))],stderr:'pipe'});
const client=new Client({name:'theircare-smoke-test',version:'0.1.0'});
try {
  await client.connect(transport);
  const {tools}=await client.listTools();
  assert.equal(tools.length,6);
  assert.ok(!tools.some(t=>/confirm|save/.test(t.name)));
  const call=async(name,args={})=>{
    const result=await client.callTool({name,arguments:args});
    if(result.isError) throw Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const status=await call('theircare_status');
  console.log('MCP handshake OK; tools:',tools.map(t=>t.name).join(', '));
  console.log('Connection state:',JSON.stringify(status));
  if(status.demo) {
    const context=await call('theircare_account_context');
    assert.equal(context.children[0].name,'Maya Sample');
    const bookings=await call('theircare_list_bookings',{start:'2026-10-20',end:'2026-11-01'});
    assert.equal(bookings.bookings.length,6);
    const availability=await call('theircare_availability',{child_id:'1',care_type_id:'10',year:2026,start:'2026-10-20',end:'2026-11-01'});
    assert.ok(availability.days.some(d=>d.available));
    const preview=await call('theircare_preview_changes',{child_id:'1',care_type_id:'10',year:2026,changes:[{date:'2026-10-28',action:'book'}]});
    assert.equal(preview.changes[0].date,'2026-10-28');
    console.log('Sample MCP calls passed: context, bookings, availability and unsaved preview.');
  }
} finally {await client.close();}
