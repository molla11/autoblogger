import { spawn } from 'node:child_process';
const children=[];let closing=false;
function stop(signal='SIGTERM'){if(closing)return;closing=true;for(const child of children)child.kill(signal);}
for(const name of ['api','web']){
 const child=spawn('pnpm',['--filter',`@autoblogger/${name}`,'dev'],{stdio:'inherit',env:process.env});children.push(child);
 child.on('error',error=>{console.error(error.message);stop();process.exitCode=1;});
 child.on('exit',(code)=>{if(!closing){process.exitCode=code??1;stop();}});
}
process.on('SIGINT',()=>stop('SIGINT'));process.on('SIGTERM',()=>stop());
