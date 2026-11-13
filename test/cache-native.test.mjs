import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHmac} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {Hub} from '../src/hub.mjs';
import {Store} from '../src/store.mjs';
import {createHttp} from '../src/server.mjs';
import {resultChars} from '../src/tool-result.mjs';
const msg=(id,text='synthetic',topicId)=>({id:String(id),conversationId:'chat',direction:'inbound',senderId:'person',isSelf:false,at:`2026-10-02T10:00:${String(Number(id)%60).padStart(2,'0')}Z`,text,attachments:[],...(topicId?{topicId}: {})});
async function fixture(t,{native=false,pluginId='telegram',settleMs=6000}={}){
 const root=await mkdtemp(path.join(tmpdir(),'hub-cache-'));let reads=0,catalogReads=0,sends=0,offline=false,rows=[msg(1),msg(2,'other','7')];const secret='synthetic-webhook-secret-000000000000';const secretFile=path.join(root,'hook-secret');await writeFile(secretFile,secret,{mode:0o600});
 const config={version:1,store:path.join(root,'store'),plugins:{[pluginId]:'/unused'},connections:{account:{plugin:pluginId,label:'fake',settings:{}}},inbox:{enabled:false,push:{enabled:native}},native:{enabled:native,bindings:[{connectionId:'account',scope:'owner',transport:pluginId==='telegram'?'telegram_native':'gowa_webhook',secretFile,deviceId:'device'}]},scopes:{owner:{token:'a'.repeat(40),inbox:{read:true,manage:true,push:native,nativeIngest:native},connections:{account:{read:true,send:true,conversations:['chat']}}},other:{token:'b'.repeat(40),inbox:{read:true,manage:true},connections:{account:{read:true,send:false,conversations:['different']}}}}};
 const plugin={create:()=>({capabilities:{history:true,send:true,attachments:false,changes:false,kinds:['message']},history:async()=>{reads++;if(offline)throw new Error('offline');return {items:rows,next:null,complete:true};},message:async v=>{reads++;if(offline)throw new Error('offline');return rows.find(m=>m.id===v.messageId);},conversations:async()=>{catalogReads++;if(offline)throw new Error('offline');return {items:[{id:'chat',title:'Synthetic',kind:'group',canSend:true},{id:'different',title:'Hidden',kind:'group',canSend:true}],next:null};},topics:async()=>({items:[{id:'7',title:'Topic',canSend:true}],next:null}),send:async()=>{sends++;return {status:'unknown',messageId:null};}})};
 let hub=new Hub(config,{[pluginId]:plugin},new Store(config.store));const call=(m,v={})=>hub.call('owner',m,v);t.after(async()=>{await hub.close();await rm(root,{recursive:true,force:true});});
 return {root,secret,config,call,get hub(){return hub;},stats:()=>({reads,catalogReads,sends}),setRows:v=>rows=v,offline:()=>offline=true,restart:async()=>{await hub.close();hub=new Hub(config,{[pluginId]:plugin},new Store(config.store));},sub:async()=>{await call('subscription_save',{subscriptionId:'selected',revision:0,connectionId:'account',conversationId:'chat',enabled:true,settleMs,autoAudio:false});await call('inbox_consumer_ensure',{consumerId:'ui',subscriptionIds:['selected']});}};
}
const route={connectionId:'account',conversationId:'chat'};

test('cache default never calls provider, explicit refresh seeds full history and offline restart works',async t=>{
 // UI navigation and agent questions must work from retained bodies, even without provider connectivity.
 const f=await fixture(t);const empty=await f.call('history',route);assert.deepEqual(empty.items,[]);assert.equal(empty.cache.providerContacted,false);await assert.rejects(f.call('message_get',{...route,messageId:'1'}),/not_cached/);assert.equal(f.stats().reads,0);
 await f.call('history',{...route,readMode:'refresh'});assert.equal(f.stats().reads,1);f.offline();await f.restart();const cached=await f.call('history',route);assert.equal(cached.items.length,2);assert.equal(cached.cache.coverage,'provider_reported_complete_at_refresh');assert.equal((await f.call('message_get',{...route,messageId:'1'})).message.text,'synthetic');assert.equal((await f.call('message_context',{...route,messageId:'1'})).coverage,'observed_cache_only');assert.equal(f.stats().reads,1);assert.equal((await f.call('search_messages',{...route,query:'SYNTHETIC'})).items[0].id,'1');assert.equal(f.stats().reads,1);
 await assert.rejects(f.hub.call('other','history',route),/not_authorized/);await assert.rejects(f.call('history',{...route,readMode:'refresh'}),/offline/);
});

