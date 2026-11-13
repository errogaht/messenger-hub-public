import {createHttp} from '../src/server.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,copyFile,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Hub} from '../src/hub.mjs';
import {Store} from '../src/store.mjs';
import {createMcp} from '../src/mcp.mjs';
import {resultChars} from '../src/tool-result.mjs';
import {PalatineASR} from '../src/palatine.mjs';

const msg=(id,text='message',extra={})=>({id,conversationId:'one',direction:'inbound',senderId:'customer',at:`2026-09-30T12:00:${String(Number(id)%60).padStart(2,'0')}Z`,text,attachments:[],...extra});
const sub={subscriptionId:'client',revision:0,connectionId:'tg',conversationId:'one',enabled:true,settleMs:0,autoAudio:false};
async function fixture(t,{rows=[msg('1')],media=false,history,now,asr,denied=false}={}){
 const root=await mkdtemp(path.join(tmpdir(),'hub-inbox-'));let current=rows,reads=0,legacy=0,palatine=0,downloads=0;let clock=100000;
 const grant={read:true,send:false,conversations:['one']};
 const config={version:1,cache:{defaultRead:'refresh'},store:path.join(root,'hub.sqlite'),inbox:{enabled:true,pagesPerTick:1,pageSize:2,overlapPages:2,tickMs:100},plugins:{fake:'/unused'},connections:{tg:{plugin:'fake',label:'TG',settings:{}}},scopes:{clerk:{token:'a'.repeat(40),inbox:{read:true,manage:true},connections:{tg:grant}},other:{token:'b'.repeat(40),inbox:{read:true,manage:true},connections:{tg:{...grant,conversations:['two']}}},plain:{token:'c'.repeat(40),connections:{tg:grant}}},...(media?{media:{root:path.join(root,'media'),keyFile:'/unused',palatine:{keyFile:'/unused'},historyWaitMs:0}}:{})};
 const plugin={create:()=>({capabilities:{history:true,send:false,attachments:media,changes:false,kinds:['message','call']},conversations:async()=>({items:[],next:null}),history:async v=>{reads++;if(denied)throw new Error('sensitive upstream error');if(history)return history(v);const offset=Number(v.cursor??0),items=current.slice(offset,offset+v.limit);return {items,next:offset+items.length<current.length?String(offset+items.length):null,complete:offset+items.length>=current.length};},...(media?{attachment:async()=>{downloads++;return {base64:Buffer.from('audio bytes').toString('base64'),filename:'voice.ogg',mimeType:'audio/ogg'};}}:{})})};
 const dependencies={inbox:{now:now??(()=>clock)},media:{palatine:{transcribe:async()=>{palatine++;return asr?asr():'Palatine voice text';}},asr:{transcribe:async()=>{legacy++;return 'LEGACY';}},probe:async()=>({hasAudio:true,duration:1}),extract:copyFile}};
 let hub=new Hub(config,{fake:plugin},new Store(config.store),dependencies);
 t.after(async()=>{await hub.close();await rm(root,{recursive:true,force:true});});
 return {config,plugin,dependencies,get hub(){return hub;},advance:ms=>clock+=ms,setRows:r=>current=r,stats:()=>({reads,legacy,palatine,downloads}),tick:()=>hub.inbox.tick(),restart:async()=>{await hub.close();hub=new Hub(config,{fake:plugin},new Store(config.store),dependencies);}};
}
async function consumer(f,id='clerk1'){return f.hub.call('clerk','inbox_consumer_ensure',{consumerId:id,subscriptionIds:['client']});}
const claim=(f,id='clerk1',extra={})=>f.hub.call('clerk','inbox_claim',{consumerId:id,...extra});
const ack=(f,b)=>f.hub.call('clerk','inbox_ack',{consumerId:b.consumerId,batchId:b.batchId,leaseToken:b.leaseToken});

