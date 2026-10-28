/** Synthetic inputs are explicitly labeled; no old extension source or private records are read. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Recorder } from '../src/recorder';

async function create(language: 'cpp' | 'python', destination: string) {
  const folder = path.join(destination,`mock-${language}-source`);
  const storage = path.join(destination,`mock-${language}-journals`);
  await mkdir(folder,{recursive:true});
  const file = path.join(folder,language === 'cpp' ? 'sum.cpp' : 'sum.py');
  const broken = language === 'cpp' ? '#include <iostream>\nint main(){ int a,b; std::cin>>a>>b; std::cout << a+b }\n' : 'a, b = map(int, input().split())\nprint(a + b\n';
  const fixed = language === 'cpp' ? '#include <iostream>\nint main(){ int a,b; std::cin>>a>>b; std::cout << a+b << "\\n"; }\n' : 'a, b = map(int, input().split())\nprint(a + b)\n';
  await writeFile(file,broken); await writeFile(path.join(folder,'input.txt'),'2 3\n');
  const recorder = await Recorder.start(storage,folder,[]);
  await recorder.memo(file,'[MOCK] 두 정수를 입력받아 합을 출력하는 합성 테스트. 아래 종료 코드·출력도 테스트 fixture이며 실제 저지 결과가 아님.',1,true);
  const bad = await recorder.beginRun(language === 'cpp' ? 'g++ sum.cpp -o sum' : 'python3 sum.py < input.txt',folder);
  await recorder.endRun(bad!,1,language === 'cpp' ? 'sum.cpp:2:59: error: expected ; before } token' : "SyntaxError: '(' was never closed");
  await recorder.edit(file,broken,fixed,2,false); await writeFile(file,fixed); await recorder.snapshot(file,2);
  const good = await recorder.beginRun(language === 'cpp' ? 'g++ sum.cpp -o sum && ./sum < input.txt' : 'python3 sum.py < input.txt',folder);
  await recorder.endRun(good!,0,'5\n');
  await recorder.memo(file,'[MOCK] 괄호/세미콜론을 고친 뒤 예시 입력의 출력 5를 확인. 정답 판정은 없음.',2);
  await recorder.stop();
  const output = path.join(destination,`mock-${language}.json`);
  const events = recorder.journal.all();
  await writeFile(output,JSON.stringify({schemaVersion:1,source:'mock',simulated:true,officialEvaluation:false,session:recorder.journal.manifest,events},null,2));
  return {language,path:output,events:events.length,runs:events.filter(e => e.type === 'run').length};
}

async function main() {
  const destination = path.resolve(process.argv[2] ?? '.data/imported');
  await mkdir(destination,{recursive:true});
  const results = [];
  for (const language of ['cpp','python'] as const) results.push(await create(language,destination));
  await writeFile(path.join(destination,'provenance.json'),JSON.stringify({
    createdAt:new Date().toISOString(),source:'mock',reason:'Bounded ps-blogself storage lookup found extension preferences only, no code-writing record payloads.',
    searched:['WSL VS Code globalStorage and workspaceStorage','Windows VS Code globalStorage and workspaceStorage','recorded root .vscode directory names'],
    excluded:['prior implementation source','prompts','generated articles','conversations'],officialEvaluation:false,results
  },null,2));
  process.stdout.write(JSON.stringify(results.map(result => ({language:result.language,events:result.events,runs:result.runs,path:result.path})),null,2) + '\n');
}
void main().catch(error => { process.stderr.write((error as Error).message + '\n'); process.exitCode = 1; });
