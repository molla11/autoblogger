import { test, expect, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(__dirname, '../..');
const settings={apiUrl:'http://127.0.0.1:4000/api',webUrl:'http://localhost:3000',excludePatterns:['**/.git/**'],autoSync:true,syncIntervalSeconds:15,outputLimitBytes:262144};
const base={active:{id:'session-1',name:'풀이 연습',rootPath:'/tmp/practice',startedAt:'2026-10-29T09:00:00Z',count:3},folders:[{name:'풀이 연습',path:'/tmp/practice'}],root:'/tmp/practice',trusted:true,target:{sessionId:'session-1',file:'/tmp/practice/solve.py',line:7},currentFile:'/tmp/practice/solve.py',collection:'수집 대상',connection:'disconnected',pending:3,syncing:false,autoSync:true,error:'',terminals:1,host:'wsl',settings,defaults:settings,revision:JSON.stringify(settings),settingSources:{},remoteExcludes:[],excludedFiles:[]};
const events=[{id:'event-1',sessionId:'session-1',sequence:1,type:'snapshot',fileId:'file-1',filePath:'solve.py',occurredAt:'2026-10-29T09:00:00Z',acknowledged:false,preview:'',data:{content:'print("hello")'}},{id:'event-2',sessionId:'session-1',sequence:2,type:'run',fileId:'file-1',filePath:'solve.py',occurredAt:'2026-10-29T09:01:00Z',acknowledged:false,preview:'python3 solve.py',label:'runtime_error',data:{command:'python3 solve.py',output:'<img src=x onerror="window.compromised=true">',status:'runtime_error',exitCode:1,durationMs:12,cwd:'/tmp/practice',snapshotId:'event-1'}}];
async function boot(page: Page,surface: string,extra={}) {
  await page.setContent(`<html lang="ko"><body data-surface="${surface}"><main id="app"></main><div id="feedback" role="status"></div></body></html>`);
  await page.addStyleTag({content:':root{--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-focusBorder:#0078d4;--vscode-textLink-foreground:#4daafc;--vscode-panel-border:#444444;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;}'});
  await page.addStyleTag({content:await readFile(path.join(root,'apps/extension/media/app.css'),'utf8')});
  await page.evaluate(({base,extra,events,surface}) => {
    const w=window as any; w.messages=[]; w.persisted={};
    w.model={...base,...extra};
    if(surface==='session') Object.assign(w.model,{session:{...base.active,recording:true},count:2,total:2,page:0,sessionPending:2,gaps:[1,2],events,files:[{id:'file-1',path:'solve.py'}],webReason:'이 세션의 동기화를 완료하세요.'});
    w.acquireVsCodeApi=()=>({getState:()=>w.persisted,setState:(s:any)=>w.persisted=s,postMessage:(m:any)=>{
      w.messages.push(m);
      if(m.type==='ready'||m.type==='view'){
        if(m.payload?.eventId) w.model.selected=events.find((e:any)=>e.id===m.payload.eventId);
        setTimeout(()=>window.postMessage({type:'model',model:w.model,view:m.type==='view'?m.payload:{},sessionId:surface==='session'?'session-1':undefined},'*'),0);
      }
    }});
  },{base,extra,events,surface});
  await page.addScriptTag({content:await readFile(path.join(root,'apps/extension/media/app.js'),'utf8')});
  await expect(page.locator('main')).not.toBeEmpty();
}
test('memo target survives focus changes and host refresh; errors preserve draft',async({page})=>{
  await boot(page,'recording');
  await page.getByLabel('메모',{exact:true}).fill('경계 조건을 다시 확인한다.');
  await page.evaluate(()=>{const w=window as any;w.model.target={sessionId:'session-1',file:'/tmp/practice/other.py',line:99};window.postMessage({type:'model',model:w.model,view:{}},'*');});
  await expect(page.getByLabel('메모',{exact:true})).toHaveValue('경계 조건을 다시 확인한다.');
  await page.getByRole('button',{name:'메모 저장',exact:true}).click();
  const message=await page.evaluate(()=>(window as any).messages.findLast((m:any)=>m.action==='memo'));
  expect(message.payload.target.file).toBe('/tmp/practice/solve.py'); expect(message.payload.target.line).toBe(7);
  await page.evaluate(id=>window.postMessage({type:'error',id,message:'세션이 종료되었습니다.'},'*'),message.id);
  await expect(page.getByRole('status')).toContainText('세션이 종료되었습니다.');
  await expect(page.getByLabel('메모',{exact:true})).toHaveValue('경계 조건을 다시 확인한다.');
});
test('session renders captured HTML as text and tabs support keyboard navigation',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await boot(page,'session');
  await page.locator('[data-event="event-2"]').click();
  await expect(page.getByLabel('출력',{exact:true})).toContainText('<img src=x');
  expect(await page.evaluate(()=>(window as any).compromised)).toBeUndefined();
  expect(await page.locator('.detail img').count()).toBe(0);
  await page.getByRole('tab',{name:'타임라인',exact:true}).focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab',{name:'파일·실행'})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('button',{name:'웹에서 글 작성'})).toBeDisabled();
  await page.screenshot({path:'.data/screenshots/extension-session.png',fullPage:true});
  expect(errors).toEqual([]);
});
test('settings preserve unsaved edits and reject stale revisions through the host contract',async({page})=>{
  await boot(page,'settings');
  await page.getByLabel('동기화 주기 (초)',{exact:true}).fill('25');
  await page.evaluate(()=>{const w=window as any;w.model.settings.syncIntervalSeconds=30;w.model.revision=JSON.stringify(w.model.settings);window.postMessage({type:'model',model:w.model,view:{}},'*');});
  await expect(page.getByLabel('동기화 주기 (초)',{exact:true})).toHaveValue('25');
  await expect(page.getByText('다른 화면에서 설정이 바뀌었습니다.',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'설정 저장',exact:true}).click();
  const message=await page.evaluate(()=>(window as any).messages.findLast((m:any)=>m.action==='saveSettings'));
  expect(message.payload.values.syncIntervalSeconds).toBe(25);expect(JSON.parse(message.payload.revision).syncIntervalSeconds).toBe(15);
});
test('narrow sidebar has no horizontal overflow and untrusted workspace explains disabled recording',async({page})=>{
  await page.setViewportSize({width:260,height:900});
  await boot(page,'recording',{active:undefined,trusted:false,target:{sessionId:''}});
  await expect(page.getByRole('button',{name:'기록 시작',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'작업 영역 신뢰 관리'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({path:'.data/screenshots/extension-sidebar.png',fullPage:true});
});
