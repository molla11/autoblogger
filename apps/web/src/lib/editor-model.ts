import type {JSONContent} from '@tiptap/react';
import type {ArticleBlock,Article} from './types';
const text=(content?:JSONContent[]):string=>(content||[]).map(n=>n.type==='hardBreak'?'\n':n.text??text(n.content)).join('');
export const newId=()=>globalThis.crypto.randomUUID();
function inline(value:string):JSONContent[]{return value?[{type:'text',text:value}]:[]}
export function blocksToDocument(blocks:ArticleBlock[]):JSONContent{
 return {type:'doc',content:blocks.length?blocks.map(block=>{
 const attrs={id:block.id};
 if(block.type==='heading')return {type:'heading',attrs:{...attrs,level:2},content:inline(block.text)};
 if(block.type==='code')return {type:'codeBlock',attrs:{...attrs,language:block.language||'text'},content:inline(block.text)};
 if(block.type==='quote')return {type:'blockquote',attrs,content:[{type:'paragraph',content:inline(block.text)}]};
 if(block.type==='list')return {type:'bulletList',attrs,content:block.text.split('\n').map(line=>({type:'listItem',content:[{type:'paragraph',content:inline(line.replace(/^[-*] /,''))}]}))};
 if(block.type==='image')return {type:'image',attrs:{...attrs,src:block.url||'',alt:block.text}};
 return {type:'paragraph',attrs,content:inline(block.text)};
 }):[{type:'paragraph',attrs:{id:newId()}}]};
}
export function articleDocument(article:Article):JSONContent{
 const stored=article.lexical?.autobloggerEditor as JSONContent|undefined;
 return stored?.type==='doc'?stored:blocksToDocument(article.blocks||[]);
}
export function documentBlocks(document:JSONContent,previous:ArticleBlock[]):ArticleBlock[]{
 const old=new Map(previous.map(block=>[block.id,block]));
 return (document.content||[]).map(node=>{
 const id=String(node.attrs?.id||newId()),existing=old.get(id);
 const type:ArticleBlock['type']=node.type==='heading'?'heading':node.type==='codeBlock'?'code':node.type==='blockquote'?'quote':node.type==='image'?'image':node.type==='bulletList'||node.type==='orderedList'?'list':'paragraph';
 const body=type==='image'?String(node.attrs?.alt||''):type==='list'?(node.content||[]).map(n=>text(n.content)).join('\n'):text(node.content);
 const block:ArticleBlock={id,type,text:body,evidenceIds:existing?.evidenceIds||[],review:existing?.review||'needs_review'};
 if(type==='code')block.language=String(node.attrs?.language||'text');if(type==='image')block.url=String(node.attrs?.src||'');
 if(existing&&(existing.text!==block.text||existing.type!==block.type||existing.url!==block.url||existing.language!==block.language))block.review='needs_review';
 return block;
 });
}
export function editorPayload(document:JSONContent,html:string){
 return {root:{type:'root',version:1,children:[{type:'html',version:1,html}],direction:null,format:'',indent:0},autobloggerEditor:document};
}
export function reorderBlocks(document:JSONContent,index:number,direction:-1|1):JSONContent{
 const content=[...(document.content||[])],target=index+direction;if(index<0||target<0||target>=content.length)return document;
 [content[index],content[target]]=[content[target],content[index]];return {...document,content};
}
