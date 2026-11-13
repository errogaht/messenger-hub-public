import {test} from 'node:test';
import assert from 'node:assert/strict';
import telegram from '../src/plugins/telegram.mjs';
import {telegramAddress} from '../src/telegram-address.mjs';
import {Hub} from '../src/hub.mjs';
import {Store} from '../src/store.mjs';
import {diagnostic} from '../src/errors.mjs';

const peer=(id,title,kind='channel',username=null)=>({id,title,kind,username,canSend:false});
const channel=peer('-1001000000009','Тестовый канал уведомлений','channel','example_alert_channel');
const fixture=(handler,allowed='*')=>new Hub({version:1,store:':memory:',plugins:{telegram:'/unused'},connections:{tg:{plugin:'telegram',label:'TG',settings:{selfId:'4',upstreamClient:{call:handler,close:async()=>{}}}}},scopes:{reader:{token:'x'.repeat(40),connections:{tg:{read:true,send:false,conversations:allowed}}}}},{telegram},new Store(':memory:'));

test('Telegram address forms select a peer, reject invites/foreign URLs and retain title text',()=>{
 // Post links do not turn into HTTP fetches or joins; marked private-link IDs stay exact.
 for(const value of ['@example_alert_channel','example_alert_channel','t.me/example_alert_channel','https://t.me/example_alert_channel/42?single','https://t.me/s/example_alert_channel/42'])assert.equal(telegramAddress(value).value,'example_alert_channel');
 assert.equal(telegramAddress('https://t.me/c/1000000009/42').value,channel.id);
 assert.equal(telegramAddress(channel.title).kind,'title');
 for(const value of ['https://example.com/channel','t.me/+invite','t.me/joinchat/abc','@bad!','0','t.me/channel/not-a-post'])assert.throws(()=>telegramAddress(value),{code:'conversation_format_invalid'});
});

test('aliases resolve before history/cache, canonical response cursors and later message/attachment calls',async()=>{
 // An exact link bypasses misleading contacts. Frozen pages bind canonical ID,
 // so the caller can switch to that returned ID on subsequent calls.
 const calls=[];const hub=fixture(async(name,args)=>{calls.push([name,args]);
  if(name==='hub_read_resolve')return {item:channel};
  if(name==='get_messages')return Array.from({length:3},(_,i)=>`ID: ${30-i} | Member [id=8] | Date: 2026-10-21T00:00:00Z | Message: ${'x'.repeat(800)}`).join('\n');
  if(name==='get_media_info')return 'No media';
  throw Error(name);
 });
 try{
  let r=await hub.call('reader','history',{connectionId:'tg',conversationId:'t.me/example_alert_channel/42',readMode:'refresh',limit:30,maxResponseChars:2200,transcribeAudio:false});
  assert.equal(r.conversationId,channel.id);assert.ok(r.next);const ids=r.items.map(x=>x.id);
  while(r.next){r=await hub.call('reader','history',{connectionId:'tg',conversationId:channel.id,readMode:'refresh',limit:30,maxResponseChars:2200,transcribeAudio:false,cursor:r.next});ids.push(...r.items.map(x=>x.id));}
  assert.deepEqual(ids,['30','29','28']);assert.ok(calls.filter(([n])=>n==='get_messages').every(([,a])=>a.chat_id===channel.id));
  const cached=await hub.call('reader','history',{connectionId:'tg',conversationId:'@example_alert_channel',readMode:'cached',limit:30});assert.equal(cached.items.length,3);
  const message=await hub.call('reader','message_get',{connectionId:'tg',conversationId:'@example_alert_channel',readMode:'cached',messageId:'30'});assert.equal(message.message.conversationId,channel.id);
  assert.equal(calls.filter(([n])=>n==='hub_read_resolve').length,1);
 }finally{await hub.close();}
});

test('title resolution follows empty filtered pages and contacts never terminate dialog enumeration',async()=>{
 // Contact on page0 and another channel on page100 must both be considered.
 const hub=fixture(async(name,args)=>{
  assert.equal(name,'hub_read_catalog');return args.offset===0?{items:[peer('8','unrelated','direct')],next:'100',complete:false}:{items:[channel],next:null,complete:true};
 });
 try{const a=hub.instances.get('tg');const p=await a.conversations({query:'Тестовый канал',cursor:null,limit:100});assert.equal(p.items.length,0);assert.ok(p.next);assert.equal(p.complete,false);
 const r=await a.resolveConversation({address:telegramAddress('Тестовый канал'),allowed:'*'});assert.equal(r.id,channel.id);
 }finally{await hub.close();}
});

