import { hashPassword } from './owner.js';
// Prints THEIRCARE_OWNER_PASSWORD_HASH for remote mode. Reads a hidden line from the terminal, or stdin when piped.
async function readSecret(prompt) {
  if(!process.stdin.isTTY) {
    let input='';for await(const chunk of process.stdin) input+=chunk;
    return input.split(/\r?\n/)[0];
  }
  process.stderr.write(prompt);process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');
  return new Promise(resolve=>{
    let value='';
    const onData=ch=>{
      if(ch==='\u0003') process.exit(130);
      if(ch==='\r'||ch==='\n') {process.stdin.setRawMode(false);process.stdin.pause();process.stdin.off('data',onData);process.stderr.write('\n');return resolve(value);}
      value=ch==='\u007f'?value.slice(0,-1):value+ch;
    };
    process.stdin.on('data',onData).resume();
  });
}
const password=await readSecret('Owner password (12+ characters): ');
if(password.length<12) {console.error('Use at least 12 characters.');process.exit(1);}
if(process.stdin.isTTY && await readSecret('Repeat: ')!==password) {console.error('Passwords did not match.');process.exit(1);}
console.log('THEIRCARE_OWNER_PASSWORD_HASH='+await hashPassword(password));