test('cached pages freeze source revisions and route/topic/options across new arrivals and edits',async t=>{
 // A moving history cannot insert a duplicate into the next page or rewrite its frozen source.
 const f=await fixture(t);f.setRows([msg(1,'old'),msg(2,'two','7'),msg(3,'three','7')]);await f.call('history',{...route,readMode:'refresh'});
 const first=await f.call('history',{...route,limit:1});f.setRows([msg(1,'EDITED'),msg(4)]);await f.call('history',{...route,readMode:'refresh'});await f.restart();let next=first.next,all=[...first.items];while(next){const r=await f.call('history',{...route,limit:1,cursor:next});all.push(...r.items);next=r.next;}assert.equal(all.length,3);assert.equal(all.find(m=>m.id==='1').text,'old');assert.equal((await f.call('message_get',{...route,messageId:'1'})).message.text,'EDITED');assert.equal((await f.call('history',{...route,topicId:'7'})).items.length,2);
 await assert.rejects(f.call('history',{...route,limit:2,cursor:first.next}),/cursor_invalid/);assert.equal((await f.call('history',{...route,mode:'compact',maxResponseChars:2000})).cache.providerContacted,false);
});

test('catalog is scoped, paginated and offline cached; topics use exact separate identities',async t=>{
 // A saved catalog cannot leak another granted account/chat after permissions change.
 const f=await fixture(t);assert.equal((await f.call('conversations',{connectionId:'account'})).items.length,0);assert.equal(f.stats().catalogReads,0);
 assert.deepEqual((await f.call('conversations',{connectionId:'account',readMode:'refresh'})).items.map(x=>x.id),['chat']);await f.call('topics',{...route,readMode:'refresh'});f.offline();await f.restart();assert.equal((await f.call('topics',route)).items[0].id,'7');assert.equal((await f.call('conversations',{connectionId:'account',query:'synthetic'})).items[0].canSend,true);const other=await f.hub.call('other','conversations',{connectionId:'account'});assert.deepEqual(other.items.map(x=>x.id),['different']);assert.equal(other.items[0].canSend,false);
});

test('native raw arrival commits immediately, settles only claim, dedups after restart and exposes measured latency',async t=>{
 // The UI sees raw arrival while triage still waits for a burst; no provider read is involved.
 const f=await fixture(t,{native:true});await f.sub();const input={providerEventId:'event1',message:msg(1)};let woke=false;f.hub.inbox.changes.once('observed',()=>woke=true);const receipt=f.hub.native.accept('owner','account',input);await new Promise(r=>setImmediate(r));assert.equal(woke,true);assert.equal(receipt.status,'committed');assert.ok(receipt.commitLatencyMs>=0);assert.equal((await f.call('inbox_replay',{consumerId:'ui'})).items.length,1);assert.equal((await f.call('inbox_claim',{consumerId:'ui'})).status,'empty');assert.equal((await f.call('history',route)).items[0].id,'1');assert.equal(f.stats().reads,0);
 await f.restart();assert.equal(f.hub.native.accept('owner','account',input).duplicate,true);assert.equal((await f.call('inbox_replay',{consumerId:'ui'})).items.length,1);assert.equal((await f.call('subscription_status',{subscriptionId:'selected'})).transportMode,'telegram_native');await assert.rejects(async()=>f.hub.native.accept('owner','account',{...input,message:msg(1,'different')}),/conflict/);await assert.rejects(async()=>f.hub.native.accept('other','account',input),/authorized/);
});

test('GOWA HMAC/device/route checks happen before cache/journal publication',async t=>{
 // Signed native messages do not give authority over unselected conversations or another device.
 const f=await fixture(t,{native:true,pluginId:'whatsapp'});await f.sub();const raw=Buffer.from(JSON.stringify({event:'message',device_id:'device',payload:{id:'wa1',chat_id:'chat',from:'sender',is_from_me:false,timestamp:'2026-10-02T10:00:00Z',body:'emoji 🙂'}}));const signature='sha256='+createHmac('sha256',f.secret).update(raw).digest('hex');assert.throws(()=>f.hub.native.webhook('account',raw,'sha256='+'0'.repeat(64)),/signature_invalid/);assert.equal(f.hub.native.webhook('account',raw,signature).status,'committed');assert.equal((await f.call('message_get',{...route,messageId:'wa1'})).message.text,'emoji 🙂');assert.equal(f.hub.native.webhook('account',raw,signature).duplicate,true);
});