test('background collection persists while consumers are absent; restart/replay/edit versions and independent ack',async t=>{
 // No history MCP call or clerk process is needed for collection; restart cannot lose saved evidence.
 const f=await fixture(t);await f.hub.call('clerk','subscription_save',sub);await f.tick();await f.restart();
 await consumer(f);await consumer(f,'second');const a=await claim(f),b=await claim(f,'second');assert.equal(a.items.length,1);assert.equal(a.items[0].version,1);assert.equal(a.items[0].source.messageId,'1');assert.equal(a.items[0].eventId,b.items[0].eventId);
 assert.deepEqual(await claim(f),a);await ack(f,a);assert.deepEqual(await ack(f,a),{status:'acknowledged',batchId:a.batchId,offset:a.to});assert.equal((await claim(f)).status,'empty');assert.deepEqual(await claim(f,'second'),b);
 f.advance(11000);await f.tick();assert.equal((await claim(f)).status,'empty');
 f.setRows([msg('1','edited',{editedAt:'2026-09-30T12:05:00Z'})]);f.advance(11000);await f.tick();const edit=await claim(f);assert.equal(edit.items[0].kind,'message_updated');assert.equal(edit.items[0].version,2);assert.equal((await f.hub.call('clerk','inbox_event_get',{consumerId:'clerk1',eventId:a.items[0].eventId})).message.text,'message');assert.equal(f.stats().legacy,0);
});

test('lease expiration redelivers the same batch, rejects stale receipts, survives restart',async t=>{
 // A clerk crashed after saving Markdown but before ack. It must dedup the same event under a new lease.
 const f=await fixture(t);await f.hub.call('clerk','subscription_save',sub);await f.tick();await consumer(f);const a=await claim(f,'clerk1',{leaseMs:1000});await f.restart();f.advance(1001);const b=await claim(f);assert.equal(a.batchId,b.batchId);assert.deepEqual(a.items,b.items);assert.notEqual(a.leaseToken,b.leaseToken);await assert.rejects(ack(f,a),/receipt_invalid/);await ack(f,b);
});

test('page checkpoint is durable, full available backfill resumes after restart without duplicate events',async t=>{
 // One page per tick is deliberate: a restart between pages resumes the saved provider cursor.
 const f=await fixture(t,{rows:[5,4,3,2,1].map(x=>msg(String(x)))});await f.hub.call('clerk','subscription_save',sub);await f.tick();assert.equal((await f.hub.call('clerk','subscription_status',{subscriptionId:'client'})).status,'catching_up');await f.restart();await f.tick();await f.tick();await consumer(f);const b=await claim(f);assert.equal(b.items.length,5);assert.equal(new Set(b.items.map(x=>x.eventId)).size,5);assert.equal((await f.hub.call('clerk','subscription_status',{subscriptionId:'client'})).coverage.complete,true);
});

test('from_now retains historical journal events; consumer policy and tombstones remain explicit',async t=>{
 // Legacy from_now now retains sources; filtering belongs to the consumer, never ingest.
 const f=await fixture(t);await f.hub.call('clerk','subscription_save',{...sub,initialHistory:'from_now'});await f.tick();await consumer(f);const initial=await claim(f);assert.equal(initial.items.length,1);await ack(f,initial);f.setRows([msg('2'),msg('1')]);f.advance(11000);await f.tick();const a=await claim(f);assert.equal(a.items.length,1);assert.equal(a.items[0].source.messageId,'2');await ack(f,a);
 f.setRows([msg('2',null,{deletedAt:'2026-09-30T12:06:00Z'}),msg('1')]);f.advance(11000);await f.tick();assert.equal((await claim(f)).items[0].kind,'message_deleted');
});

test('missing overlap exposes history_gap; absence is never manufactured into deletion',async t=>{
 // Provider retention removed the known anchor. Current messages are retained, but completeness is not claimed.
 const f=await fixture(t);await f.hub.call('clerk','subscription_save',sub);await f.tick();f.setRows([msg('3')]);f.advance(11000);await f.tick();const s=await f.hub.call('clerk','subscription_status',{subscriptionId:'client'});assert.equal(s.status,'history_gap');assert.equal(s.coverage.gap,true);await consumer(f);assert.deepEqual((await claim(f)).items.map(x=>x.kind),['message_created','message_created']);
 await f.hub.call('clerk','subscription_save',{...sub,revision:1,acknowledgeGap:true});f.advance(11000);await f.tick();assert.equal((await f.hub.call('clerk','subscription_status',{subscriptionId:'client'})).coverage.gap,false);
});

