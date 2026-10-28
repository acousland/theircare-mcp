import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureServer, readConnection } from './runtime.js';
import { registerTools } from './tools.js';
import { aiSaveEnabled } from './companion.js';
await ensureServer();
const server=new McpServer({name:'theircare-local',version:'0.1.0'});
registerTools(server,async(op,body)=>{
  const info=await readConnection();
  const response=await fetch(info.origin+'/api/'+op,{method:body?'POST':'GET',
    headers:{Authorization:'Bearer '+info.token,'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(120000)});
  return {data:await response.json(),ok:response.ok};
},{allowSave:aiSaveEnabled()});
await server.connect(new StdioServerTransport());
