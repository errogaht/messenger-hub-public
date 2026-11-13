import path from "node:path";
import {test} from 'node:test';
import assert from 'node:assert/strict';
import telegram,{parseHistory,hasRichStructure} from '../src/plugins/telegram.mjs';
import bitrix from '../src/plugins/bitrix.mjs';
import whatsapp from '../src/plugins/whatsapp.mjs';
import {page} from '../src/contracts.mjs';

test('Telegram formatting preserves first character, newlines, replies and media',()=>{
 const r=parseHistory('ID: 10 | Sender: User [id=4] | Date: 2026-09-27T00:00:00+00:00 | reply to 8 | 📎 photo | Message: Hello\\nworld','22','4');
 assert.equal(r[0].text,'Hello\nworld');assert.equal(r[0].replyTo,'8');assert.equal(r[0].direction,'outbound');assert.equal(r[0].attachments[0].kind,'image');
 assert.throws(()=>parseHistory('unexpected format','22','4'),/history_shape/);
});
test('Bitrix configuration selects actor and portal while any permitted chat can be passed',async()=>{
 const calls=[];const p=bitrix.create({actorId:11,remote:async(op,args)=>{calls.push({op,args});return {messages:[{id:1,author_id:12,created_at:'2026-09-27 01:00:00',text:'ok',reply_to_message_id:8,attachments:[]}]};}});
 for(const conversationId of ['50','60']){const r=await p.history({conversationId,cursor:null,limit:10});page.parse(r);assert.equal(r.items[0].conversationId,conversationId);}
 assert.deepEqual(calls.map(x=>x.args.chatId),[50,60]);
 await assert.rejects(p.history({conversationId:'0; DROP TABLE',cursor:null,limit:10}),/identity_invalid/);
});
test('WhatsApp rejects a history row from another chat before normalization',async()=>{
 const p=whatsapp.create({upstreamClient:{call:async()=>({data:[{chat_jid:'222@s.whatsapp.net'}]})}});
 await assert.rejects(p.history({conversationId:'111@s.whatsapp.net',cursor:null,limit:10}),/route_mismatch/);
});

test('Telegram reply uses the exact chat and accepts only unique post-send evidence',async()=>{
 // No network: a synthetic upstream proves reply routing and prevents success on ambiguous matching rows.
 for(const duplicate of [false,true]){
  let sent=false;const calls=[];
  const line=(id,text,reply='')=>`ID: ${id} | Sender: Me [id=4] | Date: 2026-09-27T00:00:00+00:00${reply} | Message: ${text}`;
  const upstream={call:async(name,args)=>{
   calls.push({name,args});
   if(name==='get_messages')return sent?[line(11,'answer',' | reply to 8'),...(duplicate?[line(12,'answer',' | reply to 8')]:[]),line(8,'original')].join('\n'):line(8,'original');
   sent=true;return 'accepted';
  }};
  const p=telegram.create({selfId:'4',upstreamClient:upstream});
  const r=await p.send({conversationId:'22',requestId:'synthetic-request',text:'answer',replyTo:'8'});
  assert.equal(r.status,duplicate?'unknown':'sent');
  assert.deepEqual(calls.find(x=>x.name==='reply_to_message').args,{chat_id:'22',message_id:8,text:'answer'});
 }
});

test('WhatsApp confirms the provider ID in the selected conversation',async()=>{
 // A positive send response alone is insufficient; its exact ID/text must reappear in this chat.
 let sent=false;const calls=[];const jid='111@s.whatsapp.net';
 const p=whatsapp.create({upstreamClient:{call:async(name,args)=>{
  calls.push({name,args});if(name==='whatsapp_send'){sent=true;return {message_id:'new'};}
  return {data:sent?[{id:'new',chat_jid:jid,is_from_me:true,sender_jid:jid,timestamp:'2026-09-27T00:00:00Z',content:'answer'}]:[]};
 }}});
 assert.deepEqual(await p.send({conversationId:jid,text:'answer',replyTo:null,requestId:'synthetic-request'}),{status:'sent',messageId:'new'});
 assert.equal(calls.find(x=>x.name==='whatsapp_send').args.phone,jid);
});

test('Bitrix write keeps portal-bound native chat and stable request identity',async()=>{
 const calls=[];const p=bitrix.create({actorId:11,remote:async(op,args)=>{calls.push({op,args});return {message:{id:99}};}});
 assert.deepEqual(await p.send({conversationId:'60',text:'answer',replyTo:'8',requestId:'same-request'}),{status:'sent',messageId:'99'});
 assert.deepEqual(calls,[{op:'reply',args:{chatId:60,text:'answer',request_id:'same-request',reply_to_message_id:8}}]);
});