test('scope, route, CAS and immutable subscription/consumer identities fail before provider access',async t=>{
 // A clerk sees only its exact routes and receives no send tools or access to another scope's saved bodies.
 const f=await fixture(t);await assert.rejects(f.hub.call('other','subscription_save',sub),/not_authorized/);await assert.rejects(f.hub.call('plain','subscription_save',sub),/not_authorized/);assert.equal(f.stats().reads,0);
 await f.hub.call('clerk','subscription_save',sub);await assert.rejects(f.hub.call('clerk','subscription_save',sub),/revision_conflict/);await f.tick();await consumer(f);const b=await claim(f);
 await assert.rejects(f.hub.call('other','inbox_event_get',{consumerId:'clerk1',eventId:b.items[0].eventId}),/consumer_not_found/);
 await assert.rejects(f.hub.call('clerk','inbox_consumer_ensure',{consumerId:'clerk1',subscriptionIds:['client'],start:'now'}),/immutable/);
 createMcp(f.hub,'clerk');const tools=f.hub.schemaInfo.get('clerk').tools.map(x=>x.name);assert.ok(tools.includes('messenger_inbox_ack'));assert.ok(!tools.includes('messenger_send_raw'));
 f.hub.config.scopes.clerk.connections.tg.read=false;await assert.rejects(claim(f),/not_authorized/);f.advance(11000);await f.tick();assert.equal(f.stats().reads,1);
});

test('settling coalesces a burst; whole serialized response is bounded and full immutable evidence is retrievable',async t=>{
 // Large transcripts/text cannot make the queue silently skip events or exceed the declared response budget.
 const f=await fixture(t,{rows:[msg('1','x'.repeat(10000)),msg('2','y'.repeat(10000),{replyTo:'1'})]});await f.hub.call('clerk','subscription_save',{...sub,settleMs:5000});await f.tick();await consumer(f);assert.equal((await claim(f)).status,'empty');f.advance(5001);const b=await claim(f,'clerk1',{maxResponseChars:2500});assert.ok(resultChars(b)<=2500);assert.ok(b.items.length>=1);const e=await f.hub.call('clerk','inbox_event_get',{consumerId:'clerk1',eventId:b.items[0].eventId});assert.equal(e.message.text.length,10000);await ack(f,b);const next=await claim(f,'clerk1',{maxResponseChars:2500});assert.equal(next.items.length,1);
});

test('provider failure is safe, pause retains evidence, disabled worker starts no background reads',async t=>{
 // The raw error contains private text; public diagnostics contain only a generated category.
 const f=await fixture(t,{denied:true});await f.hub.call('clerk','subscription_save',sub);await f.tick();const s=await f.hub.call('clerk','subscription_status',{subscriptionId:'client'});assert.equal(s.status,'provider_error');assert.ok(!JSON.stringify(s).includes('sensitive'));await f.hub.call('clerk','subscription_save',{...sub,revision:1,enabled:false});f.advance(11000);await f.tick();assert.equal(f.stats().reads,1);
 f.hub.inbox.config.enabled=false;f.hub.inbox.start();assert.equal(f.hub.inbox.timer,undefined);
});

test('late Palatine transcription emits media_ready without editing the source version or using legacy ASR',async t=>{
 // A voice finishes after the initial message was acknowledged. It must return as a separate source-linked supplement.
 let release;const ready=new Promise(r=>release=r);const f=await fixture(t,{media:true,asr:()=>ready,rows:[msg('1',null,{attachments:[{id:'voice',kind:'audio',mimeType:'audio/ogg',filename:'voice.ogg',size:11}]})]});await f.hub.call('clerk','subscription_save',{...sub,autoAudio:true});await f.tick();await consumer(f);const initial=await claim(f);assert.equal(initial.items[0].kind,'message_created');await ack(f,initial);
 release('A new voice');await Promise.all(f.hub.media.jobs.values());await new Promise(r=>setImmediate(r));const b=await claim(f);assert.equal(b.items[0].kind,'media_ready');assert.equal(b.items[0].version,1);assert.equal(b.items[0].message.attachments[0].transcription.source,'palatine');assert.equal(b.items[0].message.attachments[0].transcription.text,'A new voice');const file=await f.hub.call('clerk','file_download',{fileId:b.items[0].fileId});assert.equal(file.transcription.text,'A new voice');assert.equal(f.stats().legacy,0);assert.equal(f.stats().palatine,1);assert.equal(f.stats().downloads,1);
 f.advance(11000);await f.tick();await ack(f,b);assert.equal((await claim(f)).status,'empty');
});

