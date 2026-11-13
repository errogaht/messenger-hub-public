import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diagnostic} from '../src/errors.mjs';
import {HubError} from '../src/contracts.mjs';
import {historyInput} from '../src/presentation.mjs';
import {Hub} from '../src/hub.mjs';
import {Store} from '../src/store.mjs';
import telegram from '../src/plugins/telegram.mjs';

test('history retry guidance is compatible with its published schema and does not require write receipts',()=>{
 // Reads reuse the failed cursor and options; retries do not invent parameters
 // accepted only by preparation/send tools. Write diagnostics stay receipt-bound.
 const d=diagnostic(new HubError('upstream_timeout'),'history');
 assert.equal(d.retryable,true);assert.match(d.nextAction,/identical input and cursor/);assert.match(d.nextAction,/Do not add requestId or retry flags/);
 assert.equal(historyInput.shape.requestId,undefined);assert.equal(historyInput.shape.retry,undefined);
 assert.match(diagnostic(new HubError('upstream_timeout'),'send').nextAction,/never resend/);
});

test('native refresh failure leaves a history cursor replayable, coverage bounds and complete follow source evidence',async()=>{
 // A synthetic source crosses both UTC boundaries of the requested Moscow day.
 // Budget splitting and an injected failure must not consume or skip its rows.
 const dates=['2026-10-24T12:00:00Z','2026-10-23T21:00:00Z','2026-10-23T12:00:00Z','2026-10-22T21:00:00Z','2026-10-22T20:59:59Z'];
 const source=dates.map((at,i)=>({id:String(20-i),conversationId:'100000002',at,direction:'inbound',senderId:'8',text:'synthetic'.repeat(200),attachments:[]}));
 let failNext=false;const seen=[];
 const upstream={close:async()=>{},call:async(name,args)=>{assert.equal(name,'hub_native_history');seen.push(args.offset_id);if(failNext){failNext=false;throw new HubError('upstream_timeout');}const start=args.offset_id?source.findIndex(m=>Number(m.id)===args.offset_id)+1:0,items=source.slice(start,start+args.limit);const next=items.length===args.limit?items.at(-1).id:null;return {items,next,complete:!next};}};
 const hub=new Hub({version:1,store:':memory:',plugins:{telegram:'/unused'},connections:{tg:{plugin:'telegram',label:'TG',settings:{selfId:'4',nativeHistoryConversations:['100000002'],upstreamClient:upstream}}},scopes:{reader:{token:'x'.repeat(40),connections:{tg:{read:true,send:false,conversations:['100000002']}}}}},{telegram},new Store(':memory:'));
 try{
  const options={connectionId:'tg',conversationId:'100000002',readMode:'refresh',transcribeAudio:false,mode:'compact',limit:2,maxResponseChars:2200};
  let r=await hub.call('reader','history',options),ids=[],day=[];
  while(true){
   assert.ok(r.items.length);const expected=source.filter(m=>r.items.some(x=>x.id===m.id));
   assert.equal(r.coverage.newestAt,expected[0].at);assert.equal(r.coverage.oldestAt,expected.at(-1).at);
   ids.push(...r.items.map(m=>m.id));day.push(...r.items.filter(m=>m.at>='2026-10-22T21:00:00Z'&&m.at<'2026-10-23T21:00:00Z').map(m=>m.id));
   if(!r.next){assert.equal(r.complete,true);break;}
   assert.equal(r.complete,false);const cursor=r.next;
   // Fail exactly before a provider page (not a frozen remainder); repeat the
   // same durable cursor without restarting the chain or changing options.
   const state=JSON.parse(hub.readTools.db.prepare('SELECT body FROM history_pages WHERE id=?').get(cursor.slice(3)).body);
   if(!state.page&&state.providerCursor==='nh:19'){
    failNext=true;await assert.rejects(hub.call('reader','history',{...options,cursor}),{code:'upstream_timeout'});
   }
   r=await hub.call('reader','history',{...options,cursor});
  }
  assert.deepEqual(ids,source.map(m=>m.id));assert.deepEqual(day,['18','17']);assert.equal(seen.filter(x=>x===19).length,2);
 }finally{await hub.close();}
});
