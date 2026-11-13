import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Hub} from '../src/hub.mjs';
import {Store} from '../src/store.mjs';
import {createHttp} from '../src/server.mjs';
import {resultChars} from '../src/tool-result.mjs';
import mts from '../src/plugins/mts.mjs';
import {PalatineASR} from '../src/palatine.mjs';
const message=(n,extra={})=>({id:String(n),conversationId:'chat',direction:'inbound',senderId:'client',isSelf:false,at:`2026-10-01T10:00:${String(n%60).padStart(2,'0')}Z`,text:'source '.repeat(1000),attachments:[],...extra});
async function fixture(t,{push=false,projects=[],rows=[message(1)]}={}){
 const root=await mkdtemp(path.join(tmpdir(),'hub-clerk-'));let current=rows;
 const config={version:1,cache:{defaultRead:'refresh'},store:path.join(root,'store'),plugins:{fake:'/unused'},connections:{tg:{plugin:'fake',label:'TG',settings:{}}},inbox:{enabled:false,push:{enabled:push},projects,pageSize:100},scopes:{clerk:{token:'a'.repeat(40),inbox:{read:true,manage:true,push},connections:{tg:{read:true,send:false,conversations:['chat']}}},other:{token:'b'.repeat(40),inbox:{read:true,manage:true,push},connections:{tg:{read:true,send:false,conversations:['elsewhere']}}}}};
 const plugin={create:()=>({capabilities:{history:true,send:false,attachments:false,changes:false,kinds:['message']},history:async()=>({items:current,next:null,complete:true}),conversations:async()=>({items:[],next:null})})};
 let hub=new Hub(config,{fake:plugin},new Store(config.store));
 t.after(async()=>{await hub.close();await rm(root,{recursive:true,force:true});});
 const call=(method,input)=>hub.call('clerk',method,input);
 await call('subscription_save',{subscriptionId:'sub',revision:0,connectionId:'tg',conversationId:'chat',enabled:true,settleMs:0,autoAudio:false});
 await hub.inbox.tick();await call('inbox_consumer_ensure',{consumerId:'one',subscriptionIds:['sub']});await call('inbox_consumer_ensure',{consumerId:'two',subscriptionIds:['sub']});
 return {get hub(){return hub;},call,config,set:r=>current=r,restart:async()=>{await hub.close();hub=new Hub(config,{fake:plugin},new Store(config.store));}};
}

test('snapshot backlog is bounded, restartable, stable and independent of lease/ack and new arrivals',async t=>{
 // A full burst must paginate every source once; a new arrival belongs to the next snapshot.
 const f=await fixture(t,{rows:Array.from({length:25},(_,i)=>message(i+1))});
 const first=await f.call('inbox_replay',{consumerId:'one',maxResponseChars:2500});assert.ok(resultChars(first)<=2500);assert.ok(first.nextCursor);assert.deepEqual(await f.call('inbox_replay',{consumerId:'one',cursor:first.cursor}),first);
 const lease=await f.call('inbox_claim',{consumerId:'one',maxResponseChars:2500});await f.call('inbox_ack',{consumerId:'one',batchId:lease.batchId,leaseToken:lease.leaseToken});
 await f.restart();const s=f.hub.inbox.sub('clerk','sub');f.hub.inbox.transaction(()=>f.hub.inbox.observe(s,message(26)));
 const ids=first.items.map(x=>x.eventId);let cursor=first.nextCursor;
 while(cursor){const r=await f.call('inbox_replay',{consumerId:'one',cursor});assert.equal(r.snapshotId,first.snapshotId);assert.ok(resultChars(r)<=2500);ids.push(...r.items.map(x=>x.eventId));cursor=r.nextCursor;}
 assert.equal(ids.length,25);assert.equal(new Set(ids).size,25);assert.equal((await f.call('inbox_diagnostics',{consumerId:'two'})).ackedCursor,0);assert.equal((await f.call('inbox_diagnostics',{consumerId:'one'})).observedCursor,26);
 await assert.rejects(f.call('inbox_replay',{consumerId:'two',cursor:first.cursor}),/cursor_invalid/);
 await assert.rejects(f.hub.call('other','inbox_replay',{consumerId:'one',cursor:first.cursor}),/consumer_not_found/);
});