test('subscription audio refuses missing Palatine and separates its cache from legacy results',async t=>{
 // Ordinary history and subscriptions share Palatine results; neither invokes legacy ASR.
 const no=await fixture(t);await assert.rejects(no.hub.call('clerk','subscription_save',{...sub,autoAudio:true}),/asr_not_configured/);
 const f=await fixture(t,{media:true,rows:[msg('1',null,{attachments:[{id:'voice',kind:'audio',mimeType:'audio/ogg'}]})]});await f.hub.call('clerk','history',{connectionId:'tg',conversationId:'one'});await Promise.all(f.hub.media.jobs.values());assert.equal(f.stats().legacy,0);await f.hub.call('clerk','subscription_save',{...sub,autoAudio:true});await f.tick();await Promise.all(f.hub.media.jobs.values());assert.equal(f.stats().palatine,1);assert.equal(f.stats().legacy,0);
});

test('two worker instances cannot poll the same subscription simultaneously',async t=>{
 // A second service instance shares the DB; a live lock cannot be stolen on elapsed time.
 let release;const gate=new Promise(r=>release=r);const f=await fixture(t,{history:async()=>{await gate;return {items:[msg('1')],complete:true,next:null};}});await f.hub.call('clerk','subscription_save',sub);const a=f.tick();const other=new Hub(f.config,{fake:f.plugin},new Store(f.config.store),f.dependencies);await other.inbox.tick();assert.equal(f.stats().reads,1);release();await a;await other.close();await consumer(f);assert.equal((await claim(f)).items.length,1);
});

test('Palatine adapter sends configured model only once, validates key permissions and exposes no raw error',async t=>{
 // A timeout has unknown billing outcome; no automated fallback or retry is allowed.
 const root=await mkdtemp(path.join(tmpdir(),'palatine-'));t.after(()=>rm(root,{recursive:true,force:true}));const keyFile=path.join(root,'key'),file=path.join(root,'a.mp3');await writeFile(keyFile,'PRIVATE',{mode:0o600});await writeFile(file,'audio');let calls=0;
 const p=new PalatineASR({keyFile,model:'configured-asr',responseFormat:'json'},1000,async(url,options)=>{calls++;assert.equal(url,'https://api.palatine.ru/api/v1/audio/transcriptions');assert.equal(options.body.get('model'),'configured-asr');assert.equal(options.body.get('response_format'),'json');assert.equal(options.redirect,'error');return new Response(JSON.stringify({text:'hello'}));});assert.equal(await p.transcribe(file),'hello');assert.equal(calls,1);
 const fail=new PalatineASR({keyFile},1000,async()=>{calls++;throw new Error('SECRET timeout');});await assert.rejects(fail.transcribe(file),/palatine_unavailable/);assert.equal(calls,2);await chmod(keyFile,0o644);await assert.rejects(p.transcribe(file),/asr_key_permissions/);assert.equal(calls,2);
});

test('failed audio is a late actionable event, never retried automatically or through a legacy retry',async t=>{
 // The original file remains available even when Palatine fails. Explicit retries keep the pinned ASR purpose.
 const f=await fixture(t,{media:true,asr:()=>{throw new Error('provider secret');},rows:[msg('1',null,{attachments:[{id:'voice',kind:'audio',mimeType:'audio/ogg'}]})]});await f.hub.call('clerk','subscription_save',{...sub,autoAudio:true});await f.tick();await Promise.all(f.hub.media.jobs.values());await new Promise(r=>setImmediate(r));await consumer(f);const b=await claim(f),failure=b.items.find(x=>x.kind==='media_failed');assert.ok(failure);assert.equal(failure.message.attachments[0].transcription.source,'palatine');assert.ok(!JSON.stringify(failure).includes('provider secret'));f.advance(11000);await f.tick();assert.equal(f.stats().palatine,1);
 await f.hub.call('clerk','transcribe_media',{fileId:failure.fileId,retry:true,waitMs:1000});assert.equal(f.stats().palatine,2);assert.equal(f.stats().legacy,0);
});

