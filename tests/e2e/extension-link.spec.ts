import { test, expect } from '@playwright/test';
const API=process.env.GUI_API_URL || 'http://127.0.0.1:4000/api';
test.use({baseURL:process.env.GUI_WEB_URL || 'http://127.0.0.1:3000'});
test('extension session/file link survives login and opens the selected file without starting AI',async({page,request})=>{
  const login=await request.post(API+'/auth/local',{data:{email:'admin@local.test'}});
  const {token}=await login.json();
  const headers={Authorization:'Bearer '+token};
  const sample=await (await request.post(API+'/samples',{headers})).json();
  const detail=await (await request.get(API+`/sessions/${sample.session.id}`,{headers})).json();
  const file=detail.files[0];
  let jobRequests=0;
  page.on('request',request=>{if(request.method()==='POST'&&request.url()===API+'/jobs')jobRequests++;});
  await page.goto(`/?session=${sample.session.id}&file=${file.id}`);
  await page.getByRole('button',{name:'작업 공간 열기',exact:true}).click();
  await expect(page.getByRole('button',{name:/초안/}).first()).toBeVisible();
  await expect(page.locator('.file-tabs button.active')).toHaveText((file.path || file.filePath).split(/[\\/]/).pop());
  expect(await page.evaluate(()=>sessionStorage.getItem('autoblogger.open'))).toBeNull();
  expect(jobRequests).toBe(0);
});
test('inaccessible extension session shows an error rather than another account data',async({page,request})=>{
  const {token}=await (await request.post(API+'/auth/local',{data:{email:'link-other@local.test'}})).json();
  await page.addInitScript(token=>localStorage.setItem('autoblogger.session',token),token);
  await page.goto('/?session=11111111-1111-4111-8111-111111111111');
  await expect(page.getByText('세션이 삭제되었거나 현재 계정으로 접근할 수 없습니다.',{exact:true})).toBeVisible();
});
