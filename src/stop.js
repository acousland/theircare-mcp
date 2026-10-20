import { readConnection } from './runtime.js';
const info=await readConnection();
try {
  // Check the authenticated companion before touching its recorded PID.
  const response=await fetch(info.origin+'/api/status',{headers:{Authorization:'Bearer '+info.token},signal:AbortSignal.timeout(1000)});
  if(!response.ok) throw Error('Companion identity check failed.');
  process.kill(info.pid,'SIGTERM');
  console.log('Stopped the TheirCare companion. Its in-memory login session is cleared.');
} catch(e) { console.error('Could not stop the companion: '+e.message);process.exitCode=1; }
