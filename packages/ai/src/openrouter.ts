import { randomUUID } from 'node:crypto';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROMPT_VERSION, redactSecrets, type ModelRun, type ModelSettings } from '@autoblogger/shared';

export type CompletionOptions<T> = {
  task:string; system:string; input:unknown; schema:Record<string,unknown>;
  validate:(value:unknown)=>T; settings?:ModelSettings; signal?:AbortSignal;
  onDelta?:(text:string)=>void|Promise<void>; ownerId?:string; jobId?:string;
};
export class ModelError extends Error {constructor(message:string,public code='MODEL_ERROR',public retryable=false){super(message);}}
export class OpenRouterClient {
  private apiKey:string;
  constructor(private options:{apiKey?:string; fetch?:typeof fetch; onModelRun?:(run:ModelRun)=>Promise<void>|void; maxRetries?:number}={}){this.apiKey=options.apiKey??process.env.OPENROUTER_API_KEY??'';}
  async credit(){
    if(!this.apiKey)throw new ModelError('OpenRouter 키가 설정되지 않았습니다.','MODEL_KEY_MISSING');
    const response=await (this.options.fetch??fetch)('https://openrouter.ai/api/v1/key',{headers:{Authorization:`Bearer ${this.apiKey}`},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new ModelError(`OpenRouter 한도 조회 실패 (${response.status})`);
    const {data}=await response.json() as any;
    return {limit:data.limit,remaining:data.limit_remaining,usage:data.usage,reset:data.limit_reset};
  }
  async complete<T>(options:CompletionOptions<T>):Promise<{data:T;runs:ModelRun[]}>{
    if(!this.apiKey)throw new ModelError('OpenRouter 키가 설정되지 않았습니다.','MODEL_KEY_MISSING');
    const settings=options.settings??{model:DEFAULT_MODEL,provider:DEFAULT_PROVIDER};
    // The current Terra Azure endpoint requires its exact regional slug; the
    // parent "azure" slug is removed by OpenRouter's regional-surcharge filter.
    const route=settings.model===DEFAULT_MODEL&&settings.provider.toLowerCase()==='azure'?'azure/eu':settings.provider;
    const input=redactSecrets(JSON.stringify(options.input));
    if(input.length>600000)throw new ModelError('기록이 한 번의 안전한 분석 범위를 초과합니다. 파일 또는 세션을 나눠 주세요.','INPUT_TOO_LARGE');
    const runs:ModelRun[]=[];
    const maxAttempts=1+(this.options.maxRetries??1);
    for(let attempt=0;attempt<maxAttempts;attempt++){
      options.signal?.throwIfAborted();
      const started=Date.now();
      const run:ModelRun={id:randomUUID(),model:settings.model,provider:settings.provider,task:options.task,promptVersion:PROMPT_VERSION,cost:0,inputTokens:0,outputTokens:0,durationMs:0,status:'failed',createdAt:new Date().toISOString(),ownerId:options.ownerId,jobId:options.jobId,input:JSON.parse(input)};
      let completion='';
      try{
        const response=await (this.options.fetch??fetch)('https://openrouter.ai/api/v1/chat/completions',{
          method:'POST',headers:{Authorization:`Bearer ${this.apiKey}`,'Content-Type':'application/json','X-Title':'Autoblogger'},
          signal:AbortSignal.any([options.signal??new AbortController().signal,AbortSignal.timeout(120000)]),
          body:JSON.stringify({model:settings.model,provider:{only:[route],order:[route],allow_fallbacks:false,data_collection:'deny',require_parameters:true},
            messages:[{role:'system',content:options.system},{role:'user',content:input}],
            response_format:{type:'json_schema',json_schema:{name:options.task.replace(/[^a-zA-Z0-9_]/g,'_'),strict:true,schema:options.schema}},
            stream:!!options.onDelta,...(options.onDelta?{stream_options:{include_usage:true}}:{}),reasoning:{effort:'low'},...(settings.provider.toLowerCase()==='azure'?{max_completion_tokens:5000}:{max_tokens:5000})})
        });
        if(!response.ok){
          const error=await response.json().catch(()=>({})) as any;
          throw new ModelError(`OpenRouter ${response.status}: ${redactSecrets(String(error.error?.message??'request rejected')).slice(0,400)}`,'PROVIDER_ERROR',[429,502,503,504].includes(response.status));
        }
        let usage:any;let actualProvider:string|undefined;
        if(options.onDelta){
          if(!response.body)throw new ModelError('빈 응답 스트림');
          const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
          const consume=async(line:string)=>{
            if(!line.startsWith('data:'))return;
            const payload=line.slice(5).trim();if(!payload||payload==='[DONE]')return;
            const chunk=JSON.parse(payload);
            if(chunk.error)throw new ModelError(`스트림 오류: ${String(chunk.error.message).slice(0,200)}`);
            usage=chunk.usage??usage;actualProvider=chunk.provider??actualProvider;
            const delta=chunk.choices?.[0]?.delta?.content;
            if(delta){completion+=delta;await options.onDelta!(delta);}
          };
          try{
            while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let newline;while((newline=buffer.indexOf('\n'))>=0){await consume(buffer.slice(0,newline).replace(/\r$/,''));buffer=buffer.slice(newline+1);}}
            buffer+=decoder.decode();if(buffer.trim())await consume(buffer);
          }finally{reader.releaseLock();}
        }else{
          const payload=await response.json() as any;
          usage=payload.usage;actualProvider=payload.provider;
          completion=payload.choices?.[0]?.message?.content??'';
          if(payload.error)throw new ModelError(String(payload.error.message));
        }
        run.cost=Number(usage?.cost??0);run.inputTokens=Number(usage?.prompt_tokens??0);run.outputTokens=Number(usage?.completion_tokens??0);
        if(!Number.isFinite(run.cost)||run.cost<0)throw new ModelError('유효하지 않은 비용 응답');
        if(actualProvider&&actualProvider.toLowerCase()!==settings.provider.toLowerCase())throw new ModelError('요청한 provider와 실제 provider가 다릅니다.','PROVIDER_MISMATCH');
        if(usage?.cost===undefined)throw new ModelError('비용이 없는 응답은 완료 처리하지 않습니다.','USAGE_MISSING');
        const data=options.validate(JSON.parse(completion));
        run.status='completed';run.output=data;return {data,runs};
      }catch(error){
        run.status=options.signal?.aborted?'cancelled':'failed';
        run.error=redactSecrets(error instanceof Error?error.message:String(error));
        if(completion)run.output=completion;
        const retry=error instanceof ModelError&&error.retryable&&attempt+1<maxAttempts&&!options.signal?.aborted&&!completion;
        if(!retry)throw error;
      }finally{
        run.durationMs=Date.now()-started;runs.push(run);await this.options.onModelRun?.(run);
      }
      await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,500*(attempt+1));options.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal?.reason);},{once:true});});
    }
    throw new ModelError('모델 호출 재시도 한도에 도달했습니다.');
  }
}