test('ambiguity, truncated coverage, provider and access errors remain distinct and scoped',async()=>{
 // A unique observed candidate is not unique evidence when the scan was capped.
 for(const complete of [true,false]){
  const hub=fixture(async()=>({items:[channel,peer('8',channel.title,'direct','other')],next:null,complete}));
  try{await assert.rejects(hub.call('reader','history',{connectionId:'tg',conversationId:'Тестовый канал',readMode:'refresh'}),e=>{assert.equal(e.code,complete?'conversation_ambiguous':'conversation_search_incomplete');assert.equal(diagnostic(e).candidates.length,2);return true;});}finally{await hub.close();}
 }
 const hub=fixture(async()=>({item:channel}),['8']);
 try{await assert.rejects(hub.call('reader','history',{connectionId:'tg',conversationId:'@example_alert_channel',readMode:'refresh'}),{code:'not_authorized'});}finally{await hub.close();}
 for(const error of ['conversation_not_found','conversation_access_denied','telegram_read_provider_failed']){
  const hub=fixture(async()=>({error}));try{await assert.rejects(hub.call('reader','history',{connectionId:'tg',conversationId:'@example_alert_channel',readMode:'refresh'}),{code:error});}finally{await hub.close();}
 }
});

test('exact username wins and restricted title ambiguity never exposes other routes',async()=>{
 // Lookup returns exactly the provider peer; catalog is not consulted on success.
 const hub=fixture(async(name)=>{assert.equal(name,'hub_read_resolve');return {item:channel};});
 try{const r=await hub.instances.get('tg').conversations({query:'example_alert_channel',cursor:null,limit:30});assert.deepEqual(r.items,[channel]);}finally{await hub.close();}
 const scoped=fixture(async()=>({items:[channel,peer('8',channel.title,'direct')],next:null,complete:true}),[channel.id]);
 try{const v=await scoped.instances.get('tg').resolveConversation({address:telegramAddress('Тестовый канал'),allowed:[channel.id]});assert.equal(v.id,channel.id);}finally{await scoped.close();}
});

test('cached alias miss performs no provider call and catalog cursors bind the query/limit',async()=>{
 // Cache-only stays a hard boundary; changed search options cannot reuse a page.
 const hub=fixture(async()=>{throw Error('unexpected provider');});
 try{await assert.rejects(hub.call('reader','history',{connectionId:'tg',conversationId:'@missing_name',readMode:'cached'}),{code:'conversation_not_cached'});
 const cursor=Buffer.from(JSON.stringify({query:'old',limit:100,offset:100})).toString('base64url');
 await assert.rejects(hub.instances.get('tg').conversations({query:'new',limit:100,cursor}),{code:'cursor_invalid'});
 }finally{await hub.close();}
});

test('attachment aliases normalize before provider access and denied aliases cannot download',async()=>{
 // The attachment API must share history's route resolution, rather than pass
 // a username through to a file binding or allow a denied read to hit transport.
 for(const allowed of ['*',['8']]){
  let downloads=0;const hub=fixture(async()=>({item:channel}),allowed);hub.instances.get('tg').capabilities.attachments=true;
  hub.instances.get('tg').attachment=async v=>{downloads++;assert.equal(v.conversationId,channel.id);return {base64:'',mimeType:'image/jpeg',filename:'synthetic.jpg'};};
  try{const read=hub.call('reader','attachment',{connectionId:'tg',conversationId:'https://t.me/example_alert_channel/30',messageId:'30',attachmentId:'message:30'});
   // Attachment has no readMode field: configured cached defaults cannot trigger
   // an implicit lookup. Populate its catalog through explicit discovery first.
   await assert.rejects(read,{code:'conversation_not_cached'});
   await hub.call('reader','conversations',{connectionId:'tg',query:'@example_alert_channel',readMode:'refresh'});
   const next=hub.call('reader','attachment',{connectionId:'tg',conversationId:'@example_alert_channel',messageId:'30',attachmentId:'message:30'});
   if(allowed==='*'){assert.equal((await next).mimeType,'image/jpeg');assert.equal(downloads,1);}else{await assert.rejects(next,{code:'conversation_not_cached'});assert.equal(downloads,0);}
  }finally{await hub.close();}
 }
});

test('a unique observed cached title is not proof of exhaustive title coverage',async()=>{
 // Exact discovery populates one peer, but cannot make its partial cached name
 // index authoritative. A cached title must ask for refresh, not guess uniqueness.
 const hub=fixture(async()=>({item:channel}));
 try{await hub.call('reader','conversations',{connectionId:'tg',query:'@example_alert_channel',readMode:'refresh'});
 await assert.rejects(hub.call('reader','history',{connectionId:'tg',conversationId:channel.title,readMode:'cached'}),e=>e.code==='conversation_search_incomplete'&&e.details.coverage.source==='cache'&&e.details.candidates[0].id===channel.id);
 }finally{await hub.close();}
});
