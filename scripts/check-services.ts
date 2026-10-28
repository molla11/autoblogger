import { AiService, GhostClient, OpenRouterClient } from '../packages/ai/src';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../packages/shared/src';
try{process.loadEnvFile('.env.local');}catch{}
async function main(){
 const client=new OpenRouterClient();
 console.log('OpenRouter key',await client.credit());
 const ghost=new GhostClient({url:process.env.GHOST_URL!,key:process.env.GHOST_ADMIN_API_KEY!});
 try{const site=await ghost.checkConnection();console.log('Ghost authentication',{ok:true,url:site.url,version:site.version});}catch(error){console.log('Ghost authentication',{ok:false,error:(error as Error).message});}
 if(process.argv.includes('--model')){
  const result=await client.complete({task:'smoke',system:'Return the word ready in the text property.',input:{check:true},settings:{model:DEFAULT_MODEL,provider:DEFAULT_PROVIDER},schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},validate:(v:any)=>{if(typeof v.text!=='string')throw new Error('Invalid structured output');return v;}});
  console.log('Model smoke',{ok:result.data.text==='ready',runs:result.runs.map(({model,provider,cost,durationMs,status})=>({model,provider,cost,durationMs,status}))});
 }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
