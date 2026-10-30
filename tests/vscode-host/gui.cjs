const {chromium}=require('@playwright/test');
const assert=require('node:assert/strict');
const path=require('node:path');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function frame(browser,surface) {
  const until=Date.now()+30000;
  while(Date.now()<until){
    for(const context of browser.contexts())for(const page of context.pages())for(const f of page.frames()){
      try{if(await f.locator(`body[data-surface="${surface}"] #app button`).count())return {page,frame:f};}catch{}
    }
    await sleep(150);
  }
  throw new Error('Webview not loaded: '+surface);
}
exports.connect=async(vscode)=>{
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${process.env.AUTOBLOGGER_CDP_PORT}`);
  await vscode.commands.executeCommand('autoblogger.status');
  const recording=await frame(browser,'recording');
  return {browser,...recording};
};
exports.start=async(gui)=>{await gui.frame.getByRole('button',{name:'기록 시작',exact:true}).click();};
exports.review=async(gui,vscode,id,workspace,sandbox,until,current,pass)=>{
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(workspace,'solution.py')));
  await vscode.commands.executeCommand('autoblogger.note');
  const recording=(await frame(gui.browser,'recording')).frame;
  await recording.getByLabel('메모',{exact:true}).fill('GUI에서 남긴 판단: 입력 경계를 확인했다.');
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(workspace,'solution.cpp')));
  await recording.getByLabel('중요한 사건으로 북마크').check();
  await recording.getByRole('button',{name:'메모 저장',exact:true}).click();
  await until(async()=>{const j=await current();return j.events.some(e=>e.type==='memo'&&e.data.text.includes('GUI에서')&&e.data.bookmark&&e.filePath==='solution.py');},'GUI memo pinned to original Python file');
  pass('GUI memo/bookmark keeps original file after editor focus changes');
  await vscode.commands.executeCommand('autoblogger.openSession',id);
  let session=(await frame(gui.browser,'session')).frame;
  await session.getByRole('tab',{name:'파일·실행'}).click();
  await session.locator('#kind-filter').selectOption('run');
  await session.locator('.event').last().click();
  await session.getByRole('heading',{name:'터미널 실행',exact:true}).waitFor();
  assert.match(await session.locator('.detail').innerText(),/컴파일 에러/);
  await gui.page.screenshot({path:path.join(sandbox,'gui-session.png')});
  pass('GUI session tab filters and displays real compiler output');
  await session.getByRole('button',{name:'기록된 코드 열기',exact:true}).click();
  await until(()=>vscode.window.activeTextEditor?.document.uri.scheme==='autoblogger-snapshot','read-only captured code');
  assert.match(vscode.window.activeTextEditor.document.getText(),/missing_name/);
  pass('GUI opens captured source in readonly editor');
  await vscode.commands.executeCommand('autoblogger.openSession',id);
  session=(await frame(gui.browser,'session')).frame;
  await session.getByRole('tab',{name:'메모·북마크'}).click();
  await session.getByLabel('메모',{exact:true}).fill('닫아도 보존할 입력');
  await sleep(400);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  assert.equal((await current()).manifest.recording,true);
  await vscode.commands.executeCommand('autoblogger.openSession',id);
  session=(await frame(gui.browser,'session')).frame;
  await session.getByRole('tab',{name:'메모·북마크'}).waitFor();
  await until(async()=>(await session.getByLabel('메모',{exact:true}).inputValue())==='닫아도 보존할 입력','draft restored on reopening tab');
  pass('GUI tab closing preserves draft and recording');
  await vscode.commands.executeCommand('autoblogger.openSettings');
  const settings=(await frame(gui.browser,'settings')).frame;
  await settings.getByLabel('동기화 주기 (초)',{exact:true}).fill('25');
  await settings.getByRole('button',{name:'설정 저장',exact:true}).click();
  await until(()=>vscode.workspace.getConfiguration('autoblogger').get('syncIntervalSeconds')===25,'GUI settings persisted');
  await settings.getByRole('status').filter({hasText:'설정을 저장했습니다.'}).waitFor();
  pass('GUI settings update VSCode configuration');
  await gui.page.screenshot({path:path.join(sandbox,'gui-settings.png')});
};
exports.restart=async(gui,vscode,id,pass)=>{
  await vscode.commands.executeCommand('autoblogger.openSession',id);
  const session=(await frame(gui.browser,'session')).frame;
  await session.getByRole('tab',{name:'메모·북마크'}).click();
  await session.getByLabel('메모',{exact:true}).fill('프로세스 재시작 후 복원할 입력');
  await sleep(400);
  pass('GUI draft prepared for host restart');
};
exports.checkRestart=async(gui,vscode,id,pass)=>{
  await vscode.commands.executeCommand('autoblogger.openSession',id);
  const session=(await frame(gui.browser,'session')).frame;
  await session.getByLabel('메모',{exact:true}).waitFor();
  assert.equal(await session.getByLabel('메모',{exact:true}).inputValue(),'프로세스 재시작 후 복원할 입력');
  pass('GUI draft restored after actual host process restart');
};