test('native Telegram rich send/reply verifies correlated ID and nonpartial blocks, never raw markup equality',async()=>{
 // Rendered text differs from source. Only the exact returned ID in this chat proves delivery.
 for(const mode of ['rich_markdown','rich_html'])for(const issue of [null,'partial','sender','reply','lost','missing','wrong-id']){
  const calls=[];const replyTo=mode==='rich_html'?'8':null;
  const p=telegram.create({selfId:'4',upstreamClient:{call:async(name,args)=>{
   calls.push({name,args});
   if(name==='get_messages')return 'ID: 8 | Sender: Me [id=4] | Date: 2026-09-27T00:00:00Z | Message: original';
   if(name==='get_message_context')return {results:[{id:issue==='wrong-id'?12:11,is_target:true,sender_id:issue==='sender'?9:4,reply_to:issue==='reply'?99:replyTo,text:'Rendered report',rich_message:issue==='missing'?undefined:{part:issue==='partial',blocks:[{_:'PageBlockParagraph'}]}}]};
   if(issue==='lost')throw new Error('connection lost');
   return {sent:true,format:mode,message_ids:[11]};
  }}});
  const result=await p.send({conversationId:'22',requestId:'rich-report',text:mode==='rich_html'?'<p>Report</p>':'**Report**',format:mode,replyTo});
  assert.equal(result.status,issue?'unknown':'sent');
  const writes=calls.filter(c=>['send_message','reply_to_message'].includes(c.name));assert.equal(writes.length,1);
  assert.equal(writes[0].args.parse_mode,mode);assert.equal(writes[0].args.chat_id,'22');
  if(replyTo)assert.equal(writes[0].args.message_id,8);
 }
});


test('rich table and collapsible details must survive as native blocks',()=>{
 // A provider ID alone must not hide a formatter downgrade that lost report structure.
 const html='<h2>Report</h2><details><summary>Checks</summary><table><tr><td>ok</td></tr></table></details>';
 assert.equal(hasRichStructure(html,'rich_html',[{_:'PageBlockParagraph'}]),false);
 assert.equal(hasRichStructure(html,'rich_html',[{_:'PageBlockHeading2'},{_:'PageBlockDetails',blocks:[{_:'PageBlockTable'}]}]),true);
 assert.equal(hasRichStructure('| A | B |\n| --- | --- |\n| a | b |','rich_markdown',[{_:'PageBlockParagraph'}]),false);
});

test('WhatsApp delayed history reconciles once without another write; duplicate text stays unknown',async()=>{
 // Provider response IDs have multiple shapes; read-only retry must recover the first accepted write.
 let sends=0,visible=false;const now=new Date().toISOString(),jid='111@s.whatsapp.net';
 const p=whatsapp.create({upstreamClient:{call:async(name)=>{
  if(name==='whatsapp_send'){sends++;return {results:{message:{id:'abc'}}};}
  return {data:visible?[{id:'abc',chat_jid:jid,is_from_me:true,timestamp:now,content:'hello'}]:[]};
 }}});
 let evidence={};const v={conversationId:jid,text:'hello',replyTo:null};
 assert.equal((await p.send(v,{checkpoint:e=>Object.assign(evidence,e)})).status,'unknown');
 visible=true;assert.deepEqual(await p.reconcile(v,evidence),{status:'sent',messageId:'abc'});assert.equal(sends,1);
 const duplicate=whatsapp.create({upstreamClient:{call:async()=>({data:['a','b'].map(id=>({id,chat_jid:jid,is_from_me:true,timestamp:now,content:'hello'}))})}});
 assert.equal((await duplicate.reconcile(v,{startedAt:now,beforeIds:[]})).status,'unknown');
});