test('service timer collects incoming while every consumer is offline',async t=>{
 // Exercise the real timer rather than relying solely on manual test ticks.
 const f=await fixture(t,{now:Date.now});await f.hub.call('clerk','subscription_save',sub);f.hub.inbox.start();for(let i=0;i<30&&f.stats().reads===0;i++)await new Promise(r=>setTimeout(r,10));await f.hub.inbox.stop();await consumer(f);assert.equal((await claim(f)).items.length,1);assert.ok(f.stats().reads>0);
});

test('concurrent claims from two consumers/services retain one receipt per consumer',async t=>{
 // Both callers race for the same consumer; only one batch may advance its cursor.
 const f=await fixture(t);await f.hub.call('clerk','subscription_save',sub);await f.tick();await consumer(f);const other=new Hub(f.config,{fake:f.plugin},new Store(f.config.store),f.dependencies);const [a,b]=await Promise.all([claim(f),other.call('clerk','inbox_claim',{consumerId:'clerk1'})]);assert.equal(a.batchId,b.batchId);await ack(f,a);assert.equal((await other.call('clerk','inbox_claim',{consumerId:'clerk1'})).status,'empty');await other.close();
});

test('periodic full rescan finds old edits outside the overlap without manufacturing deletions',async t=>{
 // Head polling is fast; a separately configured full rescan revisits older source versions.
 const rows=[6,5,4,3,2,1].map(x=>msg(String(x)));const f=await fixture(t,{rows});await f.hub.call('clerk','subscription_save',{...sub,fullRescanMs:60000});for(let i=0;i<3;i++)await f.tick();await consumer(f);await ack(f,await claim(f));
 f.setRows([...rows.slice(0,5),msg('1','old edited',{editedAt:'2026-09-30T13:00:00Z'})]);f.advance(11000);await f.tick();await f.tick();assert.equal((await claim(f)).status,'empty');f.advance(60001);for(let i=0;i<3;i++)await f.tick();const b=await claim(f);assert.equal(b.items.length,1);assert.equal(b.items[0].kind,'message_updated');assert.equal(b.items[0].source.messageId,'1');assert.equal(b.items[0].version,2);
});

test('interrupted Palatine request after restart is reported and requires an explicit retry',async t=>{
 // Simulate a killed process journal after the billable call started; do not auto-resubmit it.
 const f=await fixture(t,{media:true,rows:[msg('1',null,{attachments:[{id:'voice',kind:'audio',mimeType:'audio/ogg'}]})]});await f.hub.call('clerk','subscription_save',{...sub,autoAudio:true});await f.tick();await Promise.all(f.hub.media.jobs.values());await new Promise(r=>setImmediate(r));await consumer(f);await ack(f,await claim(f));
 const file=JSON.parse(f.hub.media.db.prepare('SELECT body FROM files LIMIT 1').get().body);f.hub.media.save({...file,transcription:{status:'running',source:'palatine',text:null,phase:'transcribe'}});await f.restart();await new Promise(r=>setImmediate(r));f.advance(11000);await f.tick();const b=await claim(f);assert.equal(b.items[0].kind,'media_failed');assert.equal(b.items[0].message.attachments[0].transcription.status,'interrupted');assert.equal(f.stats().palatine,1);
});

test('calls use original recording IDs and Palatine; video never starts automatically',async t=>{
 // An unverified archive transcript cannot masquerade as this pipeline's speech recognition.
 const f=await fixture(t,{media:true,rows:[msg('1','ARCHIVE TEXT',{kind:'call',attachments:[{id:'recording',kind:'audio',mimeType:'audio/mp4'}]}),msg('2',null,{attachments:[{id:'video',kind:'video',mimeType:'video/mp4'}]})]});await f.hub.call('clerk','subscription_save',{...sub,autoAudio:true});await f.tick();await Promise.all(f.hub.media.jobs.values());await new Promise(r=>setImmediate(r));await consumer(f);const b=await claim(f);const call=b.items.find(x=>x.kind==='message_created'&&x.message.kind==='call');assert.equal(call.message.text,null);assert.notEqual(call.message.attachments[0].transcription.source,'archive');assert.equal(f.stats().palatine,1);assert.equal(f.stats().downloads,1);assert.equal(f.stats().legacy,0);
});