test('confirmed project routing never merges names or guesses shared conversation and revoked contacts',async t=>{
 // One conversation can serve two projects. A stale contact binding is not an alternate identity.
 const binding={scope:'clerk',projectId:'alpha',clientId:'client-1',confirmed:true,routes:[{connectionId:'tg',conversationId:'chat'}]};
 const f=await fixture(t,{projects:[binding,{...binding,projectId:'beta'},{...binding,projectId:'stale',contactId:'missing'}]});
 const p=await f.call('inbox_projects',{});assert.equal(p.collectionEnabled,false);assert.equal(p.items.find(x=>x.projectId==='stale').status,'binding_unavailable');
 const r=await f.call('inbox_replay',{consumerId:'one'});assert.equal(r.items[0].routing.status,'ambiguous');assert.deepEqual(r.items[0].routing.candidates.map(x=>x.projectId),['alpha','beta']);assert.equal(f.hub.inbox.read.projects('other').items.length,0);
});

test('context has exact reply chain and provenance; late cancelled-question reply remains an ordinary source',async t=>{
 // Cancellation belongs to the clerk ledger. Hub never reassigns a late reply to a newer question.
 const f=await fixture(t,{rows:[message(1,{direction:'outbound',isSelf:true,text:'old question'}),message(2,{replyTo:'1',replyToKnown:true,text:'late answer'}),message(3,{direction:'outbound',isSelf:true,text:'new question'})]});
 const r=await f.call('inbox_replay',{consumerId:'one'}),answer=r.items.find(x=>x.source.messageId==='2');assert.equal(answer.replyEvidence.replyTo,'1');assert.equal(answer.author.isSelf,false);assert.equal(answer.sourceTimestamp,answer.message.at);assert.equal(answer.receivedAt,answer.observedAt);
 const context=await f.call('inbox_context',{consumerId:'one',eventId:answer.eventId});assert.equal(context.replyChain[0].id,'1');assert.equal(context.replyChainComplete,true);
 const externalQuestions=new Map([['1',{state:'cancelled'}],['3',{state:'pending'}]]);const matched=externalQuestions.get(answer.replyEvidence.replyTo);assert.equal(matched.state,'cancelled');assert.equal(externalQuestions.get('3').state,'pending');assert.equal(answer.kind,'message_created');
 const small=await f.call('inbox_context',{consumerId:'one',eventId:answer.eventId,maxResponseChars:2000});assert.ok(resultChars(small)<=2000);
});

test('local scoped SSE sends durable identifiers, resumes after disconnect/restart and grants default off',async t=>{
 // This is a real HTTP socket with synthetic providers: no real chats or callback URLs.
 const f=await fixture(t,{push:true});let server;
 const listen=async()=>{server=createHttp(f.hub);await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;};
 const stop=async()=>{server.closeInboxStreams();await new Promise(r=>server.close(r));};
 let url=await listen();const auth={Authorization:'Bearer '+'a'.repeat(40)};
 assert.equal((await fetch(url+'/inbox/events?consumerId=one')).status,401);
 assert.equal((await fetch(url+'/inbox/events?consumerId=one',{headers:{Authorization:'Bearer '+'b'.repeat(40)}})).status,403);
 const abort=new AbortController();const res=await fetch(url+'/inbox/events?consumerId=one',{headers:auth,signal:abort.signal});assert.equal(res.status,200);const reader=res.body.getReader();const first=new TextDecoder().decode((await reader.read()).value);const id=/id: ([^\n]+)/.exec(first)[1];assert.ok(first.includes('inbox_observed'));assert.ok(!first.includes('source source'));abort.abort();await reader.cancel().catch(()=>{});await stop();
 await f.restart();const s=f.hub.inbox.sub('clerk','sub');f.hub.inbox.transaction(()=>f.hub.inbox.observe(s,message(2)));url=await listen();
 const nextAbort=new AbortController();const resumed=await fetch(url+'/inbox/events?consumerId=one',{headers:{...auth,'Last-Event-ID':id},signal:nextAbort.signal});const nextReader=resumed.body.getReader();const frame=new TextDecoder().decode((await nextReader.read()).value);assert.ok(frame.includes('"sequence":2'));assert.ok(!frame.includes('"sequence":1'));const liveRead=nextReader.read();const current=f.hub.inbox.sub('clerk','sub');f.hub.inbox.transaction(()=>f.hub.inbox.emit(current,{kind:'media_ready',version:1,mediaRevision:1,source:{connectionId:'tg',conversationId:'chat',messageId:'2'},message:message(2)}));const liveFrame=new TextDecoder().decode((await liveRead).value);assert.ok(liveFrame.includes('"sequence":3'));nextAbort.abort();await nextReader.cancel().catch(()=>{});
 const health=await fetch(url+'/inbox/read',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({method:'inbox_diagnostics',input:{consumerId:'one'}})});assert.equal((await health.json()).ackedCursor,0);await stop();
 f.hub.inbox.config.push.enabled=false;assert.throws(()=>f.hub.inbox.read.notifications('clerk','one'),/push_disabled/);
});

