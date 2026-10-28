import {mkdir,writeFile} from 'node:fs/promises';
const base=process.env.TEST_API_URL||'http://127.0.0.1:4001/api';
async function request(path:string,method='GET',body?:unknown,token?:string,expected=200){
 const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok&&r.status!==expected)throw new Error(path+': '+r.status+' '+JSON.stringify(data));return {data,status:r.status};
}
async function main(){
 const report:any={startedAt:new Date().toISOString(),backend:base,checks:[],provenance:'synthetic mock integration, not human evaluation'};
 const {data:login}=await request('/auth/local','POST',{email:'queue-smoke-'+Date.now()+'@local.test'});const token=login.token;
 const {data:sample}=await request('/samples','POST',{},token);
 async function wait(id:string){for(let i=0;i<240;i++){const {data:j}=await request('/jobs/'+id,'GET',undefined,token);if(j.status==='completed')return j;if(['failed','cancelled'].includes(j.status))throw new Error(j.kind+': '+j.error);await new Promise(r=>setTimeout(r,500));}throw new Error('Job timeout');}
 const started=Date.now();const {data:job}=await request('/jobs','POST',{kind:'generate',sessionId:sample.session.id},token);const result=await wait(job.id);report.checks.push('BullMQ generation completed');report.draftMs=Date.now()-started;
 const latest=(await request('/jobs/'+job.id,'GET',undefined,token)).data;
 if(latest.result.reviewJobId){await wait(latest.result.reviewJobId);report.checks.push('Background evidence verification completed');}
 else{await new Promise(r=>setTimeout(r,1500));const refreshed=(await request('/jobs/'+job.id,'GET',undefined,token)).data;if(refreshed.result.reviewJobId){await wait(refreshed.result.reviewJobId);report.checks.push('Background evidence verification completed');}else throw new Error('Verification was not scheduled');}
 let article=(await request('/articles/'+result.result.articleId,'GET',undefined,token)).data;
 if(article.blocks.some((b:any)=>b.review==='supported'&&!b.evidenceIds.length))throw new Error('Unsupported block incorrectly verified');
 const block=article.blocks.find((b:any)=>b.type==='paragraph')||article.blocks[0];
 const suggestionJob=(await request('/jobs','POST',{kind:'suggest',articleId:article.id,blockId:block.id,instruction:'더 짧게'},token)).data;const suggestion=(await wait(suggestionJob.id)).result.suggestion;
 article=(await request('/articles/'+article.id,'PUT',{...article,title:article.title+' (edited)',expectedVersion:article.version,kind:'manual'},token)).data;
 const stale=await request('/suggestions/'+suggestion.id+'/resolve','POST',{action:'accept',expectedVersion:article.version},token,409);if(stale.status!==409)throw new Error('Stale AI suggestion overwrote edits');report.checks.push('Stale suggestion rejected with edits preserved');
 await request('/suggestions/'+suggestion.id+'/resolve','POST',{action:'reject',expectedVersion:article.version},token);
 const summaryStarted=Date.now();const summaryJob=(await request('/jobs','POST',{kind:'summarize',sessionId:sample.session.id},token)).data;await wait(summaryJob.id);report.summaryMs=Date.now()-summaryStarted;report.checks.push('Timeline summary persisted');
 const admin=(await request('/auth/local','POST',{email:'admin@local.test'})).data;
 await request('/admin/users/'+login.user.id,'PATCH',{dailyLimit:0,monthlyLimit:15},admin.token);
 const capped=await request('/jobs','POST',{kind:'summarize',sessionId:sample.session.id},token,429);if(capped.status!==429)throw new Error('Usage cap was not enforced');
 await request('/articles/'+article.id,'PUT',{...article,title:article.title+' (AI cap active)',expectedVersion:article.version,kind:'manual'},token);report.checks.push('AI cap rejects jobs while editing remains available');
 const usage=(await request('/me','GET',undefined,token)).data.usage;report.usage=usage;report.finishedAt=new Date().toISOString();
 await mkdir('.data/reports',{recursive:true});await writeFile('.data/reports/live-flow.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
