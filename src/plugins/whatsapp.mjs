import {markerEmoji} from '../message-markers.mjs';
import {historySearch} from '../history-search.mjs';
import {readFile} from 'node:fs/promises';
import {Upstream} from '../upstream.mjs';
import {HubError} from '../contracts.mjs';
import {boundedFile,boundedPath} from './files.mjs';
const root=r=>r?.results??r;
/** GOWA remains the only logged-in WhatsApp process; device selection is fixed per connection. */
export default {id:'whatsapp',contractVersion:1,create(settings){
 const upstream=settings.upstreamClient??new Upstream(settings.upstream),device=settings.deviceId?{device_id:settings.deviceId}:{};
 const history=async({conversationId,cursor,limit,query})=>{
  if(!/^(?:\d+@(?:s\.whatsapp\.net|lid)|\d+(?:-\d+)?@g\.us)$/.test(conversationId))throw new HubError('conversation_invalid');
  const offset=cursor===null?0:Number(cursor);if(!Number.isSafeInteger(offset)||offset<0)throw new HubError('cursor_invalid');
  const r=root(await upstream.call('whatsapp_chat',{action:'get_messages',chat_jid:conversationId,limit,offset,...(query?{search:query}:{}),...device}));
  if(!Array.isArray(r.data))throw new HubError('whatsapp_history_shape');
  const items=r.data.map(x=>{
   if(x.chat_jid!==conversationId)throw new HubError('provider_route_mismatch');
   return {id:x.id,conversationId,kind:'message',direction:x.is_from_me?'outbound':'inbound',isSelf:typeof x.is_from_me==='boolean'?x.is_from_me:null,senderId:x.sender_jid??(x.is_from_me?'owner':conversationId),...(x.sender_name||x.push_name?{authorLabel:String(x.sender_name||x.push_name).slice(0,500)}:{}),at:new Date(x.timestamp).toISOString(),text:x.content??'',replyTo:x.reply_message_id||x.quoted_message_id||null,replyToKnown:typeof x.reply_message_id==='string'||typeof x.quoted_message_id==='string',attachments:x.media_type?[{id:x.id,kind:x.media_type,filename:x.filename||null,mimeType:x.mime_type??null,size:x.file_length?Number(x.file_length):null}]:[]};
  });return {items,next:items.length===limit?String(offset+limit):null,complete:items.length<limit};
 };
 const attachmentFile=async v=>{
  if(v.attachmentId!==v.messageId)throw new HubError('attachment_mismatch');
  const r=root(await upstream.call('whatsapp_message',{action:'download_media',message_id:v.messageId,phone:v.conversationId,...device}));
  if(r.message_id&&String(r.message_id)!==v.messageId)throw new HubError('attachment_mismatch');
  const filename=r.file_path??r.path??r.data?.file_path;if(typeof filename!=='string')throw new HubError('download_failed');
  // GOWA emits storage-relative paths; only its media subtree is readable.
  const mediaRoot=settings.mediaRoot+'/statics/media';
  const absolute=filename.startsWith('/')?filename:settings.mediaRoot+'/'+filename;
  const result=await boundedPath(absolute,mediaRoot,v.maxBytes);
  if(r.file_size!=null&&Number(r.file_size)!==result.size)throw new HubError('attachment_size_mismatch');
  return result;
 };
 /** Confirm a bounded attempt by correlated ID, or unique new exact text in its time window. */
 const reconcile=async(v,evidence)=>{
  const start=Date.parse(evidence.startedAt);if(!Number.isFinite(start))return {status:'unknown',messageId:null};
  const matches=[];let cursor=null;
  for(let page=0;page<10;page++){
   const r=await history({...v,cursor,limit:100});
   for(const m of r.items){
    if(m.direction!=='outbound'||m.text!==v.text||m.replyTo!==(v.replyTo??null))continue;
    if(evidence.candidateId?m.id!==evidence.candidateId:(evidence.beforeIds??[]).includes(m.id)||Date.parse(m.at)<start-2000||Date.parse(m.at)>start+120000)continue;
    matches.push(m);
   }
   if(!r.next||r.items.some(m=>Date.parse(m.at)<start-2000))break;cursor=r.next;
  }
  return matches.length===1?{status:'sent',messageId:matches[0].id}:{status:'unknown',messageId:null};
 };
 const reconcileMedia=async(v,evidence)=>{
  if(!evidence.candidateId)return {status:'unknown',messageId:null};
  let cursor=null;
  for(let n=0;n<10;n++){
   const page=await history({...v,cursor,limit:100}),m=page.items.find(m=>m.id===evidence.candidateId);
   if(m){const expected=['voice','audio'].includes(v.type)?'audio':v.type;return m.direction==='outbound'&&m.attachments.some(a=>a.kind===expected||expected==='audio'&&['voice','ptt'].includes(a.kind))?{status:'sent',messageId:m.id,replyVerification:!v.replyTo?'not_requested':m.replyTo===v.replyTo?'confirmed':m.replyToKnown?'mismatch':'unavailable'}:{status:'unknown',messageId:null};}
   if(!page.next)break;cursor=page.next;
  }
  return {status:'unknown',messageId:null};
 };
 return {capabilities:{history:true,send:true,attachments:!!settings.mediaRoot,changes:false,kinds:['message'],maxText:4096,sendAttachments:!!settings.upstream?.url?.startsWith('http://127.0.0.1:'),mediaTypes:['image','document','voice','audio','video'],mediaCaptionTypes:['image','document','video'],mediaReply:true,mediaReplyReadback:settings.replyEvidence===true,maxUploadBytes:25*1024*1024},
 reconcileMedia,
 async markMessage(v,{submitting}){
  // Confirm source route/sender in provider storage before GOWA BuildReaction.
  // Never let its missing-message/group-sender heuristic choose a different peer.
  let cursor=null,found=false;for(let n=0;n<20;n++){const p=await history({...v,cursor,limit:100});if(p.items.some(m=>m.id===v.messageId)){found=true;break;}if(!p.next)break;cursor=p.next;}
  if(!found)throw new HubError('marker_message_not_in_window');submitting();
  const r=root(await upstream.call('whatsapp_message',{action:'react',phone:v.conversationId,message_id:v.messageId,emoji:markerEmoji[v.status],...device}));
  const id=r?.message_id??r?.id??r?.MessageID;if(typeof id!=='string'||!id)return {state:'unknown',confirmation:'unconfirmed'};
  return {state:'applied',emoji:markerEmoji[v.status],reactionMessageId:id,confirmation:'provider_accepted',readback:'unsupported'};
 },
 async sendMedia(v,{checkpoint=()=>{}}={}){
  // Submission confirmation is independent of quote verification: legacy GOWA rows
 // have no persisted ContextInfo and must not be mistaken for unsent messages.
 // Pinned GOWA 9.1 REST supports local multipart media + reply; its MCP only accepts URLs.
  // The URL/device are trusted connection settings, never supplied by the caller.
  const base=new URL(settings.upstream.url);if(base.protocol!=='http:'||base.hostname!=='127.0.0.1')throw new HubError('media_transport_not_local');
  if(['voice','audio'].includes(v.type)&&v.caption)throw new HubError('audio_caption_unsupported');
  // Optional quote resolution belongs to Hub; a bounded history page is not proof of absence.
  const kind=v.type==='document'?'file':['voice','audio'].includes(v.type)?'audio':v.type;
  const body=new FormData();body.set('phone',v.conversationId);body.set(kind,new Blob([await readFile(v.path)],{type:v.mimeType}),v.filename);
  if(v.caption)body.set('caption',v.caption);if(v.replyTo)body.set('reply_message_id',v.replyTo);
  if(v.type==='voice')body.set('ptt','true');if(v.type==='image')body.set('compress','false');
  const response=await (settings.fetcher??fetch)(new URL('/send/'+kind,base),{method:'POST',body,headers:settings.deviceId?{'X-Device-Id':settings.deviceId}:{},redirect:'error',signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new HubError('media_send_http_'+response.status);
  const r=root(await response.json()),id=r?.message_id??r?.id??r?.message?.id;
  if(typeof id!=='string'||!id)return {status:'unknown',messageId:null};checkpoint({candidateId:id});
  return reconcileMedia(v,{candidateId:id});
 },
 async health(){const r=root(await upstream.call('whatsapp_app',{action:'status',...device}));return {available:r.is_connected===true&&r.is_logged_in===true,checked:'provider',providerVersion:(await upstream.client?.())?.getServerVersion?.()?.version??null};},
 async conversations({query,cursor,limit}){
  const offset=cursor?Number(cursor):0;if(!Number.isSafeInteger(offset)||offset<0)throw new HubError('cursor_invalid');
  const r=root(await upstream.call('whatsapp_chat',{action:'list_chats',search:query,limit,offset,...device}));const rows=Array.isArray(r)?r:r.data??r.chats;if(!Array.isArray(rows))throw new HubError('whatsapp_chats_shape');
  return {items:rows.filter(x=>/^(?:\d+@(?:s\.whatsapp\.net|lid)|\d+(?:-\d+)?@g\.us)$/.test(x.jid??x.chat_jid??'')).map(x=>({id:x.jid??x.chat_jid,title:x.name??x.push_name??x.jid??x.chat_jid,kind:(x.jid??x.chat_jid).endsWith('@g.us')?'group':'direct',canSend:true})),next:rows.length===limit?String(offset+limit):null};
 },history,attachmentFile,search:historySearch(history),searchCoverage:'provider_history_unicode_search_plus_observed_audio',
 async contacts({query,limit,cursor}){const offset=cursor?Number(cursor):0;if(!Number.isSafeInteger(offset)||offset<0)throw new HubError('cursor_invalid');const r=root(await upstream.call('whatsapp_chat',{action:'list_contacts',...device}));const rows=Array.isArray(r)?r:r.data??r.contacts;if(!Array.isArray(rows))throw new HubError('whatsapp_contacts_shape');const items=rows.filter(x=>`${x.name??''} ${x.full_name??''} ${x.push_name??''} ${x.jid??x.JID??x.phone??''}`.toLowerCase().includes((/^\+?[\d ()-]{7,}$/.test(query)?query.replace(/\D/g,''):query.toLowerCase()))).map(x=>({id:String(x.jid??x.JID??x.phone),title:x.name||x.full_name||x.push_name||String(x.jid),kind:'direct',canSend:true}));const next=offset+limit<items.length?String(offset+limit):null;return {items:items.slice(offset,offset+limit),next,complete:next===null};},
 reconcile,
 async send(v,{checkpoint=()=>{}}={}){
  const before=await history({...v,cursor:null,limit:100});
  const evidence={startedAt:new Date().toISOString(),beforeIds:before.items.map(m=>m.id)};checkpoint(evidence);
  let r;try{r=root(await upstream.call('whatsapp_send',{type:'text',phone:v.conversationId,message:v.text,...(v.replyTo?{reply_message_id:v.replyTo}:{}),...device}));}catch{/* Still reconcile after a lost transport response. */}
  const id=r?.message_id??r?.id??r?.message?.id??r?.data?.message_id??r?.data?.id??r?.data?.message?.id;
  if(typeof id==='string'&&id){evidence.candidateId=id;checkpoint({candidateId:id});}
  return reconcile(v,evidence);
 },
 async attachment(v){const r=await attachmentFile({...v,maxBytes:25*1024*1024});return boundedFile(r.path,settings.mediaRoot+'/statics/media');
 },close:()=>upstream.close()};
}};
