import { z } from 'zod';

export const DEFAULT_MODEL = 'openai/gpt-6.1-terra';
export const DEFAULT_PROVIDER = 'Azure';
export const PROMPT_VERSION = '2026-10-29.v1';
export type ModelSettings = { model: string; provider: string };
export const settingsSchema = z.object({model:z.string().min(1).max(150),provider:z.string().min(1).max(100)});
export const eventSchema = z.object({id:z.string().min(1),sessionId:z.string().min(1),sequence:z.number().int().positive(),type:z.enum(['snapshot','edit','run','memo','session_start','session_stop']),fileId:z.string().optional(),filePath:z.string().optional(),occurredAt:z.string().datetime(),documentVersion:z.number().int().optional(),data:z.record(z.unknown())});
export type RecordEvent = z.infer<typeof eventSchema>;
export const blockSchema=z.object({id:z.string(),type:z.enum(['heading','paragraph','quote','code','list','image']),text:z.string(),language:z.string().optional(),url:z.string().optional(),evidenceIds:z.array(z.string()),review:z.enum(['needs_review','supported','insufficient','conflict','unknown'])});
export type ArticleBlock=z.infer<typeof blockSchema>;
export type ModelRun={id:string;model:string;provider:string;task:string;promptVersion:string;cost:number;inputTokens:number;outputTokens:number;durationMs:number;status:'completed'|'failed'|'cancelled';error?:string;createdAt:string;ownerId?:string;jobId?:string;input?:unknown;output?:unknown};
export function escapeHtml(value:string):string{return value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
export function safeImageUrl(url:string):string{try{const u=new URL(url);return ['https:','http:'].includes(u.protocol)?u.href:'';}catch{return '';}}
export function blocksToHtml(blocks:ArticleBlock[]):string{return blocks.map(b=>{const text=escapeHtml(b.text);switch(b.type){case 'heading':return `<h2>${text}</h2>`;case 'quote':return `<blockquote><p>${text}</p></blockquote>`;case 'code':return `<pre><code class="language-${escapeHtml((b.language||'text').replace(/[^\w+-]/g,''))}">${text}</code></pre>`;case 'list':return '<ul>'+b.text.split('\n').map(x=>`<li>${escapeHtml(x)}</li>`).join('')+'</ul>';case 'image':{const url=safeImageUrl(b.url||'');return url?`<figure><img src="${escapeHtml(url)}" alt="${text}"><figcaption>${text}</figcaption></figure>`:'';}default:return `<p>${text.replace(/\n/g,'<br>')}</p>`;}}).join('\n');}
export function blocksToLexical(blocks:ArticleBlock[]):Record<string,unknown>{return {root:{children:[{type:'html',version:1,html:blocksToHtml(blocks)}],direction:null,format:'',indent:0,type:'root',version:1}};}
export function blocksToMarkdown(blocks:ArticleBlock[]):string{return blocks.map(b=>{switch(b.type){case 'heading':return '## '+b.text;case 'quote':return b.text.split('\n').map(x=>'> '+x).join('\n');case 'list':return b.text.split('\n').map(x=>'- '+x).join('\n');case 'code':{const lengths=[...b.text.matchAll(/`+/g)].map(x=>x[0].length);const fence='`'.repeat(Math.max(3,...lengths.map(x=>x+1)));return fence+(b.language||'')+'\n'+b.text+'\n'+fence;}case 'image':return `![${b.text.replace(/\]/g,'\\]')}](${safeImageUrl(b.url||'').replace(/\)/g,'%29')})`;default:return b.text;}}).join('\n\n')+'\n';}
export function redactSecrets(text:string):string{return text.replace(/\b(?:sk-or-v1-|sk-|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{16,}\b/g,'[REDACTED]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED_JWT]').replace(/((?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*["']?)[^\s"';]+/gi,'$1[REDACTED]');}
