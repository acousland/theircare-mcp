import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../src/runtime.js';
let failed=false;
for(const dir of ['src','public','scripts','test']) {
  for(const file of await readdir(path.join(ROOT,dir))) {
    if(!file.endsWith('.js'))continue;
    const result=spawnSync(process.execPath,['--check',path.join(ROOT,dir,file)],{stdio:'inherit'});
    if(result.status!==0)failed=true;
  }
}
if(failed)process.exitCode=1;else console.log('JavaScript syntax checks passed.');