test('MTS consumes full paged Palatine cache without billable provider calls',async t=>{
 // The archive browse preview is deliberately truncated; all 35000 characters
 // must come from verified cache pages, with no sync/POST/audio/ASR request.
 const original=globalThis.fetch,urls=[];t.after(()=>globalThis.fetch=original);
 globalThis.fetch=async u=>{const url=new URL(u);urls.push(url.pathname);const offset=Number(url.searchParams.get('offset'));return new Response(JSON.stringify(url.pathname==='/api/recordings'?{items:[{phone:'12345',call_id:'call',record_id:'record',date:1700000000,text:'PREVIEW',text_characters:35000,state:'ready',audio:{bytes:100},call:{direction:'in'}}],total:1,next_offset:null}:{provider:'palatine',text:offset?'x'.repeat(5000):'👍'+'x'.repeat(29999),total_characters:35000,next_offset:offset?null:30000}));};
 const adapter=mts.create({url:'http://127.0.0.1:9999'}),r=await adapter.history({conversationId:'12345',cursor:null,limit:10});assert.equal(r.items[0].text,null);assert.equal([...r.items[0].attachments[0].transcription.text].length,35000);assert.equal(r.items[0].attachments[0].transcription.owner,'mts_mcp');assert.deepEqual(urls,['/api/recordings','/api/text','/api/text']);
});

test('MTS rejects unknown transcript engines instead of borrowing browse text',async t=>{
 // Unverified legacy text must never be relabelled as Palatine.
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
 globalThis.fetch=async u=>new Response(JSON.stringify(new URL(u).pathname==='/api/recordings'?{items:[{phone:'12345',call_id:'c',record_id:'r',date:1700000000,text_characters:10,audio:{bytes:100}}],total:1}:{provider:'unknown',text:'unverified',total_characters:10,next_offset:null}));
 await assert.rejects(mts.create({url:'http://127.0.0.1:9999'}).history({conversationId:'12345',cursor:null,limit:10}),/archive_transcript_unverified/);
});

