import {createMcp} from '../src/mcp.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {HubError} from '../src/contracts.mjs';
import {resultChars} from '../src/tool-result.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,copyFile,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Hub} from '../src/hub.mjs';
import {Store} from '../src/store.mjs';
import {createHttp} from '../src/server.mjs';
import {SubscriptionASR} from '../src/asr.mjs';
import {telegramMedia} from '../src/plugins/telegram.mjs';
import whatsapp from '../src/plugins/whatsapp.mjs';

const message=(id,attachments=[],text='caption')=>({id,conversationId:'one',direction:'inbound',senderId:'sender',at:'2026-09-27T12:00:00Z',text,attachments});
const attachment=(id,kind='audio')=>({id,kind,filename:kind==='audio'?'voice.ogg':kind==='video'?'movie.mp4':'report.pdf',mimeType:kind==='audio'?'audio/ogg':kind==='video'?'video/mp4':'application/pdf',size:64});
async function fixture(t,{asr,history,search,waitMs=1000,rows}={}){
 const root=await mkdtemp(path.join(tmpdir(),'hub-media-'));let calls=0,downloads=0,reads=0;let current=rows??[message('1',[attachment('a')]),message('2',[attachment('v','video')]),message('3',[attachment('d','document')])];
 const plugin={create:()=>({capabilities:{history:true,send:false,attachments:true,changes:false,kinds:['message']},conversations:async()=>({items:[],next:null}),history:async v=>{reads++;return history?history(v):{items:current,next:null,complete:true};},...(search?{search}:{}),attachment:async v=>{downloads++;return {base64:Buffer.alloc(64,v.attachmentId.charCodeAt(0)).toString('base64'),filename:'file',mimeType:'application/octet-stream'};}})};
 const grant={read:true,send:false,profiles:false,conversations:['one']};
 const config={version:1,cache:{defaultRead:'refresh'},store:':memory:',plugins:{fake:'/fake'},connections:{a:{plugin:'fake',label:'A',settings:{}},b:{plugin:'fake',label:'B',settings:{}}},scopes:{a:{token:'a'.repeat(40),connections:{a:grant}},b:{token:'b'.repeat(40),connections:{b:grant}}},media:{root,keyFile:'/unused',palatine:{keyFile:'/unused'},historyWaitMs:waitMs,workers:2}};
 const hub=new Hub(config,{fake:plugin},new Store(':memory:'),{media:{palatine:{transcribe:async f=>{calls++;return asr?asr(f):'Распознанный голос.';}},probe:async()=>({duration:3,hasAudio:true}),extract:copyFile},readTools:{pollMs:5}});
 t.after(async()=>{await hub.close();await rm(root,{recursive:true,force:true});});
 return {hub,root,stats:()=>({calls,downloads,reads}),setRows:r=>{current=r;}};
}

test('history transcribes audio, preserves caption, exposes UUIDs, and never downloads video/files automatically',async t=>{
 // A mixed page must deliver every message; only its audio consumes ASR/download work.
 const f=await fixture(t);const result=await f.hub.call('a','history',{connectionId:'a',conversationId:'one'});
 assert.equal(result.items.length,3);assert.match(result.items[0].text,/caption.*\n\n\[Транскрипция аудио\]/);assert.equal(result.items[0].sourceText,'caption');
 const a=result.items[0].attachments[0];assert.match(a.fileId,/^[\da-f-]{36}$/);assert.match(a.downloadUrl,/\/files\//);assert.equal(a.transcription.status,'ready');
 assert.equal(result.items[1].attachments[0].transcription.status,'not_requested');assert.equal(f.stats().downloads,1);assert.equal(f.stats().calls,1);
 const second=await f.hub.call('a','history',{connectionId:'a',conversationId:'one'});assert.equal(second.items[0].attachments[0].fileId,a.fileId);assert.equal(f.stats().calls,1);
 const file=await f.hub.call('a','file_download',{fileId:result.items[2].attachments[0].fileId});assert.equal(file.size,64);assert.equal((await readFile(file.path)).length,64);assert.equal(f.stats().calls,1);
});

test('explicit video transcription runs once, while status reads never start jobs',async t=>{
 // Large/slow video is opt-in; an agent can poll without blocking the rest of the conversation.
 const f=await fixture(t,{rows:[message('2',[attachment('v','video')])]});const r=await f.hub.call('a','history',{connectionId:'a',conversationId:'one'}),fileId=r.items[0].attachments[0].fileId;
 assert.equal((await f.hub.call('a','transcription_status',{fileId})).transcription.status,'not_requested');assert.equal(f.stats().downloads,0);
 const done=await f.hub.call('a','transcribe_media',{fileId,waitMs:1000});assert.equal(done.transcription.status,'ready');assert.equal(f.stats().calls,1);
 await f.hub.call('a','transcribe_media',{fileId});assert.equal(f.stats().calls,1);
});

test('slow or failing audio does not block unrelated messages and failed ASR is not retried implicitly',async t=>{
 // The caller's wait budget is separate from the shared background task lifetime.
 let release;const gate=new Promise(r=>{release=r;});const f=await fixture(t,{waitMs:5,asr:async()=>{await gate;throw new Error('private upstream failure');}});
 const r=await f.hub.call('a','history',{connectionId:'a',conversationId:'one'});assert.equal(r.items.length,3);const fileId=r.items[0].attachments[0].fileId;
 assert.ok(['queued','running'].includes(r.items[0].attachments[0].transcription.status));release();await f.hub.media.jobs.get(fileId);
 const fail=await f.hub.call('a','transcription_status',{fileId});assert.equal(fail.transcription.status,'failed');assert.equal(fail.transcription.error,'media_processing_failed');
 await f.hub.call('a','history',{connectionId:'a',conversationId:'one'});assert.equal(f.stats().calls,1);
});

test('file UUID and cached transcription stay bound to authorized route and protected HTTP download',async t=>{
 // Knowing an opaque file ID is not enough to read another portal, even after the file was cached.
 const f=await fixture(t);const r=await f.hub.call('a','history',{connectionId:'a',conversationId:'one'}),fileId=r.items[0].attachments[0].fileId;
 const before=f.stats().downloads;await assert.rejects(f.hub.call('b','file_download',{fileId}),/not_authorized/);await assert.rejects(f.hub.call('b','transcription_status',{fileId}),/not_authorized/);assert.equal(f.stats().downloads,before);
 const server=createHttp(f.hub);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const url=`http://127.0.0.1:${server.address().port}/files/${fileId}`;
 assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{Authorization:'Bearer '+'b'.repeat(40)}})).status,404);
 const ok=await fetch(url,{headers:{Authorization:'Bearer '+'a'.repeat(40)}});assert.equal(ok.status,200);assert.equal((await ok.arrayBuffer()).byteLength,64);
 }finally{await new Promise(r=>server.close(r));}
});

