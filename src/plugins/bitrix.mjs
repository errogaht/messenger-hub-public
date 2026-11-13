import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {HubError} from '../contracts.mjs';

/** One portal per connection; SSH root/actor are administrator settings, never agent parameters. */
export async function remote(settings,operation,input,attempt=0){
 if(!settings.root?.startsWith('/')||!Number.isSafeInteger(settings.actorId)||settings.actorId<1)throw new HubError('bitrix_config_invalid');
 const write=['send','reply','preflight'].includes(operation);
 const template=await readFile(new URL(write?'./bitrix-writer.php':'./bitrix-reader.php',import.meta.url),'utf8');
 const payload={...input,operation,root:settings.root,actorId:settings.actorId,host:settings.host};
 // The fence ships in this exact reviewed stdin program; no remote code install.
 const fence=write?(await readFile(new URL('./bitrix-send-fence.php',import.meta.url),'utf8')).replace(/^<\?php\s*/, ''):'';
 const source=template.replace('/*__HUB_SEND_FENCE__*/',fence).replace('__HUB_PAYLOAD__',Buffer.from(JSON.stringify(payload)).toString('base64'));
 return new Promise((resolve,reject)=>{
  const child=spawn(settings.sshCommand,[...(settings.sshArgs??[]),'--argv',settings.php??'php8.2'],{cwd:settings.cwd,stdio:['pipe','pipe','ignore']});
  let length=0;const chunks=[];let done=false;
  const timer=setTimeout(()=>{child.kill();finish(new HubError('portal_timeout'));},60000);
  function finish(error,result){if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result);}
  child.stdout.on('data',chunk=>{length+=chunk.length;if(length>36*1024*1024){child.kill();finish(new HubError('portal_response_too_large'));}else chunks.push(chunk);});
  child.on('error',()=>finish(new HubError('portal_unavailable')));child.stdin.on('error',()=>{});
  child.on('close',(exitCode)=>{try{const r=JSON.parse(Buffer.concat(chunks).toString());if(!r.ok){finish(portalError(r,operation));return;}finish(null,r);}catch{
    // One retry is safe only for read-only operations with no returned bytes.
    // Never replay send/reply: the missing response may hide a completed write.
    if(exitCode===255&&length===0&&attempt===0&&!['send','reply'].includes(operation)){
     done=true;clearTimeout(timer);remote(settings,operation,input,1).then(resolve,reject);return;
    }
    finish(new HubError(exitCode===255?'portal_transport_failed':'portal_response_invalid',{provider:'bitrix',providerStage:operation,exitCode,outputBytes:length}));
   }});
  child.stdin.end(source);
 });
}
/** Accept only reviewed portal codes; native exceptions and paths never leave the bridge.
 * A structured pre-write refusal proves failed; missing/invalid output is unknown. */
export function portalError(result,operation){
 const allowed=new Set(['chat_access_denied','actor_unavailable','operation_unsupported','attachment_not_in_message','attachment_unavailable','attachment_path_denied','portal_read_failed','portal_bootstrap_failed','chat_unavailable','reply_target_unavailable','request_id_conflict','portal_write_failed','portal_receipt_unconfirmed','private_peer_unavailable','request_invalid','portal_send_ambiguous','portal_recovery_storage_unavailable']);
 const reason=allowed.has(result.error)?result.error:'portal_rejected';
 return new HubError(reason,{provider:'bitrix',providerStage:result.stage??operation,
  ...(result.message_created===false?{messageCreated:false}:{}),
  ...(result.message_created===true?{messageCreated:true}:{}),
  ...(Number.isSafeInteger(result.message_id)&&result.message_id>0?{candidateMessageId:String(result.message_id)}:{})});
}
export default {id:'bitrix',contractVersion:1,create(settings){
 const call=settings.remote??((op,input)=>remote(settings,op,input));
 const numeric=value=>{const n=Number(value);if(!/^[1-9]\d*$/.test(String(value))||!Number.isSafeInteger(n))throw new HubError('bitrix_identity_invalid');return n;};
 return {capabilities:{history:true,send:true,attachments:true,changes:false,kinds:['message'],maxText:20000},
 async health(){const r=await call('list',{limit:1,offset:0,query:''});return {available:true,checked:'portal_actor',actorId:String(settings.actorId),...(r.actor?{actor:r.actor}:{}),identityContract:'conversationId is b_im_chat.ID; private native dialog uses the verified peer user ID',access:'actor_membership_required'};},
 async conversations({query,cursor,limit}){
  const offset=cursor?Number(cursor):0;if(!Number.isSafeInteger(offset)||offset<0)throw new HubError('cursor_invalid');
  const r=await call('list',{query,offset,limit});
  return {items:r.chats.map(x=>({id:String(x.ID),title:x.TYPE==='P'?(x.PEER_NAME||`User dialog ${x.ID}`):(x.TITLE||`Chat ${x.ID}`),kind:x.TYPE==='P'?'direct':'group',canSend:true})).filter(x=>!query||`${x.title} ${x.id}`.toLowerCase().includes(query.toLowerCase())),next:r.chats.length===limit?String(offset+limit):null};
 },
 async history({conversationId,cursor,limit}){
  const r=await call('history',{chatId:numeric(conversationId),...(cursor?{before:numeric(cursor)}:{}),limit});
  const items=r.messages.map(x=>({id:String(x.id),conversationId,kind:'message',direction:x.author_id===settings.actorId?'outbound':'inbound',senderId:String(x.author_id),...(x.author_name?{authorLabel:String(x.author_name).slice(0,500)}:{}),at:new Date(x.created_at.replace(' ','T')+(settings.timezoneOffset??'+03:00')).toISOString(),text:x.text,replyTo:x.reply_to_message_id?String(x.reply_to_message_id):null,attachments:x.attachments.map(a=>({id:String(a.attachment_id),kind:a.mime_type?.startsWith('image/')?'image':a.mime_type?.startsWith('audio/')?'audio':a.mime_type?.startsWith('video/')?'video':'document',filename:a.name,mimeType:a.mime_type,size:a.size}))}));
  return {items,next:items.length===limit?items.at(-1).id:null,complete:items.length<limit,order:'numeric'};
 },
 async send(v){const r=await call(v.replyTo?'reply':'send',{chatId:numeric(v.conversationId),text:v.text,request_id:v.requestId,...(v.replyTo?{reply_to_message_id:numeric(v.replyTo)}:{})});return {status:'sent',messageId:String(r.message.id)};},
 /** An explicit same-request send retry uses the same fenced native writer.
  * Delivery/reconcile never calls this; no transport failure is auto-replayed. */
 async resumeSend(v){return this.send(v);},
 /** UUID lookup verifies the original write without invoking the writer or sending again. */
 async reconcile(v){const r=await call('receipt',{chatId:numeric(v.conversationId),request_id:v.requestId,text:v.text,reply_to_message_id:v.replyTo?numeric(v.replyTo):null});return r.message?{status:'sent',messageId:String(r.message.id)}:{status:'unknown',messageId:null};},
 async attachment(v){return (await call('attachment',{chatId:numeric(v.conversationId),messageId:numeric(v.messageId),attachmentId:numeric(v.attachmentId)})).attachment;}
 };
}};