test('WhatsApp media multipart carries local bytes/reply and verifies the returned ID without another send',async t=>{
 // The bridge's REST media path supports local uploads; no public URL or real WhatsApp write is used.
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');
 const root=await mkdtemp(tmpdir()+'/hub-wa-upload-');t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(root+'/image.jpg',Buffer.from('ffd8ff','hex'));
 let posted=false;const jid='111@s.whatsapp.net',seen=[];
 const p=whatsapp.create({upstream:{url:'http://127.0.0.1:8790/mcp'},deviceId:'fixed',upstreamClient:{call:async()=>({data:posted?[{id:'media',chat_jid:jid,is_from_me:true,timestamp:new Date().toISOString(),content:'caption',media_type:'image',reply_message_id:'original'}]:[{id:'original',chat_jid:jid,is_from_me:false,timestamp:new Date().toISOString(),content:'question'}]})},fetcher:async(url,options)=>{
  seen.push({url:String(url),reply:options.body.get('reply_message_id'),caption:options.body.get('caption'),size:options.body.get('image').size,device:options.headers['X-Device-Id']});posted=true;return new Response(JSON.stringify({results:{message_id:'media'}}));
 }});
 const v={conversationId:jid,path:root+'/image.jpg',filename:'image.jpg',type:'image',mimeType:'image/jpeg',caption:'caption',replyTo:'original'};
 assert.equal((await p.sendMedia(v)).status,'sent');assert.deepEqual(seen,[{url:'http://127.0.0.1:8790/send/image',reply:'original',caption:'caption',size:3,device:'fixed'}]);
});

test('Telegram local media adapter stages inside bridge roots and verifies caption/reply/ID',async t=>{
 // The Hub file must pass through the existing logged-in bridge and its allowed media root.
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');
 const root=await mkdtemp(tmpdir()+'/hub-tg-upload-');t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(root+'/report.pdf','%PDF-test');
 let writes=0,stagedPath;
 const p=telegram.create({selfId:'4',mediaRoot:root,upstreamClient:{call:async(name,args)=>{
  if(name==='get_messages')return 'ID: 8 | Sender: Me [id=4] | Date: 2026-09-27T00:00:00Z | Message: original';
  if(name==='send_media_with_receipt'){writes++;stagedPath=args.file_path;assert.match(stagedPath,/hub-outbox/);assert.equal(path.basename(stagedPath),'report.pdf');assert.equal(await readFile(stagedPath,'utf8'),'%PDF-test');assert.equal(args.media_type,'document');assert.equal(args.reply_to,8);return {sent:true,message_id:9};}
  if(name==='get_message_context')return {results:[{id:9,is_target:true,sender_id:4,reply_to:8,text:'caption'}]};
  if(name==='get_media_info')return "MessageMediaDocument(document=Document(id=99, mime_type='application/pdf', size=9))";
 }}});
 const result=await p.sendMedia({conversationId:'22',path:root+'/report.pdf',filename:'report.pdf',type:'document',caption:'caption',replyTo:'8'});
 assert.equal(result.status,'sent');assert.equal(result.messageId,'9');assert.equal(writes,1);await assert.rejects(readFile(stagedPath),/ENOENT/);
});

test('media readback separates confirmed submission from unavailable or mismatched quote evidence',async()=>{
 // Faithful GOWA 9.1 rows omit quote fields. Correlated provider IDs still prove submission.
 const jid='111@s.whatsapp.net';
 for(const quote of [undefined,null,'','original','wrong']){
  const p=whatsapp.create({upstreamClient:{call:async()=>({data:[{id:'media',chat_jid:jid,is_from_me:true,timestamp:new Date().toISOString(),content:'🎵 Audio',media_type:'audio',reply_message_id:quote}]})}});
  const r=await p.reconcileMedia({conversationId:jid,type:'voice',replyTo:'original'},{candidateId:'media'});
  assert.equal(r.status,'sent');assert.equal(r.replyVerification,quote==='original'?'confirmed':typeof quote==='string'?'mismatch':'unavailable');
  assert.equal((await p.reconcileMedia({conversationId:jid,type:'voice'},{candidateId:'another'})).status,'unknown');
 }
 const p=telegram.create({selfId:'4',upstreamClient:{call:async name=>name==='get_message_context'?{results:[{id:9,is_target:true,sender_id:4,text:'[empty]',reply_to:8}]}:"MessageMediaDocument(document=Document(id=99, mime_type='audio/ogg', size=90, attributes=[DocumentAttributeAudio(voice=True)]))"}});
 const r=await p.reconcileMedia({conversationId:'22',type:'voice',caption:'',replyTo:'8'},{candidateId:'9'});
 assert.equal(r.status,'sent');assert.equal(r.replyVerification,'confirmed');
});

