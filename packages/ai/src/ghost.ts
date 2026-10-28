import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, FormData as UndiciFormData, fetch as undiciFetch } from 'undici';
import sanitizeHtml from 'sanitize-html';

export class GhostError extends Error {constructor(message:string,public code='GHOST_ERROR',public remote?:unknown){super(message);}}
export function isPublicAddress(address:string):boolean{
  if(isIP(address)===4){
    const [a,b,c]=address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
  }
  if(isIP(address)===6){const a=address.toLowerCase();return /^[23][0-9a-f]{0,3}:/.test(a)&&!a.startsWith('2001:db8:')&&!a.startsWith('2001:0:')&&!a.startsWith('2002:');}
  return false;
}
export async function validateExternalUrl(raw:string,allowLocal=false){
  const url=new URL(raw);
  if(url.username||url.password||url.hash||!['https:','http:'].includes(url.protocol))throw new GhostError('허용되지 않는 외부 URL입니다.','UNSAFE_URL');
  if(url.protocol!=='https:'&&!allowLocal)throw new GhostError('HTTPS 주소를 사용하세요.','UNSAFE_URL');
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true});
  if(!addresses.length||!allowLocal&&addresses.some(x=>!isPublicAddress(x.address)))throw new GhostError('내부 또는 예약된 네트워크 주소는 사용할 수 없습니다.','UNSAFE_URL');
  return {url,addresses};
}
/** Resolves once, rejects redirects, and pins the connection to validated addresses. */
export async function safeFetch(raw:string,init:Parameters<typeof undiciFetch>[1]={},allowLocal=false){
  const {url,addresses}=await validateExternalUrl(raw,allowLocal);
  const dispatcher=new Agent({connect:{lookup:((_hostname:any,options:any,callback:any)=>{
    const list=options?.family?addresses.filter(a=>a.family===options.family):addresses;
    const target=list[0]??addresses[0];
    if(options?.all)callback(null,list.length?list:addresses);else callback(null,target.address,target.family);
  }) as any}});
  try{
    const response=await undiciFetch(url,{...init,redirect:'error',dispatcher,signal:init?.signal??AbortSignal.timeout(30000)});
    const limit=12*1024*1024;const declared=Number(response.headers.get('content-length')||0);
    if(declared>limit)throw new GhostError('원격 응답이 너무 큽니다.');
    const chunks:Uint8Array[]=[];let size=0;
    if(response.body)for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw new GhostError('원격 응답이 너무 큽니다.');chunks.push(chunk);}
    return new Response([204,205,304].includes(response.status)?null:Buffer.concat(chunks),{status:response.status,statusText:response.statusText,headers:Object.fromEntries(response.headers)});
  }finally{await dispatcher.close();}
}
export function cleanGhostLexical(lexical:any):any{
  const allowed=new Set(['root','paragraph','heading','text','linebreak','list','listitem','quote','code','code-highlight','codeblock','image','link','html','horizontalrule']);
  function clean(node:any):any{
    if(!node||typeof node!=='object'||!allowed.has(node.type))return null;
    const result:any={...node};
    for(const key of ['id','blockId','evidenceIds','review','$','__key','__evidence'])delete result[key];
    if(Array.isArray(result.children))result.children=result.children.map(clean).filter(Boolean);
    if(result.type==='html')result.html=sanitizeHtml(String(result.html??''),{allowedTags:[...sanitizeHtml.defaults.allowedTags,'img','figure','figcaption','h1','h2','h3','pre','code'],allowedAttributes:{...sanitizeHtml.defaults.allowedAttributes,img:['src','alt','width','height'],code:['class'],pre:['class']},allowedSchemes:['https','http','mailto'],allowProtocolRelative:false});
    if(result.type==='image'&&(!/^https?:\/\//.test(String(result.src))))throw new GhostError('이미지는 Ghost 업로드 후 HTTP URL로 전송해야 합니다.');
    if(result.type==='link'&&!/^https?:\/\//.test(String(result.url)))result.url='';
    return result;
  }
  const root=clean(lexical?.root);
  if(!root||root.type!=='root')throw new GhostError('유효하지 않은 Ghost 문서입니다.');
  return {root};
}
export type GhostPost={id:string;title:string;status:string;updated_at:string;url:string;lexical:string;slug:string};
/** Parse image attributes, upload each unique source once, then serialize safely. */
export async function rewriteGhostImages(lexical:any,upload:(url:string)=>Promise<string>){
  const document=structuredClone(lexical),sources=new Set<string>();
  const walk=(node:any,visit:(node:any)=>void)=>{if(!node||typeof node!=='object')return;visit(node);if(Array.isArray(node.children))node.children.forEach((child:any)=>walk(child,visit));};
  const htmlOptions={allowedTags:[...sanitizeHtml.defaults.allowedTags,'img','figure','figcaption','h1','h2','h3','pre','code'],allowedAttributes:{...sanitizeHtml.defaults.allowedAttributes,img:['src','alt','width','height'],code:['class'],pre:['class']},allowedSchemes:['https','http','mailto'],allowProtocolRelative:false};
  walk(document?.root,node=>{
    if(node.type==='image'&&typeof node.src==='string')sources.add(node.src);
    if(node.type==='html'){
      node.html=sanitizeHtml(String(node.html??''),htmlOptions);
      sanitizeHtml(node.html,{...htmlOptions,transformTags:{img:(tagName,attribs)=>{if(attribs.src)sources.add(attribs.src);return {tagName,attribs};}}});
    }
  });
  const mapped=new Map<string,string>();
  for(const src of sources){const url=await upload(src);if(!/^https?:\/\//.test(url))throw new GhostError('Ghost 이미지 업로드 URL이 유효하지 않습니다.');mapped.set(src,url);}
  walk(document?.root,node=>{
    if(node.type==='image'&&mapped.has(node.src))node.src=mapped.get(node.src);
    if(node.type==='html')node.html=sanitizeHtml(node.html,{...htmlOptions,transformTags:{img:(tagName,attribs)=>({tagName,attribs:{...attribs,...(mapped.has(attribs.src)?{src:mapped.get(attribs.src)!}:{})}})}});
  });
  return cleanGhostLexical(document);
}
export class GhostClient {
  private url:string;
  constructor(private options:{url:string;key:string;allowLocal?:boolean}){this.url=options.url.replace(/\/$/,'');}
  private token(){
    const [id,secret,...rest]=this.options.key.split(':');
    if(!id||!secret||rest.length||!/^[\da-f]+$/i.test(secret)||secret.length%2)throw new GhostError('Ghost Admin API Key 형식이 올바르지 않습니다.','INVALID_KEY');
    const enc=(data:unknown)=>Buffer.from(JSON.stringify(data)).toString('base64url');
    const now=Math.floor(Date.now()/1000);const payload=enc({alg:'HS256',typ:'JWT',kid:id})+'.'+enc({iat:now,exp:now+300,aud:'/admin/'});
    return payload+'.'+createHmac('sha256',Buffer.from(secret,'hex')).update(payload).digest('base64url');
  }
  private async request(path:string,method='GET',body?:unknown){
    const headers:Record<string,string>={Authorization:`Ghost ${this.token()}`,'Accept-Version':'v5.0','User-Agent':'autoblogger/0.1'};
    let payload:string|UndiciFormData|undefined;
    if(body instanceof UndiciFormData)payload=body;else if(body!==undefined){headers['Content-Type']='application/json';payload=JSON.stringify(body);}
    const response=await safeFetch(this.url+'/ghost/api/admin/'+path,{method,headers,body:payload as any},this.options.allowLocal);
    if(response.status===204)return {};
    const data=await response.json().catch(()=>({})) as any;
    if(!response.ok)throw new GhostError(`Ghost 요청 실패 (${response.status}): ${String(data.errors?.[0]?.message??'원격 응답을 확인하세요.').slice(0,300)}`,response.status===409?'GHOST_CONFLICT':response.status===404?'NOT_FOUND':'GHOST_ERROR');
    return data;
  }
  async checkConnection(){const data=await this.request('site/');return {url:this.url,...data.site};}
  async getPost(id:string):Promise<GhostPost>{const data=await this.request(`posts/${encodeURIComponent(id)}/?formats=lexical,html`);return data.posts[0];}
  async getBySlug(slug:string):Promise<GhostPost|null>{const data=await this.request('posts/?filter='+encodeURIComponent('slug:'+slug)+'&formats=lexical,html&limit=1');return data.posts?.[0]??null;}
  async deletePost(id:string){await this.request(`posts/${encodeURIComponent(id)}/`,'DELETE');}
  async uploadImage(data:Uint8Array,filename:string,mime:string):Promise<string>{
    if(data.byteLength>10*1024*1024)throw new GhostError('이미지는 10MB 이하여야 합니다.');
    if(!['image/png','image/jpeg','image/gif','image/webp'].includes(mime))throw new GhostError('지원하지 않는 이미지 형식입니다.');
    const form=new UndiciFormData();form.append('file',new Blob([new Uint8Array(data)],{type:mime}),filename.replace(/[^a-zA-Z0-9._-]/g,'_'));form.append('purpose','image');
    const result=await this.request('images/upload/','POST',form);return result.images[0].url;
  }
  async publish(input:{articleId:string;title:string;lexical:any;status:'draft'|'published';remoteId?:string;expectedUpdatedAt?:string}):Promise<GhostPost>{
    const lexical=JSON.stringify(cleanGhostLexical(input.lexical));
    const slug='autoblogger-'+input.articleId.replace(/[^a-zA-Z0-9-]/g,'-');
    let remote:GhostPost|null=input.remoteId?await this.getPost(input.remoteId):await this.getBySlug(slug);
    if(remote){
      // A create response may have been lost. An identical post is a reconciled success.
      if(!input.remoteId){
        if(remote.lexical===lexical&&remote.title===input.title&&remote.status===input.status)return remote;
        throw new GhostError('같은 작업 식별자의 원격 글이 다릅니다. 비교 후 다시 요청하세요.','GHOST_CONFLICT',remote);
      }
      if(!input.expectedUpdatedAt||remote.updated_at!==input.expectedUpdatedAt)throw new GhostError('Ghost에서 글이 변경되었습니다. 원격 변경을 비교하세요.','GHOST_CONFLICT',remote);
      const data=await this.request(`posts/${encodeURIComponent(remote.id)}/`,'PUT',{posts:[{title:input.title,lexical,status:input.status,visibility:'public',updated_at:remote.updated_at}]});
      return data.posts[0];
    }
    const data=await this.request('posts/','POST',{posts:[{title:input.title,slug,lexical,status:input.status,visibility:'public'}]});
    return data.posts[0];
  }
}