test('same audio bytes use one transcription cache across distinct message IDs',async t=>{
 // Forwarded identical audio should not spend subscription quota twice; authorization is still per file.
 const f=await fixture(t,{rows:[message('1',[attachment('a')]),message('2',[attachment('a')])]});
 const r=await f.hub.call('a','history',{connectionId:'a',conversationId:'one'});assert.equal(f.stats().calls,1);assert.notEqual(r.items[0].attachments[0].fileId,r.items[1].attachments[0].fileId);
});

test('native message search preserves exact routing and finds already transcribed speech',async t=>{
 // Provider text search cannot index voice itself; Hub supplements it with its observed ASR cache.
 let queries=0;const f=await fixture(t,{search:async v=>{queries++;assert.equal(v.conversationId,'one');return {items:[],next:null,complete:true};}});
 await f.hub.call('a','history',{connectionId:'a',conversationId:'one'});
 const r=await f.hub.call('a','search_messages',{connectionId:'a',conversationId:'one',query:'голос'});assert.equal(r.cachedAudioMatches.length,1);assert.equal(r.coverage,'provider_search_plus_observed_audio');
 await assert.rejects(f.hub.call('b','search_messages',{connectionId:'a',conversationId:'one',query:'голос'}),/not_authorized/);assert.equal(queries,1);
});

test('settled wait keeps independent replayable cursors and ignores existing history',async t=>{
 // Two agents must each receive the same new burst; neither consumes a shared upstream pending set.
 const f=await fixture(t,{rows:[message('old',[],'old')]});const args={subscriptions:[{connectionId:'a',conversationId:'one'}],settleMs:250,maxWaitMs:20};
 const one=await f.hub.call('a','wait_for_settled_message',args),two=await f.hub.call('a','wait_for_settled_message',args);assert.equal(one.event,false);
 f.setRows([message('new2',[],'second'),message('new1',[],'first'),message('old',[],'old')]);
 const [a,b]=await Promise.all([one,two].map(r=>f.hub.call('a','wait_for_settled_message',{...args,maxWaitMs:800,cursor:r.cursor})));
 assert.equal(a.event,true);assert.equal(b.event,true);assert.deepEqual(a.events[0].items.map(m=>m.id),['new2','new1']);
 const replay=await f.hub.call('a','wait_for_settled_message',{...args,maxWaitMs:800,cursor:one.cursor});assert.deepEqual(replay,a);
 await assert.rejects(f.hub.call('b','wait_for_settled_message',{...args,subscriptions:[{connectionId:'b',conversationId:'one'}],cursor:a.cursor}),/wait_cursor_not_found/);
});

test('Telegram media metadata parses filenames/size without executing representation text',()=>{
 // Media captions are not enough: the provider metadata must distinguish voice, video and files.
 const a=telegramMedia("MessageMediaDocument(document=Document(id=123, mime_type='audio/ogg', size=2048, attributes=[DocumentAttributeAudio(voice=True), DocumentAttributeFilename(file_name='voice.ogg')]))",'8');
 assert.deepEqual(a,{id:'message:8',kind:'audio',filename:'voice.ogg',mimeType:'audio/ogg',size:2048,providerVersion:'123'});
 assert.equal(telegramMedia('No media found in the specified message.','9'),null);
 assert.equal(telegramMedia("MessageMediaDocument(document=Document(id=5, mime_type='video/mp4',size=99))",'9').kind,'video');
});