test('versioned local API publishes schemas and composer uses one stable request without resending unknown',async t=>{
 // Native desktop uses ordinary HTTP, exact unchanged emoji text, and its durable client request ID.
 const f=await fixture(t),server=createHttp(f.hub);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeInboxStreams();await new Promise(r=>server.close(r));});const base=`http://127.0.0.1:${server.address().port}`,headers={Authorization:'Bearer '+'a'.repeat(40),'Content-Type':'application/json'};
 const schema=await (await fetch(base+'/api/v1/schema',{headers})).json();assert.equal(schema.httpContractVersion,1);assert.ok(schema.tools.some(t=>t.name==='messenger_topics'));const send={method:'send_raw',input:{...route,requestId:'client-stable1',text:'Exact 🙂'}};for(let i=0;i<2;i++){const r=await fetch(base+'/api/v1/call',{method:'POST',headers,body:JSON.stringify(send)});assert.equal((await r.json()).result.status,'unknown');}assert.equal(f.stats().sends,1);
 const denied=await fetch(base+'/api/v1/call',{method:'POST',headers,body:JSON.stringify({method:'contact_send',input:{}})});assert.equal(denied.status,400);assert.equal((await denied.json()).error,'api_method_not_allowed');assert.equal((await fetch(base+'/api/v1/schema')).status,401);
});

test('bounded cached context keeps full source and unacknowledged backlog without retention deletion',async t=>{
 // Compact context is a presentation view only; retained original speech/text remains exact.
 const f=await fixture(t,{native:true,settleMs:0});await f.sub();for(let i=1;i<=12;i++)f.hub.native.accept('owner','account',{providerEventId:'event'+i,message:msg(i,'long '.repeat(10000))});const context=await f.call('message_context',{...route,messageId:'6',maxResponseChars:2000});assert.ok(resultChars(context)<=2000);await f.restart();assert.equal((await f.call('message_get',{...route,messageId:'6'})).message.text.length,50000);assert.equal((await f.call('inbox_diagnostics',{consumerId:'ui'})).pendingEvents,12);
});

test('Telegram exact topic composer verifies native root and sends unchanged emoji through existing bridge',async t=>{
 // A topic title never establishes identity; raw text is routed by verified numeric forum root.
 const {default:telegram}=await import('../src/plugins/telegram.mjs');let sent=false,writes=0;
 const upstreamClient={call:async(name,args)=>{if(name==='list_topics'){assert.equal(Object.hasOwn(args,'search_query'),false);return [{id:7,title:'Synthetic topic',closed:false}];}if(name==='hub_topic_history')return {items:sent?[{...msg(12,'Exact 🙂','7'),direction:'outbound',senderId:'owner',replyTo:'7'}]:[],next:null,complete:true};if(name==='reply_to_message'){assert.equal(args.message_id,7);assert.equal(args.text,'Exact 🙂');sent=true;writes++;return 'sent';}throw new Error('unexpected '+name);}};
 const adapter=telegram.create({selfId:'owner',upstreamClient});const result=await adapter.send({...route,conversationId:'-100123',topicId:'7',text:'Exact 🙂',replyTo:null});assert.equal(result.status,'sent');assert.equal(result.messageId,'12');assert.equal(writes,1);
 await assert.rejects(adapter.send({...route,conversationId:'-100123',topicId:'99',text:'never sent',replyTo:null}),/topic_not_available/);assert.equal(writes,1);
});

test('read-only email export preserves MIME attachment and denies symlink escape without auth or SMTP',async t=>{
 // A local exported message is a supported source, not evidence of a live IMAP connection.
 const {default:email}=await import('../src/plugins/email.mjs');const {symlink}=await import('node:fs/promises');const f=await fixture(t),mailRoot=path.join(f.root,'mail');const {mkdir}=await import('node:fs/promises');await mkdir(mailRoot);
 await writeFile(path.join(mailRoot,'one.eml'),'From: sender@example.invalid\nTo: owner@example.invalid\nSubject: Synthetic\nDate: Fri, 02 Oct 2026 10:00:00 +0000\nMessage-ID: <synthetic@example.invalid>\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="BOUND"\n\n--BOUND\nContent-Type: text/plain; charset=utf-8\n\nExact email body\n--BOUND\nContent-Type: application/octet-stream\nContent-Disposition: attachment; filename="fixture.txt"\nContent-Transfer-Encoding: base64\n\naGVsbG8=\n--BOUND--\n');
 const adapter=email.create({mailboxes:{mail:{root:mailRoot,label:'Synthetic'}}}),page=await adapter.history({conversationId:'mail',cursor:null,limit:50});assert.equal(page.items[0].email.subject,'Synthetic');assert.match(page.items[0].text,/Exact email body/);const attachment=await adapter.attachment({conversationId:'mail',messageId:page.items[0].id,attachmentId:page.items[0].attachments[0].id});assert.equal(Buffer.from(attachment.base64,'base64').toString(),'hello');assert.equal(adapter.capabilities.send,false);
 await writeFile(path.join(f.root,'outside.eml'),'outside');await symlink(path.join(f.root,'outside.eml'),path.join(mailRoot,'escape.eml'));await assert.rejects(adapter.history({conversationId:'mail',cursor:null,limit:50}),/path_denied/);
});

