import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const STATE=path.join(ROOT,'.runtime','connection.json');
export async function readConnection() {
  const info=JSON.parse(await readFile(STATE,'utf8'));
  if(info.origin!=='http://127.0.0.1:43817' || !/^[a-f0-9]{64}$/.test(info.token)) throw Error('Invalid local connection file.');
  return info;
}
export async function writeConnection(info) {
  await mkdir(path.dirname(STATE),{recursive:true,mode:0o700});
  await writeFile(STATE,JSON.stringify(info),{mode:0o600});
}
export async function ensureServer() {
  async function ready() {
    try {
      const info=await readConnection();
      const res=await fetch(info.origin+'/api/status',{headers:{Authorization:'Bearer '+info.token},signal:AbortSignal.timeout(800)});
      if(res.ok) return info;
    } catch {}
    return null;
  }
  let info=await ready(); if(info) return info;
  const child=spawn(process.execPath,[path.join(ROOT,'src/companion.js')],{cwd:ROOT,detached:true,stdio:'ignore',env:{...process.env}});
  child.unref();
  for(let attempt=0;attempt<60;attempt++) {
    await new Promise(resolve=>setTimeout(resolve,100));
    info=await ready(); if(info) return info;
  }
  throw Error('Local companion could not start. Run npm start in the prototype folder to see the startup error.');
}