test('WhatsApp relative downloads stay inside media root; mismatched message/path is rejected',async t=>{
 // GOWA returns relative paths; resolving against cwd broke downloads and could read the wrong file.
 const root=await mkdtemp(path.join(tmpdir(),'hub-wa-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'statics/media'),{recursive:true});await writeFile(path.join(root,'statics/media/voice.ogg'),'audio');
 let returned={message_id:'msg',file_path:'statics/media/voice.ogg',file_size:5};
 const p=whatsapp.create({mediaRoot:root,upstreamClient:{call:async()=>returned}});
 const args={conversationId:'111@s.whatsapp.net',messageId:'msg',attachmentId:'msg'};
 assert.equal((await p.attachmentFile(args)).size,5);assert.equal(Buffer.from((await p.attachment(args)).base64,'base64').toString(),'audio');
 returned={...returned,message_id:'other'};await assert.rejects(p.attachmentFile(args),/attachment_mismatch/);
 returned={message_id:'msg',file_path:'/etc/passwd'};await assert.rejects(p.attachmentFile(args),/attachment_path_denied/);
});

test('subscription ASR uses the existing key via multipart backend route and redacts failure',async t=>{
 // The endpoint must stay on subscription ASR, with native Codex UA and no paid-model request field.
 const root=await mkdtemp(path.join(tmpdir(),'hub-asr-'));t.after(()=>rm(root,{recursive:true,force:true}));const keyFile=path.join(root,'key'),audio=path.join(root,'voice.mp3');await writeFile(keyFile,'synthetic-secret',{mode:0o600});await writeFile(audio,'audio');
 const config={keyFile,asrUrl:'https://synthetic.invalid/backend-api/transcribe',asrTimeoutMs:1000,maxAudioBytes:100};
 const provider=new SubscriptionASR(config,async(url,options)=>{assert.match(url,/backend-api\/transcribe$/);assert.match(options.headers['User-Agent'],/^codex_cli_rs/);assert.equal(options.body.get('model'),null);assert.equal(options.body.get('file').size,5);return Response.json({text:' Привет. '});});
 assert.equal(await provider.transcribe(audio),'Привет.');
 const fail=new SubscriptionASR(config,async()=>{throw new Error('synthetic-secret');});await assert.rejects(fail.transcribe(audio),e=>e.message==='asr_unavailable');
});

test('first wait can start after a known sent/read ID, so an early reply is not missed',async t=>{
 // The client can reply before the agent invokes wait; an explicit anchor must include that reply.
 const f=await fixture(t,{rows:[message('reply',[],'already arrived'),message('sent',[],'owner send')]});
 const r=await f.hub.call('a','wait_for_settled_message',{subscriptions:[{connectionId:'a',conversationId:'one',afterMessageId:'sent'}],settleMs:250,maxWaitMs:800});
 assert.equal(r.event,true);assert.deepEqual(r.events[0].items.map(m=>m.id),['reply']);
});

test('Telegram native search paginates without dropping results and rejects a cursor for another query',async()=>{
 // The underlying tool lacks offset: the adapter expands its native search window then returns only this page.
 const telegram=(await import('../src/plugins/telegram.mjs')).default;const calls=[];
 const p=telegram.create({selfId:'owner',upstreamClient:{call:async(name,args)=>{if(name==='get_media_info')return 'No media found in the specified message.';calls.push(args.limit);return {results:Array.from({length:Math.min(args.limit,3)},(_,i)=>({id:3-i,sender:'User [id=4]',date:'2026-09-27T00:00:00Z',text:'match'}))};}}});
 const first=await p.search({conversationId:'123',query:'match',cursor:null,limit:2});const second=await p.search({conversationId:'123',query:'match',cursor:first.next,limit:2});
 assert.deepEqual([...first.items,...second.items].map(m=>m.id),['3','2','1']);assert.equal(second.complete,true);assert.deepEqual(calls,[2,4]);
 await assert.rejects(p.search({conversationId:'123',query:'other',cursor:first.next,limit:2}),/cursor_invalid/);
});

test('enriched history still satisfies the shared wire contract and preserves incomplete metadata flags',async t=>{
 // New fields must be schema-supported, including partial metadata lookup failures from an upstream.
 const {page}=await import('../src/contracts.mjs');const f=await fixture(t);
 const result=await f.hub.call('a','history',{connectionId:'a',conversationId:'one'});assert.equal(page.parse(result).items[0].sourceText,'caption');
 const raw=message('partial',[attachment('a')]);raw.mediaMetadataIncomplete=true;assert.equal(page.parse({items:[raw],next:null,complete:true}).items[0].mediaMetadataIncomplete,true);
});

test('compact history clips presentation only; full message and cached file retain the entire transcript',async t=>{
 // Token limits must not destroy evidence; attachment filtering is explicitly page-local.
 const transcript='Long voice '.repeat(1000);const f=await fixture(t,{asr:async()=>transcript});
 const r=await f.hub.call('a','history',{connectionId:'a',conversationId:'one',mode:'compact',maxTextChars:3,maxTranscriptChars:12,attachmentTypes:['audio']});
 assert.equal(r.items.length,1);assert.equal(r.filterCoverage,'current_provider_page');assert.equal(r.items[0].textTruncated,true);
 const a=r.items[0].attachments[0];assert.equal(a.transcription.text.length,12);assert.equal(a.transcription.textTruncated,true);
 assert.equal((await f.hub.call('a','message_get',{connectionId:'a',conversationId:'one',messageId:'1'})).message.attachments[0].transcription.text,transcript);
 assert.equal((await f.hub.call('a','file_download',{fileId:a.fileId})).transcription.text,transcript);
 assert.deepEqual((await f.hub.call('a','file_download',{fileId:a.fileId})).transcription.transitions.map(s=>s.status),['queued','running','ready']);
 const batch=await f.hub.call('a','files_download',{fileIds:[a.fileId,'00000000-0000-4000-8000-000000000000']});assert.equal(batch.items[0].status,'ready');assert.equal(batch.items[1].status,'failed');
});

test('download MIME is detected from bytes and persisted for subsequent history',async t=>{
 // A generic provider MIME must not hide OGG/Opus or JPEG after successful download.
 const f=await fixture(t,{rows:[message('image',[{...attachment('x','image'),mimeType:null}])]});
 f.hub.instances.get('a').attachment=async()=>({base64:Buffer.from('ffd8ff001122','hex').toString('base64'),mimeType:'application/octet-stream',filename:'unknown'});
 const r=await f.hub.call('a','history',{connectionId:'a',conversationId:'one'});const id=r.items[0].attachments[0].fileId;
 assert.equal((await f.hub.call('a','file_download',{fileId:id})).mimeType,'image/jpeg');
 assert.equal((await f.hub.call('a','history',{connectionId:'a',conversationId:'one'})).items[0].attachments[0].mimeType,'image/jpeg');
});

test('a verified retry clears only the active download error and preserves ASR and audit evidence',async t=>{
 // A temporary bridge failure must not survive a later successful original
 // download as a false current error; unrelated failure evidence stays intact.
 const f=await fixture(t,{rows:[message('retry',[attachment('pic','image')])]});
 const page=await f.hub.call('a','history',{connectionId:'a',conversationId:'one'}),id=page.items[0].attachments[0].fileId;
 f.hub.media.save({...f.hub.media.get(id),transcription:{status:'failed',source:'palatine',text:null,error:'palatine_http_400',diagnostic:{code:'palatine_http_400',stage:'transcription'}},downloadAttempts:[{code:'upstream_unavailable',attempt:1}]});
 const before=f.hub.media.get(id);let downloads=0;
 f.hub.instances.get('a').attachment=async()=>{downloads++;if(downloads===1)throw new HubError('upstream_unavailable');return {base64:Buffer.from('ffd8ff001122','hex').toString('base64'),filename:'original.jpg',mimeType:'image/jpeg'};};
 await assert.rejects(f.hub.call('a','file_download',{fileId:id}),e=>e.code==='upstream_unavailable');
 assert.equal(f.hub.media.get(id).downloadDiagnostic.code,'upstream_unavailable');
 const result=await f.hub.call('a','file_download',{fileId:id}),stored=f.hub.media.get(id);
 assert.equal(result.size,6);assert.equal((await readFile(result.path)).length,6);assert.match(result.sha256,/^[a-f0-9]{64}$/);
 assert.equal(Object.hasOwn(result,'downloadDiagnostic'),false);assert.equal(Object.hasOwn(stored,'downloadDiagnostic'),false);
 assert.deepEqual(stored.transcription,before.transcription);assert.deepEqual(stored.downloadAttempts,before.downloadAttempts);assert.equal(downloads,2);assert.equal(f.stats().calls,0);
});

test('authorized bounded cache reuse clears a stale download error without another provider call',async t=>{
 // Cached originals remain route-bound. An unauthorized read cannot clear the
 // error, while an authorized validated cache hit does not touch the provider.
 const f=await fixture(t,{rows:[message('cache',[attachment('pic','image')])]});
 const page=await f.hub.call('a','history',{connectionId:'a',conversationId:'one'}),id=page.items[0].attachments[0].fileId;
 const original=await f.hub.call('a','file_download',{fileId:id}),stored=f.hub.media.get(id);
 f.hub.media.save({...stored,downloadDiagnostic:{code:'upstream_unavailable',retryable:true},audit:{originalAttempt:'retained'}});
 const downloads=f.stats().downloads;
 await assert.rejects(f.hub.call('b','file_download',{fileId:id}),/not_authorized/);
 assert.equal(f.hub.media.get(id).downloadDiagnostic.code,'upstream_unavailable');
 const cached=await f.hub.call('a','file_download',{fileId:id});
 assert.equal(Object.hasOwn(cached,'downloadDiagnostic'),false);assert.equal(cached.path,original.path);assert.equal(cached.sha256,original.sha256);
 assert.deepEqual(f.hub.media.get(id).transcription,stored.transcription);assert.deepEqual(f.hub.media.get(id).audit,{originalAttempt:'retained'});assert.equal(f.stats().downloads,downloads);
});

test('empty or oversized new bytes keep a download failure rather than claiming recovery',async t=>{
 // A provider response is not success until the actual private file passes the
 // byte bounds; even a prior transient error cannot be cleared on invalid bytes.
 const f=await fixture(t,{rows:[]});f.hub.media.config.maxFileBytes=8;
 for(const size of [0,9]){
  const a={...attachment('invalid-'+size,'image'),size:1},record=f.hub.media.register('a',message('invalid-'+size,[a]),a);
  f.hub.media.save({...record,downloadDiagnostic:{code:'upstream_unavailable',retryable:true}});
  f.hub.instances.get('a').attachment=async()=>({base64:Buffer.alloc(size).toString('base64'),filename:'invalid.bin'});
  await assert.rejects(f.hub.call('a','file_download',{fileId:record.id}),e=>e.code==='file_size_limit');
  const stored=f.hub.media.get(record.id);assert.equal(stored.downloadDiagnostic.code,'file_size_limit');assert.equal(stored.path,undefined);assert.equal(stored.digest,undefined);
 }
});

test('missing or empty cached bytes retain their error and never invoke an implicit provider retry',async t=>{
 // A stale registry path must not turn a failed original into ready or silently
 // redownload it; recovery still requires a later independently valid operation.
 const f=await fixture(t,{rows:[]});
 for(const exists of [false,true]){
  const a=attachment('cache-'+exists,'image'),record=f.hub.media.register('a',message('cache-'+exists,[a]),a),filename=path.join(f.root,'invalid-cache-'+exists);
  if(exists)await writeFile(filename,Buffer.alloc(0));
  f.hub.media.save({...record,path:filename,downloadDiagnostic:{code:'upstream_unavailable',retryable:true}});
  await assert.rejects(f.hub.call('a','file_download',{fileId:record.id}));
  assert.equal(f.hub.media.get(record.id).downloadDiagnostic.code,'upstream_unavailable');
 }
 assert.equal(f.stats().downloads,0);
});

test('staged media is scope-bound and unchanged retries never upload again',async t=>{
 // Real local bytes, fake sender: traversal and changed file contents fail before a second send.
 const f=await fixture(t);let sends=0;f.hub.config.scopes.a.connections.a.send=true;
 const instance=f.hub.instances.get('a');instance.capabilities.sendAttachments=true;instance.sendMedia=async()=>{sends++;return {status:'sent',messageId:'media1'};};
 const uploadRoot=f.hub.outbound.uploadRoot('a');await mkdir(uploadRoot,{recursive:true});const file=path.join(uploadRoot,'report.pdf');await writeFile(file,'%PDF-test');
 const v={connectionId:'a',conversationId:'one',requestId:'file1',localPath:file,type:'document',caption:'Report',replyTo:null};
 const first=await f.hub.call('a','send_media',v);assert.equal(first.status,'sent');assert.equal(first.confirmation,'provider_sent');
 await f.hub.call('a','send_media',v);assert.equal(sends,1);
 await writeFile(file,'%PDF-changed');await assert.rejects(f.hub.call('a','send_media',v),/idempotency_conflict/);assert.equal(sends,1);
 await assert.rejects(f.hub.call('a','media_stage',{connectionId:'a',conversationId:'one',localPath:'/etc/passwd',type:'document'}),/upload_path_denied/);
});

test('attachment provider failures expose distinct safe categories without private response text',async()=>{
 // A 404 is absence, not proof of retention expiry; 410 is explicitly gone.
 const {Upstream}=await import('../src/upstream.mjs');
 for(const [detail,code] of [['download status code 404','attachment_not_found'],['download status code 410','attachment_gone'],['media expired','attachment_expired'],['bad MAC decrypt failed','attachment_decryption_failed'],['HTTP 403 forbidden','attachment_permission_denied'],['HTTP 503 timeout','attachment_temporarily_unavailable']]){
  const u=new Upstream({});u.pending=Promise.resolve({callTool:async()=>({isError:true,content:[{type:'text',text:detail+' secret-url-and-token'}]})});
  await assert.rejects(u.call('whatsapp_message',{action:'download_media'}),e=>e.code===code&&!e.message.includes('secret'));
 }
});

test('progressive Telegram photo metadata identifies the exact largest downloadable variant',()=>{
 // A smaller PhotoSize must not win over progressive cumulative byte sizes.
 const a=telegramMedia("MessageMediaPhoto(photo=Photo(id=123, sizes=[PhotoSize(type='m', size=1085), PhotoSizeProgressive(type='x', w=640, h=240, sizes=[781, 1011, 1680, 2069, 3130])]))",'9');
 assert.equal(a.size,3130);assert.equal(a.sizeVariant,'largest');assert.equal(a.downloadVariant,'largest');
});
test('cached file normalization preserves provider name and bytes when MIME disagrees with extension',async t=>{
 // Old cached PNG files named .jpg must become usable without another provider download.
 const f=await fixture(t);const a=attachment('picture','image');a.filename='provider.jpg';
 const record=f.hub.media.register('a',message('pic',[a]),a),file=path.join(f.root??f.hub.media.root,'cached.jpg');
 await writeFile(file,Buffer.from('89504e470d0a1a0a0000','hex'));
 f.hub.media.save({...record,path:file,filename:'provider.jpg',size:10,mimeType:'image/png',mimeDetected:true,digest:'same-hash'});
 const result=await f.hub.call('a','file_download',{fileId:record.id});
 assert.equal(result.filename,'provider.png');assert.equal(result.originalFilename,'provider.jpg');assert.match(result.path,/\.png$/);assert.equal(result.sha256,'same-hash');assert.equal((await readFile(result.path)).length,10);
});

test('serialized history budget pages every message once and binds opaque cursors to route/options',async t=>{
 // Native pagination offsets must not advance over messages excluded solely by the JSON budget.
 const f=await fixture(t,{rows:[]}),all=Array.from({length:13},(_,i)=>message(String(i+1),[],('Escaped " line\n').repeat(30)));
 let calls=0;f.hub.instances.get('a').history=async v=>{calls++;const offset=Number(v.cursor??0),items=all.slice(offset,offset+v.limit);return {items,next:offset+v.limit<all.length?String(offset+v.limit):null,complete:offset+v.limit>=all.length};};
 const options={connectionId:'a',conversationId:'one',mode:'compact',limit:5,maxResponseChars:1000,maxTotalChars:1000};
 let cursor=null,seen=[],first;
 do{const r=await f.hub.call('a','history',{...options,cursor});assert.ok(resultChars(r)<=1000);assert.ok(r.items.length);seen.push(...r.items.map(m=>m.id));first??=r;cursor=r.next;}while(cursor);
 assert.deepEqual(seen,all.map(m=>m.id));assert.equal(calls,3);
 await assert.rejects(f.hub.call('a','history',{...options,cursor:first.next,conversationId:'other'}),/not_authorized/);
 await assert.rejects(f.hub.call('a','history',{...options,cursor:first.next,maxResponseChars:1200}),/cursor_invalid/);
 const replay=await f.hub.call('a','history',{...options,cursor:first.next});assert.equal(replay.items[0].id,'2');
});
test('one large attachment envelope uses an explicit full-message handle instead of violating budget',async t=>{
 // Even metadata alone can exceed the budget; a large filename must not stall continuation forever.
 const f=await fixture(t,{rows:[message('large',[{...attachment('pic','image'),filename:'x'.repeat(1800)}],'"\n'.repeat(1500)),message('next',[],'ok')]});
 const options={connectionId:'a',conversationId:'one',mode:'compact',maxResponseChars:1000,attachmentTypes:['image']};
 const r=await f.hub.call('a','history',options);assert.ok(resultChars(r)<=1000);assert.equal(r.items[0].id,'large');assert.equal(r.items[0].detailsOmitted,true);assert.equal(r.items[0].textTruncated,true);assert.equal(r.next,null);
 const full=await f.hub.call('a','message_get',{connectionId:'a',conversationId:'one',messageId:'large'});assert.equal(full.message.text.length,3000);
});

test('response cursor survives reopening its SQLite store and cannot cross scopes',async t=>{
 // A service restart must preserve unreturned rows, including the original provider cursor.
 const {DatabaseSync}=await import('node:sqlite'),{ResponsePages}=await import('../src/response-pages.mjs');
 const f=await fixture(t,{rows:[message('first',[],'x'.repeat(900)),message('second',[],'y'.repeat(900))]});
 const filename=path.join(f.hub.media.root,'pager-test.sqlite');let db=new DatabaseSync(filename),pager=new ResponsePages(f.hub,db);
 const v={connectionId:'a',conversationId:'one',cursor:null,limit:100,mode:'compact',maxResponseChars:1000};
 const first=await pager.history('a',v);assert.ok(first.next);db.close();
 db=new DatabaseSync(filename);t.after(()=>db.close());pager=new ResponsePages(f.hub,db);
 // Permit the route in both scopes: isolation must come from the cursor as well as access checks.
 f.hub.config.scopes.b.connections.a=f.hub.config.scopes.a.connections.a;
 await assert.rejects(pager.history('b',{...v,cursor:first.next}),/cursor_invalid/);
 const second=await pager.history('a',{...v,cursor:first.next});assert.equal(second.items[0].id,'second');assert.equal(second.next,null);
 db.prepare('UPDATE history_pages SET expires=0').run();await assert.rejects(pager.history('a',{...v,cursor:first.next}),/cursor_expired/);
});


test('long MTS call keeps full Palatine text and speaker evidence in file/context without truncation',async t=>{
 // An hour recording is beyond the ordinary voice limit, but within the explicit call purpose limit.
 const f=await fixture(t,{rows:[{...message('call',[attachment('recording')],null),kind:'call'}]});
 f.hub.media.probe=async()=>({duration:3600,hasAudio:true});
 f.hub.media.palatine.transcribeResult=async()=>({text:'speech '.repeat(20000),segments:[{speaker:'S1',speakerUncertain:true,start:0,end:3600,text:'full available speech'}],speakerAttribution:'provider_unverified'});
 const r=await f.hub.call('a','history',{connectionId:'a',conversationId:'one'}),a=r.items[0].attachments[0];
 assert.equal(a.transcription.status,'ready');assert.equal(a.transcription.source,'palatine');assert.equal(a.transcription.text.length,140000);assert.equal(a.transcription.segments[0].speakerUncertain,true);
 const file=await f.hub.call('a','file_download',{fileId:a.fileId});assert.equal(file.transcription.text.length,140000);assert.equal(file.transcription.speakerAttribution,'provider_unverified');
});


test('failed Palatine voice explicitly retries via CodexLB preserving file and exposes late full reads',async t=>{
 // Installation keeps failed receipts; retry reuses cached audio and original IDs.
 const f=await fixture(t,{rows:[message('switch',[attachment('voice')])]});const first=await f.hub.call('a','history',{connectionId:'a',conversationId:'one'}),id=first.items[0].attachments[0].fileId;
 f.hub.media.save({...f.hub.media.get(id),transcription:{source:'palatine',status:'failed',text:null,error:'palatine_http_400'}});
 let calls=0;f.hub.media.asrProvider='codexlb';f.hub.media.config.codexlb={keyFile:'/synthetic'};f.hub.media.codexlb={transcribeResult:async()=>{calls++;return {text:'New complete speech',speakerAttribution:'unavailable'};}};
 const failed=await f.hub.call('a','transcription_status',{fileId:id});assert.equal(failed.transcription.error,'palatine_http_400');assert.equal(failed.transcription.diagnostic.canRetryUsingCurrentProvider,true);assert.equal(failed.transcription.diagnostic.currentProvider,'codexlb');assert.equal(calls,0);
 const done=await f.hub.call('a','transcribe_media',{fileId:id,retry:true,waitMs:1000});assert.equal(done.transcription.status,'ready');assert.equal(done.transcription.source,'codexlb');assert.equal(done.fileId,id);assert.equal(f.stats().downloads,1);assert.equal(calls,1);
 const h=await f.hub.call('a','history',{connectionId:'a',conversationId:'one'});assert.equal(h.items[0].attachments[0].transcription.text,'New complete speech');assert.equal(h.items[0].attachments[0].fileId,id);
 await f.hub.call('a','transcribe_media',{fileId:id,retry:true});assert.equal(calls,1);
});

test('Telegram unavailable originals retain precise cause on both read APIs',async()=>{
 // A cached media descriptor is not proof that Telegram still supplies bytes.
 // Explicit no-media never becomes a permission error or a fabricated success.
 const {default:telegram}=await import('../src/plugins/telegram.mjs');
 const plugin=telegram.create({mediaRoot:'/unused',upstreamClient:{call:async()=> 'No media found in the specified message.'}});
 const input={conversationId:'one',messageId:'42',attachmentId:'message:42',maxBytes:1024};
 for(const api of ['attachmentFile','attachment'])await assert.rejects(plugin[api](input),e=>e.code==='attachment_unavailable'&&e.details.providerEvidence==='no_media_in_message');
 const unknown=telegram.create({mediaRoot:'/unused',upstreamClient:{call:async()=> 'unexpected reply'}});
 await assert.rejects(unknown.attachmentFile(input),e=>e.code==='download_failed');
});

test('explicit empty video recognition stays terminal through retry, history and cached status',async t=>{
 // The failed original is retried once; no empty speech is appended to captions
 // and a repeated explicit call must not pay for a second recognition.
 const f=await fixture(t,{rows:[message('empty',[attachment('v','video')])]});
 const h=await f.hub.call('a','history',{connectionId:'a',conversationId:'one'}),id=h.items[0].attachments[0].fileId;
 let calls=0;f.hub.media.asrProvider='codexlb';f.hub.media.config.codexlb={keyFile:'/synthetic'};f.hub.media.codexlb={transcribeResult:async()=>{calls++;return {text:null,outcome:'no_transcript',evidence:'provider_empty_text',speechPresence:'unknown',speakerAttribution:'unavailable'};}};
 f.hub.media.save({...f.hub.media.get(id),transcription:{status:'failed',text:null,source:'codexlb',error:'asr_empty_response'}});
 const done=await f.hub.call('a','transcribe_media',{fileId:id,retry:true,waitMs:1000});
 assert.equal(done.transcription.status,'no_transcript');assert.equal(done.transcription.speechPresence,'unknown');assert.equal(done.transcription.text,null);assert.equal(done.transcription.error,undefined);
 const digest=done.sha256;await f.hub.call('a','transcribe_media',{fileId:id,retry:true});assert.equal(calls,1);
 const read=await f.hub.call('a','history',{connectionId:'a',conversationId:'one'});assert.equal(read.items[0].text,'caption');assert.equal(read.items[0].attachments[0].transcription.status,'no_transcript');
 const status=await f.hub.call('a','transcription_status',{fileId:id});assert.equal(status.sha256,digest);assert.equal(status.fileId,id);assert.equal(status.transcription.source,'codexlb');
});


test('MCP fileId image view and source attachment IDs share exact scoped registry binding',async t=>{
 // Reproduce the agent's ID confusion with synthetic pixels through real MCP protocol.
 // No private screenshot, real provider, model or send is involved.
 const f=await fixture(t,{rows:[message('3',[{...attachment('message:3','image'),mimeType:'image/png',filename:'pixel.png'}])]});
 const pixels='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=';
 let providerCalls=0;f.hub.instances.get('a').attachment=async v=>{providerCalls++;if(v.attachmentId!=='message:3')throw new HubError('attachment_mismatch');return {base64:pixels,mimeType:'image/png',filename:'pixel.png'};};
 const page=await f.hub.call('a','history',{connectionId:'a',conversationId:'one'}),fileId=page.items[0].attachments[0].fileId;
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair(),server=createMcp(f.hub,'a'),client=new Client({name:'regression',version:'1'});
 await server.connect(serverTransport);await client.connect(clientTransport);t.after(async()=>{await client.close();await server.close();});
 const route={connectionId:'a',conversationId:'one',messageId:'3'};
 const correct=await client.callTool({name:'messenger_attachment',arguments:{...route,attachmentId:'message:3'}});
 assert.equal(correct.content.find(x=>x.type==='image').data,pixels);assert.equal(correct.structuredContent.base64,undefined);
 const confused=await client.callTool({name:'messenger_attachment',arguments:{...route,attachmentId:fileId}});
 assert.equal(confused.content.find(x=>x.type==='image').data,pixels);assert.equal(confused.isError,undefined);
 const count=providerCalls;
 const viewed=await client.callTool({name:'messenger_file_download',arguments:{fileId}});
 assert.equal(viewed.content.find(x=>x.type==='image').data,pixels);assert.equal(viewed.structuredContent.imagePreview.status,'inline');assert.equal(providerCalls,count);
 assert.equal(viewed.content.filter(x=>x.type==='text').some(x=>x.text.includes(pixels)),false);assert.equal(JSON.stringify(viewed.structuredContent).includes(pixels),false);
 const wrong=await client.callTool({name:'messenger_attachment',arguments:{...route,attachmentId:'00000000-0000-4000-8000-000000000000'}});
 const detail=JSON.parse(wrong.content[0].text);assert.equal(wrong.isError,true);assert.equal(detail.diagnostic.category,'input_error');assert.equal(detail.diagnostic.retryable,false);assert.match(detail.diagnostic.nextAction,/messenger_file_download/);assert.match(detail.diagnostic.nextAction,/Do not ask the sender/);
 const beforeDenied=providerCalls;
 await assert.rejects(f.hub.call('b','file_download',{fileId}),/not_authorized/);
 await assert.rejects(f.hub.call('b','attachment',{...route,attachmentId:fileId}),/not_authorized/);
 f.hub.config.scopes.a.connections.a.conversations.push('two');
 await assert.rejects(f.hub.call('a','attachment',{...route,conversationId:'two',attachmentId:fileId}),/attachment_route_mismatch/);
 await assert.rejects(f.hub.call('a','attachment',{...route,messageId:'different',attachmentId:fileId}),/attachment_route_mismatch/);
 assert.equal(providerCalls,beforeDenied);
 const schema=(await client.listTools()).tools.find(x=>x.name==='messenger_attachment');assert.match(schema.inputSchema.properties.attachmentId.description,/attachments\[\].id/);assert.match(schema.inputSchema.properties.attachmentId.description,/NOT/);
});

test('missing media quote is omitted once and its effective route survives delivery checks',async t=>{
 // No real provider writes: a cached/staged document retains its exact bytes,
 // recipient and request ID even when the requested quote was deleted/absent.
 const f=await fixture(t);f.hub.config.scopes.a.connections.a.send=true;
 const seen=[],instance=f.hub.instances.get('a');instance.capabilities.sendAttachments=true;
 instance.sendMedia=async v=>{seen.push(v);return {status:'unknown',messageId:null};};
 instance.reconcileMedia=async v=>{assert.equal(v.replyTo,null);return {status:'sent',messageId:'doc1'};};
 const root=f.hub.outbound.uploadRoot('a');await mkdir(root,{recursive:true});const file=path.join(root,'test.pdf');await writeFile(file,'%PDF-synthetic');
 const v={connectionId:'a',conversationId:'one',requestId:'quote-missing',localPath:file,type:'document',replyTo:'absent'};
 const first=await f.hub.call('a','send_media',v);assert.equal(first.status,'unknown');assert.equal(first.replyFallback.reason,'reply_target_unavailable');assert.equal(first.replyTo,null);assert.equal(first.replyVerification,'not_requested');
 const done=await f.hub.call('a','media_delivery',v);assert.equal(done.status,'sent');await f.hub.call('a','send_media',v);assert.equal(seen.length,1);assert.equal(seen[0].conversationId,'one');assert.equal(seen[0].replyTo,null);
});

test('slow file returns pending, joins one transfer, and later exposes verified ready bytes',async t=>{
 // A stalled transfer outlives a tool wait but not its durable media identity.
 // Fake transport release simulates a minutes-long Telegram download instantly.
 const f=await fixture(t);let release,writes=0;const gate=new Promise(r=>release=r);
 f.hub.instances.get('a').attachment=async()=>{writes++;await gate;return {base64:Buffer.from('original').toString('base64'),filename:'video.mp4',mimeType:'video/mp4'};};
 const a=attachment('slow','video'),file=f.hub.media.register('a',message('slow',[a]),a);
 try{
 const pending=await f.hub.call('a','file_download',{fileId:file.id,waitMs:1});assert.equal(pending.status,'downloading');assert.equal(pending.path,null);assert.equal(pending.download.status,'running');assert.ok(!pending.downloadDiagnostic);
 const joined=await f.hub.call('a','file_download',{fileId:file.id,waitMs:0});assert.equal(joined.status,'downloading');assert.equal(writes,1);
 await assert.rejects(f.hub.call('b','file_download',{fileId:file.id,waitMs:0}),/not_authorized/);assert.equal(writes,1);
 release();const ready=await f.hub.call('a','file_download',{fileId:file.id});assert.equal(ready.status,'ready');assert.equal(ready.size,8);assert.equal(ready.download.status,'ready');assert.match(ready.sha256,/^[a-f0-9]{64}$/);assert.equal(writes,1);
 assert.equal((await f.hub.call('a','file_download',{fileId:file.id,waitMs:0})).status,'ready');assert.equal(f.stats().calls,0);
 }finally{release();}
});

test('pending download failure remains specific and restart does not auto-admit abandoned reads',async t=>{
 // A lost daemon cannot leave a permanent running flag or restart all private
 // provider fetches. Explicit read may retry; cached history never does.
 const f=await fixture(t);const a=attachment('restart','video'),file=f.hub.media.register('a',message('restart',[a]),a);
 f.hub.media.save({...file,download:{status:'running',startedAt:'2026-10-21T00:00:00Z'}});
 const {MediaService}=await import('../src/media.mjs');const second=new MediaService(f.hub,f.hub.media.config,{});
 try{assert.equal(second.get(file.id).download.status,'interrupted');assert.equal(second.downloads.size,0);assert.equal(f.stats().downloads,0);}finally{await second.close();}
 let release;const gate=new Promise(r=>release=r);f.hub.instances.get('a').attachment=async()=>{await gate;throw new HubError('attachment_expired');};
 assert.equal((await f.hub.call('a','file_download',{fileId:file.id,waitMs:1})).status,'downloading');release();
 await new Promise(r=>setImmediate(r));assert.equal(f.hub.media.get(file.id).download.status,'failed');assert.equal(f.hub.media.get(file.id).downloadDiagnostic.code,'attachment_expired');
});

test('history inspection can opt out of new ASR while keeping attachment registration',async t=>{
 // Acceptance/backfill must not bill every old voice just to inspect pagination.
 const f=await fixture(t);const p=await f.hub.call('a','history',{connectionId:'a',conversationId:'one',transcribeAudio:false,readMode:'refresh'});
 assert.ok(p.items[0].attachments[0].fileId);assert.equal(f.stats().calls,0);assert.equal(f.stats().downloads,0);assert.equal(p.items[0].attachments[0].transcription.status,'not_started');
});
