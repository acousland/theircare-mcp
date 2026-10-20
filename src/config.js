import path from 'node:path';
import { ROOT } from './runtime.js';
const args=[path.join(ROOT,'src/mcp.js')];
const quote=s=>process.platform==='win32'?'"'+s.replace(/"/g,'\\"')+'"':"'"+s.replace(/'/g,"'\\''")+"'";
console.log('Codex registration command:\n');
console.log('codex mcp add theircare-local -- '+[process.execPath,...args].map(quote).join(' '));
console.log('\nGeneric local MCP configuration:\n');
console.log(JSON.stringify({mcpServers:{'theircare-local':{command:process.execPath,args}}},null,2));