test('Palatine full text and optional speaker segments are retained with uncertainty and no fallback',async t=>{
 // Speaker labels originate at the ASR provider, not identity inference by Hub.
 const root=await mkdtemp(path.join(tmpdir(),'hub-pal-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'key'),'synthetic',{mode:0o600});await writeFile(path.join(root,'audio'),'audio');
 const asr=new PalatineASR({keyFile:path.join(root,'key')},1000,async()=>new Response(JSON.stringify({text:'long '.repeat(20000),segments:[{speaker:'S1',start:0,end:3600,text:'long call'}]})));
 const r=await asr.transcribeResult(path.join(root,'audio'));assert.equal(r.text.length,99999);assert.equal(r.segments[0].speakerUncertain,true);assert.equal(r.speakerAttribution,'provider_unverified');
});

test('retained pre-HUB019 snapshots expose additive timestamps and unknown native evidence without new versions',async t=>{
 // Simulate the old wire shape. The source snapshot/ID/revision remains unchanged.
 const f=await fixture(t),row=f.hub.inbox.db.prepare('SELECT id,body FROM inbox_events LIMIT 1').get(),old=JSON.parse(row.body);
 for(const field of ['receivedAt','sourceTimestamp','sourceUrl','author','replyEvidence'])delete old[field];delete old.message.isSelf;
 f.hub.inbox.db.prepare('UPDATE inbox_events SET body=? WHERE id=?').run(JSON.stringify(old),row.id);await f.restart();
 const event=await f.call('inbox_event_get',{consumerId:'one',eventId:row.id});assert.equal(event.receivedAt,old.observedAt);assert.equal(event.sourceTimestamp,old.message.at);assert.equal(event.author.isSelf,null);assert.equal(event.version,old.version);assert.equal(event.eventId,row.id);
 const replay=await f.call('inbox_replay',{consumerId:'one'});assert.equal(replay.items[0].author.evidence,'unavailable');assert.equal(replay.items[0].replyEvidence.referenceKnown,null);
});


test('Palatine billing rejection is actionable without leaking provider bodies or retrying upload',async t=>{
 // An empty balance is a configuration gate, not damaged client audio. Unknown
 // 400 responses stay generic and neither case may trigger a second upload.
 const root=await mkdtemp(path.join(tmpdir(),'hub-pal-balance-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'key'),'synthetic',{mode:0o600});await writeFile(path.join(root,'audio'),'audio');
 let requests=0;
 const asr=new PalatineASR({keyFile:path.join(root,'key')},1000,async()=>{requests++;return new Response(JSON.stringify({detail:'Not enough balance. ID: PRIVATE_ID'}),{status:400});});
 await assert.rejects(asr.transcribeResult(path.join(root,'audio')),e=>e.code==='palatine_balance_insufficient'&&!e.message.includes('PRIVATE_ID'));
 assert.equal(requests,1);
 const unknown=new PalatineASR({keyFile:path.join(root,'key')},1000,async()=>new Response(JSON.stringify({detail:'PRIVATE_UNEXPECTED_BODY'}),{status:400}));
 await assert.rejects(unknown.transcribeResult(path.join(root,'audio')),e=>e.code==='palatine_http_400'&&!e.message.includes('PRIVATE_UNEXPECTED_BODY'));
});


test('page cursor overhead cannot strand a fitting replay prefix at budget boundaries',async t=>{
 // A page used to fit until its own cursor was appended, then fail forever at
 // that same source. Exercise the narrow boundary around a complete two-row page.
 const f=await fixture(t,{rows:[message(1),message(2),message(3)]});
 const full=await f.call('inbox_replay',{consumerId:'one',limit:2,maxTextChars:0,maxResponseChars:200000});
 const chars=resultChars(full);
 for(let budget=chars-100;budget<=chars+5;budget++){
  const page=await f.call('inbox_replay',{consumerId:'one',limit:2,maxTextChars:0,maxResponseChars:budget});
  assert.ok(resultChars(page)<=budget);assert.ok(page.items.length>0);
  assert.deepEqual(await f.call('inbox_replay',{consumerId:'one',cursor:page.cursor}),JSON.parse(JSON.stringify(page)));
 }
 assert.equal((await f.call('inbox_diagnostics',{consumerId:'one'})).ackedCursor,0);
});


test('MTS explicit transcription verifies contact before delegating billable preparation',async t=>{
 // History is cache-only. Only this explicit method may POST, and a borrowed
 // call identity must fail before either CSRF lookup or billable preparation.
 const original=globalThis.fetch,posts=[];t.after(()=>globalThis.fetch=original);
 globalThis.fetch=async(u,o={})=>{const p=new URL(u).pathname;if(o.method==='POST'){posts.push(JSON.parse(o.body));assert.equal(o.headers['X-Archive-CSRF'],'fixture');return new Response(JSON.stringify({job_id:'job'}));}return new Response(JSON.stringify(p==='/api/status'?{csrf:'fixture'}:{items:[{phone:'12345',call_id:'c',record_id:'r'}],total:1,next_offset:null}));};
 const a=mts.create({url:'http://127.0.0.1:9999'});await assert.rejects(a.requestTranscription({conversationId:'12345',messageId:JSON.stringify(['other','r'])}),/attachment_not_in_conversation/);assert.equal(posts.length,0);assert.equal(await a.requestTranscription({conversationId:'12345',messageId:JSON.stringify(['c','r'])}),'job');assert.deepEqual(posts,[{call_id:'c',record_id:'r'}]);
});

test('MTS exposes pending call metadata and sanitized upstream freshness without preparing media',async t=>{
 // Archive access can be healthy while discovery is unauthorized. The UI needs
 // both facts without auth tokens, raw provider errors or a paid preparation.
 const original=globalThis.fetch,urls=[];t.after(()=>globalThis.fetch=original);
 globalThis.fetch=async u=>{const url=new URL(u);urls.push(url.pathname);return new Response(JSON.stringify(url.pathname==='/api/status'?{csrf:'private',settings:{last_error:'auth_required: private',last_sync_ok:false,next_sync:123},freshness:{last_indexed_at:100,index_age_seconds:23,next_check_at:123}}:{items:[{phone:'12345',call_id:'c',record_id:null,date:1700000000,state:'recording_pending',readiness:{recording:'pending',audio:'pending'},call:{direction:'out'}}],total:1}));};
 const a=mts.create({url:'http://127.0.0.1:9999'}),page=await a.history({conversationId:'12345',cursor:null,limit:10});assert.equal(page.items[0].id,JSON.stringify(['c','']));assert.equal(page.items[0].callState.recording,'pending');assert.equal(page.items[0].attachments[0].transcription.status,'not_started');const h=await a.health();assert.equal(h.sourceSync.errorCode,'auth_required');assert.equal(h.sourceSync.indexAgeSeconds,23);assert.ok(!JSON.stringify(h).includes('private'));assert.deepEqual(urls,['/api/recordings','/api/status']);
});