test('public HTTP MCP supports fake collection, full evidence, bounded lease and durable ack',async t=>{
 // Acceptance uses the published schemas and HTTP facade, without DB writes or provider sends.
 const f=await fixture(t),server=createHttp(f.hub);await new Promise(r=>server.listen(0,'127.0.0.1',r));const c=new Client({name:'fake-clerk',version:'1'});await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+'a'.repeat(40)}}}));
 try{const call=async(name,args)=>{const r=await c.callTool({name:'messenger_'+name,arguments:args});assert.ok(!r.isError);return r.structuredContent;};await call('subscription_save',sub);await f.tick();await call('inbox_consumer_ensure',{consumerId:'http',subscriptionIds:['client']});const b=await call('inbox_claim',{consumerId:'http',maxResponseChars:2500});assert.ok(resultChars(b)<=2500);const e=await call('inbox_event_get',{consumerId:'http',eventId:b.items[0].eventId});assert.equal(e.message.text,'message');const r=await call('inbox_ack',{consumerId:'http',batchId:b.batchId,leaseToken:b.leaseToken});assert.equal(r.status,'acknowledged');assert.equal((await call('inbox_claim',{consumerId:'http'})).status,'empty');assert.equal((await call('subscription_status',{})).items.length,1);
 }finally{await c.close();await new Promise(r=>server.close(r));}
});

test('restart and provider change retain ready speech without uploading again',async t=>{
 // Owner-authorised switch is not permission to erase or re-bill historical speech.
 const f=await fixture(t,{media:true,rows:[msg('1',null,{attachments:[{id:'voice',kind:'audio',mimeType:'audio/ogg'}]})]});
 const r=await f.hub.call('clerk','history',{connectionId:'tg',conversationId:'one'});await Promise.all(f.hub.media.jobs.values());const id=r.items[0].attachments[0].fileId,file=f.hub.media.get(id);
 f.hub.media.save({...file,transcription:{status:'ready',source:'codexlb',text:'Verified saved speech'}});await f.restart();
 const saved=await f.hub.call('clerk','transcription_status',{fileId:id});assert.equal(saved.transcription.status,'ready');assert.equal(saved.transcription.text,'Verified saved speech');
 const retry=await f.hub.call('clerk','transcribe_media',{fileId:id,retry:true,waitMs:1000});assert.equal(retry.transcription.text,'Verified saved speech');assert.equal(retry.transcription.source,'codexlb');
});


test('worker allowlist never acquires an excluded scope and reports its disabled status',async t=>{
 // Both scopes have valid grants/subscriptions: background enablement must not
 // reactivate another operator's workflow or consume its polling capacity.
 const f=await fixture(t);
 await f.hub.call('other','subscription_save',{...sub,conversationId:'two'});
 await f.hub.call('clerk','subscription_save',sub);
 f.hub.inbox.config.workerScopes=['clerk'];
 await f.tick();assert.equal(f.stats().reads,1);
 assert.equal((await f.hub.call('clerk','subscription_status',{})).workerEnabled,true);
 const excluded=await f.hub.call('other','subscription_status',{});
 assert.equal(excluded.workerEnabled,false);assert.equal(excluded.items[0].workerEnabled,false);
 assert.equal(excluded.items[0].status,'pending');
 f.advance(11000);f.hub.inbox.config.workerScopes=[];await f.tick();assert.equal(f.stats().reads,1);
 delete f.hub.inbox.config.workerScopes;await f.tick();assert.equal(f.stats().reads,3);
});


test('continued history scans cannot starve newly selected channels with one worker',async t=>{
 // First subscription has more history than one tick can read. The untouched
 // second subscription must run next, rather than waiting for the full archive.
 const f=await fixture(t,{rows:[msg('3'),msg('2'),msg('1')]});
 f.hub.inbox.config.workers=1;
 await f.hub.call('clerk','subscription_save',sub);
 await f.hub.call('clerk','subscription_save',{...sub,subscriptionId:'second'});
 await f.tick();await f.tick();
 for(const id of ['client','second'])assert.equal((await f.hub.call('clerk','subscription_status',{subscriptionId:id})).collection.pagesInCycle,1);
});