test('native collector fans out only to explicitly configured read-only consumer scope',async t=>{
 // Clerk receives events without holding the trusted provider-ingest credential or a send grant.
 const f=await fixture(t,{native:true,settleMs:0});f.config.scopes.reader={token:'r'.repeat(40),inbox:{read:true,manage:true},connections:{account:{read:true,send:false,conversations:['chat']}}};f.config.native.bindings[0].subscriberScopes=['reader'];await f.restart();await f.hub.call('reader','subscription_save',{subscriptionId:'reader-sub',revision:0,connectionId:'account',conversationId:'chat',enabled:true,settleMs:0,autoAudio:false});await f.hub.call('reader','inbox_consumer_ensure',{consumerId:'read-only',subscriptionIds:['reader-sub']});f.hub.config.scopes.reader.inbox.manage=false;
 f.hub.native.accept('owner','account',{providerEventId:'fanout',message:msg(1)});const b=await f.hub.call('reader','inbox_claim',{consumerId:'read-only'});assert.equal(b.items[0].source.messageId,'1');assert.equal(f.hub.native.describe('reader','account').mode,'telegram_native');assert.throws(()=>f.hub.native.accept('reader','account',{providerEventId:'forged',message:msg(2)}),/not_authorized/);await assert.rejects(f.hub.call('reader','send_raw',{...route,requestId:'not-allowed',text:'never sent'}),/not_authorized/);
});

test('topic coverage never claims that the whole conversation is complete',async t=>{
 // A complete General refresh is evidence for that exact topic, not other threads.
 const f=await fixture(t);f.setRows([msg(2,'General','7')]);await f.call('history',{...route,topicId:'7',readMode:'refresh'});
 assert.equal((await f.call('history',{...route,topicId:'7'})).cache.coverage,'provider_reported_complete_at_refresh');
 assert.equal((await f.call('history',route)).cache.coverage,'observed_subset');
 assert.equal((await f.call('history',{...route,topicId:'9'})).cache.cachedMessages,0);
});

test('read-only channel grants permit Clerk derived subscription/consumer identities without send or native ingest',async t=>{
 // Local queue management is allowed only inside exact routes; arbitrary names do not expand grants.
 const f=await fixture(t);f.config.scopes.reader={token:'r'.repeat(40),inbox:{read:true,manage:true,push:true,nativeIngest:false},connections:{account:{read:true,send:false,conversations:['chat']}}};await f.restart();
 await f.hub.call('reader','subscription_save',{subscriptionId:'clerk-sub-channel-main',revision:0,connectionId:'account',conversationId:'chat',enabled:true,autoAudio:false});
 const c=await f.hub.call('reader','inbox_consumer_ensure',{consumerId:'clerk-reader-channel-main',subscriptionIds:['clerk-sub-channel-main']});assert.equal(c.consumerId,'clerk-reader-channel-main');
 await assert.rejects(f.hub.call('reader','subscription_save',{subscriptionId:'unselected',revision:0,connectionId:'account',conversationId:'other',autoAudio:false}),/not_authorized/);await assert.rejects(f.hub.call('reader','send_raw',{...route,requestId:'never-sent',text:'never sent'}),/not_authorized/);assert.equal(f.stats().sends,0);
});

test('a recovery poll finishing later cannot erase a newer native receipt diagnostic',async t=>{
 // Provider snapshots and native callbacks overlap; retain the latest native proof timestamps.
 const f=await fixture(t,{native:true});await f.sub();const stale=f.hub.inbox.sub('owner','selected');f.hub.native.accept('owner','account',{providerEventId:'live-proof',producer:{captureKind:'live_create',capturedAt:new Date().toISOString()},message:msg(1)});f.hub.inbox.saveSub(stale);const status=f.hub.inbox.sub('owner','selected');assert.equal(status.lastProviderEventId,'live-proof');assert.ok(status.lastProducerCapturedAt);assert.ok(status.lastNativeAt);
});
