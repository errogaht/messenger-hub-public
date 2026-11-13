import {test} from 'node:test';
import assert from 'node:assert/strict';
import {historySearch} from '../src/history-search.mjs';
import whatsapp from '../src/plugins/whatsapp.mjs';

test('WhatsApp search folds Cyrillic including capitals and never passes a broken native query',async()=>{
 // Faithful provider behavior: get_messages without search reads the exact chat.
 const jid='111@s.whatsapp.net',texts=['Техническая проверка','Ещё сообщение','ТЕХНИЧЕСКАЯ проверка','прочее'];
 const calls=[];const p=whatsapp.create({upstreamClient:{call:async(name,args)=>{
  calls.push(args);assert.equal(args.chat_jid,jid);assert.equal(args.search,undefined);
  return {data:texts.slice(args.offset,args.offset+args.limit).map((content,i)=>({id:String(args.offset+i),chat_jid:jid,timestamp:'2026-09-28T00:00:00Z',content,is_from_me:true}))};
 }}});
 for(const query of ['Техническая','техническая','ТЕХНИЧЕСКАЯ','Техническая проверка']){
  const r=await p.search({conversationId:jid,cursor:null,limit:1,query});assert.equal(r.items[0].id,'0');assert.equal(r.complete,false);
  const next=await p.search({conversationId:jid,cursor:r.next,limit:1,query});assert.equal(next.items[0].id,'2');
  const last=await p.search({conversationId:jid,cursor:next.next,limit:1,query});assert.equal(last.items.length,0);assert.equal(last.complete,true);
 }
 assert.equal((await p.search({conversationId:jid,cursor:null,limit:10,query:'Ещё'})).items[0].id,'1');
});
test('sparse search resumes at scan boundary, preserves literal wildcard characters and binds chat/query',async()=>{
 // Empty pages mean a bounded window contained no matches, not an exhaustive account search.
 const rows=Array.from({length:310},(_,i)=>({id:String(i),text:i===250?'Строка 100%_x':'прочее'}));
 const search=historySearch(async v=>{const offset=Number(v.cursor),items=rows.slice(offset,offset+v.limit);return {items,next:offset+items.length<rows.length?String(offset+items.length):null};},{scanLimit:200});
 const v={conversationId:'chat',query:'100%_x',limit:10,cursor:null};
 const first=await search(v);assert.equal(first.complete,false);assert.deepEqual(first.items,[]);assert.ok(first.next);
 const next=await search({...v,cursor:first.next});assert.deepEqual(next.items.map(m=>m.id),['250']);assert.equal(next.complete,true);
 for(const patch of [{conversationId:'other'},{query:'прочее'}])await assert.rejects(search({...v,...patch,cursor:first.next}),/cursor_invalid/);
});
