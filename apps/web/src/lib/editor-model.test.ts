import {describe,it,expect} from 'vitest';
import {blocksToDocument,documentBlocks,editorPayload,reorderBlocks,articleDocument} from './editor-model';
import type {ArticleBlock,Article} from './types';
const block:ArticleBlock={id:'stable-one',type:'code',text:'print(1)',language:'python',evidenceIds:['snapshot-one'],review:'supported'};
describe('editor evidence and document integrity',()=>{
 it('preserves stable identity and evidence through load/save',()=>{expect(documentBlocks(blocksToDocument([block]),[block])).toEqual([block]);});
 it('invalidates reviewed claims when the user changes content',()=>{const doc=blocksToDocument([block]);doc.content![0].content![0].text='print(2)';expect(documentBlocks(doc,[block])[0]).toMatchObject({id:'stable-one',text:'print(2)',evidenceIds:['snapshot-one'],review:'needs_review'});});
 it('invalidates image evidence when its source changes',()=>{const original:ArticleBlock={...block,type:'image',text:'diagram',url:'https://example.com/one.png'};const doc=blocksToDocument([original]);doc.content![0].attrs!.src='https://example.com/two.png';expect(documentBlocks(doc,[original])[0].review).toBe('needs_review');});
 it('preserves block/evidence associations when reordered',()=>{const second:ArticleBlock={...block,id:'stable-two',text:'print(2)',evidenceIds:['snapshot-two']};const document=reorderBlocks(blocksToDocument([block,second]),0,1);expect(documentBlocks(document,[block,second])).toEqual([second,block]);});
 it('keeps code as text rather than treating it as editor markup',()=>{const code={...block,text:'<script>alert(1)</script>'};expect(blocksToDocument([code]).content![0].content).toEqual([{type:'text',text:code.text}]);});
 it('stores Tiptap source separately from the transportable Ghost HTML card',()=>{const document=blocksToDocument([block]);const payload=editorPayload(document,'<pre>print(1)</pre>');expect(payload.root.children).toEqual([{type:'html',version:1,html:'<pre>print(1)</pre>'}]);expect(articleDocument({lexical:payload,blocks:[block]} as unknown as Article)).toEqual(document);});
 it('loads generated blocks when no saved rich editor state exists',()=>{expect(articleDocument({blocks:[block],lexical:{}} as Article)).toEqual(blocksToDocument([block]));});
});
