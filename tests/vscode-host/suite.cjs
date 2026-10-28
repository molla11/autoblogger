const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const sandbox = process.env.AUTOBLOGGER_TEST_SANDBOX;
const workspace = path.join(sandbox,'workspace');
const storage = path.join(sandbox,'user-data/User/globalStorage/molla11.autoblogger-recorder/sessions');
const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(probe,message,timeout=20000) {
  const start=Date.now();
  while(Date.now()-start<timeout) {try {const value=await probe();if(value)return value;}catch{}await sleep(100);}
  throw new Error('Timed out: '+message);
}
async function journals() {
  let dirs=[];try{dirs=await fs.readdir(storage);}catch{return [];}
  const items=[];
  for(const dir of dirs) {
    const manifest=JSON.parse(await fs.readFile(path.join(storage,dir,'session.json'),'utf8'));
    let events=[];try{events=(await fs.readFile(path.join(storage,dir,'events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{}
    items.push({manifest,events});
  }
  return items.sort((a,b)=>a.manifest.startedAt.localeCompare(b.manifest.startedAt));
}
async function current() {return (await journals()).at(-1);}
function pass(name) {results.push(name);console.log('PASS VSCode '+name);}
async function edit(file,text) {
  const uri=vscode.Uri.file(path.join(workspace,file));const document=await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const change=new vscode.WorkspaceEdit();change.replace(uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),text);
  assert.equal(await vscode.workspace.applyEdit(change),true);await document.save();
}
async function execute(terminal,command) {
  await until(()=>terminal.shellIntegration?.cwd?.fsPath===workspace,'terminal shell integration and cwd',30000);
  const old=(await current()).events.filter(e=>e.type==='run').length;
  terminal.shellIntegration.executeCommand(command);
  return until(async()=>{const j=await current();const runs=j.events.filter(e=>e.type==='run');return runs.length>old?{journal:j,run:runs.at(-1)}:undefined;},'run observed: '+command,30000);
}
exports.run=async()=>{
  const stage=process.env.AUTOBLOGGER_TEST_STAGE;
  const extension=vscode.extensions.getExtension('molla11.autoblogger-recorder');assert.ok(extension,'development extension discovered');await extension.activate();pass('extension activation');
  if(stage==='first') {
    void vscode.commands.executeCommand('autoblogger.start');
    await until(async()=>{const j=await current();return j?.events.filter(e=>e.type==='snapshot').length===2;},'initial snapshots');
    await vscode.commands.executeCommand('notifications.clearAll').catch(()=>undefined);pass('initial C++/Python snapshots');
    const terminal=vscode.window.createTerminal({name:'Autoblogger test harness',cwd:workspace,shellPath:'/bin/bash',env:{HISTFILE:'/dev/null'}});terminal.show();
    const python=await execute(terminal,'python3 solution.py < input.txt');
    assert.equal(python.run.data.status,'success');assert.ok(python.run.data.output.includes('python-one'));assert.equal(python.run.data.inputSnapshot.content,'2 3\n');pass('real Python output and redirected input');
    const compile=await execute(terminal,'g++ solution.cpp -o solution');assert.equal(compile.run.data.status,'success');
    const compiledVersion=compile.run.data.snapshotId;
    await edit('solution.cpp','#include <iostream>\nint main(){std::cout << "cpp-two\\n";}\n');
    await until(async()=>{const j=await current();return j.events.some(e=>e.type==='snapshot'&&e.data.content.includes('cpp-two'));},'saved C++ version');
    const binary=await execute(terminal,'./solution');assert.equal(binary.run.data.snapshotId,compiledVersion);assert.ok(binary.run.data.output.includes('cpp-one'));pass('compiled binary retains original code after edit');
    const combined=await execute(terminal,'g++ solution.cpp -o solution && ./solution');assert.equal(combined.run.data.status,'success');assert.ok(combined.run.data.output.includes('cpp-two'));assert.notEqual(combined.run.data.snapshotId,compiledVersion);pass('combined compile/run captures new disk version');
    await edit('solution.cpp','int main(){ missing_name }\n');
    const failure=await execute(terminal,'g++ solution.cpp -o solution');assert.equal(failure.run.data.status,'compile_error');pass('real compiler diagnostic classification');
    await vscode.commands.executeCommand('autoblogger.stop');
    assert.equal((await current()).manifest.recording,false);pass('explicit stop persisted');
    terminal.dispose();
    await sleep(100);
    void vscode.commands.executeCommand('autoblogger.start');
    await until(async()=>{const js=await journals();return js.length===2&&js[1].manifest.recording&&js[1].events.length>=3;},'second active session');
    await vscode.commands.executeCommand('notifications.clearAll').catch(()=>undefined);
    const before=await current();await fs.writeFile(path.join(sandbox,'restart-check.json'),JSON.stringify({sessionId:before.manifest.id,eventIds:before.events.map(e=>e.id)}));
    pass('active session journal prepared for process restart');
  } else {
    const before=JSON.parse(await fs.readFile(path.join(sandbox,'restart-check.json'),'utf8'));
    const j=await current();assert.equal(j.manifest.id,before.sessionId);assert.equal(j.manifest.recording,true);
    for(const id of before.eventIds)assert.ok(j.events.some(e=>e.id===id));pass('recording restored after actual VSCode process restart');
    await edit('solution.py',"print('python-after-restart')\n");
    const terminal=vscode.window.createTerminal({name:'Autoblogger restarted harness',cwd:workspace,shellPath:'/bin/bash',env:{HISTFILE:'/dev/null'}});terminal.show();
    const execution=await execute(terminal,'python3 solution.py');assert.ok(execution.run.data.output.includes('python-after-restart'));
    const snapshot=execution.journal.events.find(e=>e.id===execution.run.data.snapshotId);assert.ok(snapshot.data.content.includes('python-after-restart'));pass('restarted host captures and links new execution');
    await vscode.commands.executeCommand('autoblogger.stop');terminal.dispose();
    const all=await journals();
    for(const item of all){assert.deepEqual(item.events.map(e=>e.sequence),item.events.map((_,i)=>i+1));assert.equal(new Set(item.events.map(e=>e.id)).size,item.events.length);}
    pass('durable journal sequences remain contiguous and unique');
  }
  await fs.writeFile(path.join(sandbox,`results-${stage}.json`),JSON.stringify({stage,results,vscodeVersion:vscode.version,platform:process.platform,remoteName:vscode.env.remoteName??null},null,2));
};
