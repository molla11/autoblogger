import { createHash } from 'node:crypto';
import type { RecordEvent } from '../../packages/shared/src';
export function fixture(language:'cpp'|'py'){
 const sessionId=`mock-${language}`,fileId=`file-${language}`,filePath=`solution.${language}`;
 const code=language==='cpp'?['#include <iostream>\nint main(){ int n=100000; std::cout << n*n; }','#include <iostream>\nint main(){ long long n=100000; std::cout << n*n; }']:['values = [1, 2, 3]\nprint(values[len(values)])','values = [1, 2, 3]\nprint(values[len(values)-1])'];
 const event=(n:number,type:RecordEvent['type'],data:Record<string,unknown>):RecordEvent=>({id:`${sessionId}-${n}`,sessionId,fileId,filePath,sequence:n,type,occurredAt:new Date(Date.UTC(2026,9,29,0,n*5)).toISOString(),data});
 const snapshot=(n:number,content:string)=>event(n,'snapshot',{content,hash:createHash('sha256').update(content).digest('hex')});
 const events=[snapshot(1,code[0]),event(2,'run',{command:language==='cpp'?'g++ solution.cpp && ./a.out':'python3 solution.py',cwd:'/mock',kind:language==='cpp'?'compile_run':'python',status:language==='cpp'?'normal_exit':'runtime_error',exitCode:language==='cpp'?0:1,output:language==='cpp'?'1410065408':'IndexError: list index out of range',snapshotId:`${sessionId}-1`,durationMs:17}),event(3,'memo',{text:language==='cpp'?'정수 오버플로를 확인했다. long long으로 바꾼다.':'인덱스는 0부터 시작하므로 마지막 원소 위치를 하나 줄인다.'}),snapshot(4,code[1]),event(5,'run',{command:language==='cpp'?'g++ solution.cpp && ./a.out':'python3 solution.py',cwd:'/mock',kind:language==='cpp'?'compile_run':'python',status:'normal_exit',exitCode:0,output:language==='cpp'?'10000000000':'3',snapshotId:`${sessionId}-4`,durationMs:15})];
 return {provenance:'synthetic-mock' as const,sessionId,language,events,importantEvents:[{id:events[1].id,label:'first observed outcome'},{id:events[2].id,label:'recorded diagnosis'},{id:events[3].id,label:'code correction'},{id:events[4].id,label:'final execution; no judge result'}]};
}