test('delegated MTS late text recovers without a Hub upload or source reclassification',async t=>{
 // A failed archived call becomes readable when MTS finishes its own job.
 // Hub manual retries also stay cache-only and cannot create a second paid task.
 const f=await fixture(t,{media:true,rows:[]});f.hub.config.connections.tg.plugin='mts';
 const voice={id:'recording',kind:'audio',mimeType:'audio/mp4',transcription:{status:'failed',text:null,source:'palatine',owner:'mts_mcp',error:'mts_transcription_failed'}};
 const m=msg('1',null,{at:new Date(0).toISOString(),kind:'call',attachments:[voice]});
 await f.hub.call('clerk','subscription_save',{...sub,autoAudio:true});f.setRows([m]);await f.tick();
 let requests=0;f.hub.instances.get('tg').requestTranscription=async()=>{requests++;return 'upstream-job';};const row=f.hub.media.db.prepare('SELECT id FROM files').get();await f.hub.call('clerk','transcribe_media',{fileId:row.id,retry:true,waitMs:0});assert.equal(f.stats().palatine,0);assert.equal(f.stats().downloads,0);assert.equal(requests,1);
 f.setRows([{...m,attachments:[{...voice,transcription:{status:'ready',source:'palatine',owner:'mts_mcp',text:'Complete upstream transcript'}}]}]);f.advance(11000);await f.tick();await new Promise(r=>setImmediate(r));
 const ready=f.hub.media.get(row.id);assert.equal(ready.transcription.text,'Complete upstream transcript');assert.equal(f.stats().palatine,0);assert.equal(f.stats().downloads,0);
 const events=f.hub.inbox.db.prepare('SELECT body FROM inbox_events').all().map(r=>JSON.parse(r.body));const late=events.find(e=>e.kind==='media_ready');assert.ok(late);assert.equal(late.version,1);assert.equal(events.filter(e=>e.kind==='message_updated').length,0);assert.equal(late.ingestion.activity.triage,'historical');assert.equal(late.message.attachments[0].transcription.owner,'mts_mcp');
});

test('MTS call lifecycle keeps placeholder identity through audio and UUID publication',async t=>{
 // Discovery must reach the chat before speech is ready; UUID assignment and
 // byte availability are delivery changes, not a new request or source edit.
 const f=await fixture(t,{media:true,rows:[]});f.hub.config.connections.tg.plugin='mts';
 const id=JSON.stringify(['call','']),voice={id,kind:'audio',mimeType:'audio/mp4',size:null,transcription:{status:'not_started',text:null,source:'palatine',owner:'mts_mcp'}};
 const m=msg(id,null,{at:new Date(0).toISOString(),kind:'call',callState:{recording:'pending',audio:'pending',transcription:'not_started'},attachments:[voice]});
 await f.hub.call('clerk','subscription_save',{...sub,autoAudio:true});f.setRows([m]);await f.tick();await new Promise(r=>setImmediate(r));
 const real=JSON.stringify(['call','record']);f.setRows([{...m,id:real,callState:{recording:'published',audio:'ready',transcription:'not_started'},attachments:[{...voice,id:real,size:100}]}]);f.advance(11000);await f.tick();await new Promise(r=>setImmediate(r));
 f.advance(11000);await f.tick();await new Promise(r=>setImmediate(r));
 const events=f.hub.inbox.db.prepare('SELECT body FROM inbox_events').all().map(r=>JSON.parse(r.body));
 assert.equal(events.filter(e=>e.kind==='message_created').length,1,JSON.stringify(f.hub.inbox.sub('clerk',sub.subscriptionId)));assert.equal(events.filter(e=>e.kind==='message_updated').length,0);
 const update=events.findLast(e=>e.kind==='media_updated');assert.ok(update);assert.equal(update.message.id,id);assert.equal(update.message.callState.audio,'ready');assert.equal(update.version,1);assert.equal(update.source.sourceId,events[0].source.sourceId);assert.equal(f.stats().downloads,0);assert.equal(f.stats().palatine,0);
});

test('no transcript survives restart and provider change without a second upload',async t=>{
 // Empty recognition is durable completion evidence, not an unprocessed job.
 const f=await fixture(t,{media:true,rows:[msg('1',null,{attachments:[{id:'voice',kind:'audio',mimeType:'audio/ogg'}]})]});
 const r=await f.hub.call('clerk','history',{connectionId:'tg',conversationId:'one'});await Promise.all(f.hub.media.jobs.values());const id=r.items[0].attachments[0].fileId,file=f.hub.media.get(id);
 f.hub.media.save({...file,transcription:{status:'no_transcript',source:'codexlb',text:null,outcome:'no_transcript',evidence:'provider_empty_text',speechPresence:'unknown'}});await f.restart();
 const saved=await f.hub.call('clerk','transcription_status',{fileId:id});assert.equal(saved.transcription.status,'no_transcript');assert.equal(saved.transcription.speechPresence,'unknown');
 const retry=await f.hub.call('clerk','transcribe_media',{fileId:id,retry:true,waitMs:1000});assert.equal(retry.transcription.status,'no_transcript');assert.equal(retry.transcription.source,'codexlb');
});