test('Bitrix preserves explicit pre-write refusal but keeps interrupted writes uncertain',async()=>{
 // Only the streamed worker can attest that native Add was never entered.
 const {portalError}=await import('../src/plugins/bitrix.mjs');
 const denied=portalError({error:'chat_access_denied',stage:'permission_validation',message_created:false},'send');
 assert.equal(denied.code,'chat_access_denied');assert.equal(denied.details.messageCreated,false);
 const late=portalError({error:'portal_receipt_unconfirmed',message_created:true,message_id:99},'send');
 assert.equal(late.details.messageCreated,true);assert.equal(late.details.candidateMessageId,'99');
 assert.equal(portalError({error:'/secret native SQL'},'history').code,'portal_rejected');
 let sends=0;const p=bitrix.create({actorId:11,remote:async(op,args)=>{assert.equal(op,'receipt');assert.equal(args.chatId,60);return {message:{id:99}};}});
 assert.deepEqual(await p.reconcile({conversationId:'60',text:'answer',requestId:'original'}),{status:'sent',messageId:'99'});assert.equal(sends,0);
});

test('Bitrix may retry a blank interrupted read once, never a write or partial response',async t=>{
 // A local child simulates the pinned launcher; no authentication or portal is contacted.
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {remote}=await import('../src/plugins/bitrix.mjs');
 const root=await mkdtemp(tmpdir()+'/hub-bitrix-transport-');t.after(()=>rm(root,{recursive:true,force:true}));
 const script=root+'/fake.mjs';await writeFile(script,`import fs from 'node:fs';let input='';for await(const b of process.stdin)input+=b;const n=Number(fs.existsSync('count')?fs.readFileSync('count','utf8'):0)+1;fs.writeFileSync('count',String(n));if(n===1){if(fs.existsSync('partial'))process.stdout.write('{');process.exit(255);}process.stdout.write(JSON.stringify({ok:true}));`);
 const settings={root:'/synthetic',actorId:11,sshCommand:process.execPath,sshArgs:[script],cwd:root};
 assert.equal((await remote(settings,'history',{chatId:60})).ok,true);assert.equal(await readFile(root+'/count','utf8'),'2');
 await writeFile(root+'/count','0');await assert.rejects(remote(settings,'send',{chatId:60}),e=>e.code==='portal_transport_failed');assert.equal(await readFile(root+'/count','utf8'),'1');
 await writeFile(root+'/count','0');await writeFile(root+'/partial','yes');await assert.rejects(remote(settings,'history',{chatId:60}),e=>e.code==='portal_transport_failed');assert.equal(await readFile(root+'/count','utf8'),'1');
});

test('Telegram old quotes bypass bounded preflight; only a proven quote rejection allows fallback',async()=>{
 // Cached reply can be older than the adapter's100 messages. Race deletion may
 // reject it; exactly that known no-create rejection permits one unquoted write.
 const {HubError}=await import('../src/contracts.mjs');
 for(const failure of [null,'known','ambiguous']){
  let submitted=false;const writes=[],checkpoints=[];
  const upstream={close:async()=>{},call:async(name,args)=>{
   if(name==='get_messages')return submitted?'ID: 11 | Sender: Me [id=4] | Date: 2026-10-15T00:00:00Z'+(failure===null?' | reply to 8':'')+' | Message: answer':'';
   writes.push({name,args});
   if(name==='reply_to_message'&&failure)throw failure==='known'?new HubError('reply_target_invalid',{messageCreated:false}):new HubError('upstream_unavailable');
   submitted=true;return 'accepted';
  }};
  const p=telegram.create({selfId:'4',upstreamClient:upstream});const r=await p.send({conversationId:'22',replyTo:'8',text:'answer'},{checkpoint:x=>checkpoints.push(x)});
  assert.equal(writes.length,failure==='known'?2:1);assert.equal(writes[0].name,'reply_to_message');assert.equal(r.status,failure==='ambiguous'?'unknown':'sent');
  if(failure==='known'){assert.equal(writes[1].name,'send_message');assert.equal(checkpoints[0].effectiveReplyTo,null);assert.equal(writes[1].args.chat_id,'22');}
  await p.close();
 }
});

test('Telegram original download uses its own finite long read budget',async()=>{
 // Even when an outer MCP caller stops waiting, a50MB original gets a longer
 // read-only provider budget. No session replacement or send timeout changes.
 const p=telegram.create({mediaRoot:'/unused',upstreamClient:{call:async(name,args,options)=>{assert.equal(name,'download_media');assert.equal(args.message_id,9);assert.equal(options.timeoutMs,600000);throw new Error('fixture stop before filesystem');}}});
 await assert.rejects(p.attachmentFile({conversationId:'22',messageId:'9',attachmentId:'message:9',maxBytes:100}),/fixture stop/);
});