test('late empty recognition emits source-linked media_updated without fabricating speech or failure',async t=>{
 // A completed empty recognition supplements the acknowledged source without
 // changing its version, and is acknowledged independently like other late media.
 let release;const ready=new Promise(r=>release=r);const f=await fixture(t,{media:true,rows:[msg('1','caption',{attachments:[{id:'voice',kind:'audio',mimeType:'audio/ogg'}]})]});
 f.hub.media.palatine.transcribeResult=()=>ready;await f.hub.call('clerk','subscription_save',{...sub,autoAudio:true});await f.tick();await consumer(f);const initial=await claim(f);await ack(f,initial);
 release({text:null,outcome:'no_transcript',evidence:'provider_empty_text',speechPresence:'unknown'});await Promise.all(f.hub.media.jobs.values());await new Promise(r=>setImmediate(r));const b=await claim(f);
 assert.equal(b.items[0].kind,'media_updated');assert.equal(b.items[0].version,initial.items[0].version);assert.equal(b.items[0].source.sourceId,initial.items[0].source.sourceId);assert.equal(b.items[0].message.text,'caption');assert.equal(b.items[0].message.attachments[0].transcription.status,'no_transcript');
 await ack(f,b);assert.equal((await claim(f)).status,'empty');
});

for(const [status,kind] of [['ready','media_ready'],['failed','media_failed'],['submission_unknown','media_updated']])test(`video ${status} supplements are scoped, replayable and preserve native source version`,async t=>{
 // A previously acknowledged historical video wakes waiting_media, but never
 // becomes a new request or rewrites its caption. No ASR/provider calls occur.
 const original=msg('1','original caption',{at:'1970-01-01T00:00:01.000Z',sourceText:'original source',attachments:[{id:'video',kind:'video',filename:'clip.mp4',mimeType:'video/mp4'}]});
 const f=await fixture(t,{media:true,rows:[original]});await f.hub.call('clerk','subscription_save',sub);await f.tick();await consumer(f);const initial=await claim(f);await ack(f,initial);const event=initial.items[0],id=event.message.attachments[0].fileId;
 f.hub.video.save({fileId:id,scope:'clerk',status:'transcribing'});await new Promise(r=>setImmediate(r));assert.equal((await claim(f)).status,'empty');
 const job={fileId:id,scope:'clerk',status,...(status==='ready'?{hasAudio:true,segmentCount:2}:{error:{code:'video_submission_unknown',retryable:false}})};
 f.hub.video.save(job);await new Promise(r=>setImmediate(r));const batch=await claim(f),late=batch.items[0];assert.equal(batch.items.length,1);assert.equal(late.kind,kind);assert.equal(late.message.attachments[0].video.status,status);
 assert.equal(late.version,event.version);assert.equal(late.source.versionHash,event.source.versionHash);assert.equal(late.message.text,original.text);assert.equal((await f.hub.call('clerk','inbox_event_get',{consumerId:'clerk1',eventId:late.eventId})).message.sourceText,original.sourceText);assert.equal(late.ingestion.activity.triage,'historical');assert.equal(late.mediaRevision,1);
 const cached=await f.hub.call('clerk','message_get',{connectionId:'tg',conversationId:'one',messageId:'1',readMode:'cached'});assert.equal(cached.message.attachments[0].video.status,status);
 await assert.rejects(f.hub.call('other','video_status',{fileId:id}),/not_authorized/);await ack(f,batch);f.hub.video.save(job);await new Promise(r=>setImmediate(r));assert.equal((await claim(f)).status,'empty');
 await f.restart();f.advance(11000);await f.tick();assert.equal((await claim(f)).status,'empty');assert.equal(f.stats().palatine,0);assert.equal(f.stats().legacy,0);
});
