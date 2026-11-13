import {telegramAddress,telegramReadResult,telegramPeer} from '../telegram-address.mjs';
import {mkdir,copyFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Upstream} from '../upstream.mjs';
import {HubError} from '../contracts.mjs';
import {boundedFile,boundedPath} from './files.mjs';

/** Recovery is a local owner action, never a grant to start login from MCP.
 * An account/transport failure alone cannot prove expiry. Keep its diagnostic
 * code and retry evidence while pointing the owner at the installed UI. */
function recoveryError(error){
 if(error instanceof HubError&&['upstream_unavailable','upstream_timeout','upstream_rejected','telegram_identity_shape','native_account_mismatch'].includes(error.code))error.details={...error.details,ownerRecovery:{command:'messenger-telegram-login',requiresOwner:true},nextAction:'Check the existing Telegram connection. The local owner can run messenger-telegram-login to open the recovery page, then check before explicitly starting QR login. Do not infer session expiry from a transport failure, copy auth state, request passwords in chat, or replay uncertain sends.'};
 return error;
}

/** Existing Telethon session remains owned by telegram-mcp; this adapter opens no new login. */
export function parseHistory(raw,conversationId,selfId){
 // Unknown/deleted/service senders are legitimate history, not malformed pages.
 // Parse identity only from the sender HEADER: body text is untrusted and may
 // contain fake [id=...] tokens. Never invent an author or omit its source row.
 const fail=(field,expected,actual,recordIndex)=>{throw new HubError('telegram_history_shape',{adapter:'telegram',operation:'get_messages',field,expected,actualType:actual,...(recordIndex?{recordIndex}:{}),nextAction:'The provider response cannot be normalized safely. Report this field/type and correlationId to the Hub owner; do not skip the page, expose raw content, or change the cursor options.'});};
 if(typeof raw!=='string')fail('response','string',raw===null?'null':Array.isArray(raw)?'array':typeof raw);
 if(/^No messages found/i.test(raw.trim()))return [];
 const lines=raw.split('\n').filter(Boolean);
 return lines.map((line,index)=>{
  const record=index+1,i=line.indexOf(' | Message: ');
  if(i<0)fail('messageDelimiter','header followed by Message field','missing',record);
  const parts=line.slice(0,i).split(' | '),id=/^ID: (\d+)$/.exec(parts[0])?.[1];
  if(!id)fail('id','numeric source ID header','invalid_or_missing',record);
  const senderField=(parts[1]??'').replace(/^Sender: /,'');
  if(!senderField)fail('sender','display header (ID optional)','missing',record);
  const sender=/\[id=(-?\d+)\]$/.exec(senderField)?.[1]??null;
  if(!sender&&/\[id=/.test(senderField))fail('senderId','numeric terminal ID token or absent','invalid_token',record);
  const date=parts.find(p=>p.startsWith('Date: '))?.slice(6).trim();
  if(!date||Number.isNaN(Date.parse(date)))fail('date','parseable timestamp','invalid_or_missing',record);
  const media=parts.find(p=>p.startsWith('📎 ')),text=line.slice(i+' | Message: '.length);
  const label=senderField.replace(/\s*\[id=-?\d+\]$/,'').trim(),unknown=sender===null;
  return {id,conversationId,kind:'message',direction:sender===selfId?'outbound':'inbound',senderId:sender,
   ...(!unknown&&label?{authorLabel:label.slice(0,500)}:{}),isSelf:unknown?null:sender===selfId,at:new Date(date).toISOString(),
   text:text==='[empty]'?'':text.replaceAll('\\n','\n'),replyTo:/ \| reply to (\d+)/.exec(line.slice(0,i))?.[1]??null,
   attachments:media&&!/webpage|web page/i.test(media)?[{id:`message:${id}`,kind:/voice|audio/i.test(media)?'audio':/photo|image/i.test(media)?'image':/video/i.test(media)?'video':'document',filename:null,mimeType:null,size:null}]:[]};
 });
}
/** Parse metadata only, never evaluate Telethon's Python representation or execute filenames. */
export function telegramMedia(raw,messageId){
 if(typeof raw!=='string'||/^No media/.test(raw)||/MessageMediaWebPage/.test(raw))return null;
 const quoted=field=>{const m=new RegExp(field+`=(['"])((?:\\\\.|(?!\\1).)*)\\1`).exec(raw);return m?.[2]?.replaceAll("\\'","'").replaceAll('\\"','"').replaceAll('\\\\','\\');};
 const mimeType=quoted('mime_type')??(/MessageMediaPhoto/.test(raw)?'image/jpeg':null);
 const kind=/voice=True/.test(raw)||mimeType?.startsWith('audio/')?'audio':/DocumentAttributeVideo/.test(raw)||mimeType?.startsWith('video/')?'video':/MessageMediaPhoto/.test(raw)||mimeType?.startsWith('image/')?'image':'document';
 // Progressive photos list cumulative sizes; download_media selects the largest variant.
 const sizes=[...raw.matchAll(/\bsize=(\d+)/g)].map(m=>Number(m[1]));
 for(const m of raw.matchAll(/PhotoSizeProgressive\([^)]*sizes=\[([\d, ]+)\]/g))sizes.push(...m[1].split(',').map(Number));
 const nativeVideo=/DocumentAttributeVideo\(([^)]*)\)/.exec(raw)?.[1];
 const video=nativeVideo?Object.fromEntries([['durationSeconds','duration'],['width','w'],['height','h']].flatMap(([field,native])=>{const value=new RegExp('\\b'+native+'=([0-9]+(?:\\.[0-9]+)?)').exec(nativeVideo)?.[1];return value&&Number(value)>0?[[field,Number(value)]]:[];})):undefined;
 return {id:`message:${messageId}`,kind,...(video?{video}:{}),filename:quoted('file_name')??null,mimeType,size:sizes.length?Math.max(...sizes):null,...(/MessageMediaPhoto/.test(raw)?{sizeVariant:'largest',downloadVariant:'largest'}:{}),providerVersion:/(?:Document|Photo)\(id=(\d+)/.exec(raw)?.[1]??String(messageId)};
}
/** Readback checks native structure, not rendered-text equality or client appearance.
 * Only require blocks explicitly present in markup; untrusted source is never executed.
 */
export function hasRichStructure(text,format,blocks){
 const kinds=new Set();const visit=node=>{if(!node||typeof node!=='object')return;if(typeof node._==='string')kinds.add(node._);for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}};
 blocks.forEach(visit);
 const required=[];
 if(format==='rich_html'){
  if(/<table[\s>]/i.test(text))required.push('PageBlockTable');
  if(/<details[\s>]/i.test(text))required.push('PageBlockDetails');
  for(const m of text.matchAll(/<h([123])[\s>]/gi))required.push('PageBlockHeading'+m[1]);
  if(/<img[\s>]/i.test(text))required.push('PageBlockPhoto');
 }else{
  if(/^\s*\|?\s*:?-{3,}:?\s*\|/m.test(text))required.push('PageBlockTable');
  for(const m of text.matchAll(/^(#{1,3})[ \t]+/gm))required.push('PageBlockHeading'+m[1].length);
  if(/^\s*!\[[^\]]*\]\(https?:\/\//m.test(text))required.push('PageBlockPhoto');
 }
 return required.every(kind=>kinds.has(kind));
}
/** The bridge's explicit no-media result is a source availability failure,
 * not a route/permission failure. Do not infer deletion or relax path checks.
 * Unknown replies remain download_failed; both original APIs share this parser. */
export function telegramDownloadPath(result){
 const text=String(result);
 if(text==='No media found in the specified message.')throw new HubError('attachment_unavailable',{providerEvidence:'no_media_in_message',retryable:false,nextAction:'Inspect the exact source message; do not infer deletion or expiry.'});
 const filename=/^Media downloaded to (.+)\.$/s.exec(text)?.[1];
 if(!filename)throw new HubError('download_failed');
 return filename;
}
export default {id:'telegram',contractVersion:1,create(settings){
 const upstream=settings.upstreamClient??new Upstream(settings.upstream);
 const nativeRead=chat=>settings.nativeHistory===true||settings.nativeHistoryConversations?.includes(chat);
 const account=settings.account?{account:settings.account}:{};
 const args=chat=>({chat_id:chat,...account});
 const attachmentInfo=async v=>telegramMedia(await upstream.call('get_media_info',{...args(v.conversationId),message_id:Number(v.messageId)},{timeoutMs:5000}),v.messageId);
 const metadata=async(items,probeAll=false)=>{
  // One page-wide five-second budget, four concurrent lookups; optional metadata never stalls a page.
  const output=items.map(m=>({...m})),deadline=Date.now()+5000;let next=0,expired=false,timer;
  const worker=async()=>{while(next<output.length&&!expired&&Date.now()<deadline){const m=output[next++];if(!probeAll&&!m.attachments.length)continue;try{const a=await attachmentInfo({conversationId:m.conversationId,messageId:m.id});if(!expired)m.attachments=a?[a]:[];}catch{if(!expired)m.mediaMetadataIncomplete=true;}}};
  const jobs=Promise.all(Array.from({length:4},worker));
  try{await Promise.race([jobs,new Promise(r=>{timer=setTimeout(r,5000);})]);}finally{expired=true;clearTimeout(timer);}
  if(Date.now()>=deadline)for(const m of output)if(probeAll||m.attachments.length&&!m.attachments[0].providerVersion)m.mediaMetadataIncomplete=true;
  return output;
 };
 const attachmentFile=async v=>{
  if(v.attachmentId!==`message:${v.messageId}`)throw new HubError('attachment_mismatch');
  // Original transfers may take minutes; MCP waits are bounded separately in
  // MediaService. This budget belongs only to read/download, never send/ASR.
  const timeoutMs=settings.downloadTimeoutMs??600000;if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>1800000)throw new HubError('download_timeout_config_invalid');
  const r=await upstream.call('download_media',{...args(v.conversationId),message_id:Number(v.messageId)},{timeoutMs});
  const filename=telegramDownloadPath(r);
  return boundedPath(filename,settings.mediaRoot,v.maxBytes);
 };
 const history=async({conversationId,cursor,limit,includeMetadata=true,topicId})=>{
  if(nativeRead(conversationId)&&!topicId){if(cursor&&!/^nh:\d+$/.test(cursor))throw new HubError('native_history_cursor_invalid');const r=await upstream.call('hub_native_history',{...args(conversationId),limit,offset_id:cursor?Number(cursor.slice(3)):0});if(!Array.isArray(r?.items))throw new HubError('native_history_shape');return {...r,next:r.next?'nh:'+r.next:null,order:'numeric'};}

  if(topicId){const r=await upstream.call('hub_topic_history',{...args(conversationId),topic_id:Number(topicId),limit,offset_id:cursor?Number(cursor):0});if(!Array.isArray(r?.items))throw new HubError('topic_history_shape');return {items:includeMetadata?await metadata(r.items):r.items,next:r.next,complete:r.complete,order:'numeric'};}
  if(!/^-?\d+$/.test(conversationId))throw new HubError('conversation_invalid');
  const number=cursor===null?1:Number(cursor);if(!Number.isSafeInteger(number)||number<1)throw new HubError('cursor_invalid');
  const raw=await upstream.call('get_messages',{...args(conversationId),page:number,page_size:limit});
  const parsed=parseHistory(raw,conversationId,String(settings.selfId));
  const items=includeMetadata?await metadata(parsed):parsed;
  return {items,next:items.length===limit?String(number+1):null,complete:items.length<limit,order:'numeric'};
 };
 const reconcileMedia=async(v,evidence)=>{if(v.topicId)v={...v,replyTo:v.replyTo??v.topicId};
  if(!evidence.candidateId)return {status:'unknown',messageId:null};
  const raw=await upstream.call('get_message_context',{...args(v.conversationId),message_id:Number(evidence.candidateId),context_size:0});
  const row=(Array.isArray(raw)?raw:raw?.results)?.find(m=>String(m.id)===String(evidence.candidateId)&&m.is_target);
  if(!row||String(row.sender_id)!==String(settings.selfId)||String(row.reply_to??'')!==String(v.replyTo??'')||!((row.text??'')===v.caption||v.caption===''&&row.text==='[empty]'))return {status:'unknown',messageId:null};
  const media=await attachmentInfo({conversationId:v.conversationId,messageId:String(evidence.candidateId)});
  const expected=['voice','audio'].includes(v.type)?'audio':v.type;
  return media?.kind===expected?{status:'sent',messageId:String(evidence.candidateId),replyVerification:v.replyTo?'confirmed':'not_requested'}:{status:'unknown',messageId:null};
 };
 // Forum identity is verified in the session-owning bridge before any write.
 // Replying to a root routes text/media into that topic; arbitrary quoted replies
 // need native top-thread evidence and are rejected rather than guessed.
 const topics=async({conversationId,query='',cursor=null,limit=50})=>{const raw=await upstream.call('list_topics',{...args(conversationId),limit,offset_topic:cursor?Number(cursor):0,...(query?{search_query:query}:{})});if(typeof raw==='string'){if(/^No topics/.test(raw))return {items:[],next:null};throw new HubError('topics_unsupported');}const rows=Array.isArray(raw)?raw:raw?.results;if(!Array.isArray(rows))throw new HubError('topics_shape');return {items:rows.map(x=>({id:String(x.id),title:String(x.title),closed:!!x.closed,hidden:!!x.hidden,canSend:!x.closed})),next:rows.length===limit?String(rows.at(-1).id):null};};
 const topicRoute=async(v)=>{if(!v.topicId)return v;if(!/^\d+$/.test(v.topicId))throw new HubError('topic_invalid');if(v.replyTo&&v.replyTo!==v.topicId)throw new HubError('topic_reply_verification_unsupported',{messageCreated:false});let cursor=null,found;for(let i=0;i<20;i++){const p=await topics({...v,cursor,limit:100});found=p.items.find(x=>x.id===v.topicId);if(found||!p.next)break;cursor=p.next;}if(!found||found.closed)throw new HubError('topic_not_available',{messageCreated:false});return {...v,replyTo:v.topicId};};
 return {capabilities:{history:true,send:true,attachments:!!settings.mediaRoot,changes:false,kinds:['message'],maxText:4096,maxRichText:30000,formats:['plain','rich_markdown','rich_html'],sendAttachments:!!settings.mediaRoot,mediaTypes:['image','document','voice','audio','video'],mediaCaptionTypes:['image','document','voice','audio','video'],mediaReply:true,maxUploadBytes:25*1024*1024},
 /** Provisioning calls stay in the session-owning bridge; no generic invite API
  * or caller-controlled account is exposed by the Hub. */
 async groupIdentity(){const r=await upstream.call('hub_forum_identity',account);if(!r||typeof r.id!=='string'||typeof r.isSelf!=='boolean'||typeof r.isBot!=='boolean')throw new HubError('group_identity_invalid');return r;},
 async groupStep(v){const r=await upstream.call('hub_forum_step',{operation_key:v.bridgeKey,marker:v.marker,title:v.title,bot_username:v.botUsername,expected_owner_id:v.ownerId,create_uncertain:v.createUncertain??false,action:v.action,...account});if(!r||!['ok','unknown','blocked'].includes(r.status)||r.conversationId!==undefined&&r.conversationId!==null&&!/^-100[1-9]\d*$/.test(r.conversationId))throw new HubError('group_bridge_result_invalid');return r;},
 reconcileMedia,
 async markMessage(v,{submitting}){
  if(!/^-?\d+$/.test(v.conversationId)||!/^\d+$/.test(v.messageId))throw new HubError('marker_route_invalid');
  const base={...args(v.conversationId),message_id:Number(v.messageId),status:v.status};const before=await upstream.call('hub_work_marker',{...base,apply:false});if(before.state==='failed')return before;
  submitting();return upstream.call('hub_work_marker',{...base,apply:true,expected_reactions:before.reactions});
 },
 async reconcileMarker(v){return upstream.call('hub_work_marker',{...args(v.conversationId),message_id:Number(v.messageId),status:v.status,apply:false});},
 async sendMedia(v,{checkpoint=()=>{}}={}){v=await topicRoute(v);
  // Isolate collisions in the directory, never in the user-visible filename.
  const root=path.join(settings.mediaRoot,'hub-outbox',randomUUID());await mkdir(root,{recursive:true,mode:0o700});
  const filename=path.join(root,path.basename(v.filename));await copyFile(v.path,filename);
  try{
   // A rejected/deleted quote may race the scoped lookup. Retry only the
   // proven no-create quote rejection, preserving filename/bytes/chat/topic.
   let result;
   for(let attempt=0;attempt<2;attempt++){
    try{result=await upstream.call('send_media_with_receipt',{...args(v.conversationId),file_path:filename,media_type:v.type,caption:v.caption,reply_to:v.replyTo?Number(v.replyTo):null});break;}
    catch(e){if(attempt===0&&v.replyTo&&!v.topicId&&e.code==='reply_target_invalid'&&e.details?.messageCreated===false){const requestedReplyTo=v.replyTo;v={...v,replyTo:null};checkpoint({effectiveReplyTo:null,replyFallback:{status:'omitted',requestedReplyTo,effectiveReplyTo:null,reason:'reply_target_rejected'}});continue;}throw e;}
   }
   if(result?.sent!==true||!Number.isSafeInteger(result.message_id))return {status:'unknown',messageId:null};
   checkpoint({candidateId:String(result.message_id)});return reconcileMedia(v,{candidateId:String(result.message_id)});
  }finally{await rm(root,{recursive:true,force:true}).catch(()=>{});}
 },
 async health(){try{await upstream.client?.();const r=await upstream.call('get_me',account);
  // A transport reply is not proof of an authenticated account: provider prose
  // and malformed envelopes must never report the literal identity undefined.
  const id=r?.id;
  if(!(typeof id==='string'&&/^[1-9]\d*$/.test(id)||typeof id==='number'&&Number.isSafeInteger(id)&&id>0))throw new HubError('telegram_identity_shape',{providerOperation:'get_me',field:'id',expected:'positive_numeric_id',actualType:r===null?'null':Array.isArray(r)?'array':typeof r});
  return {available:true,checked:'account',self:{id:String(r.id),isSelf:true},configuredSelfMatches:String(r.id)===String(settings.selfId),...(settings.nativeHistoryConversations?.length?{nativeCollector:await upstream.call('hub_native_status')}: {})};}catch(e){throw recoveryError(e);}},
 /** Name search pages the complete peer union, even when filtering empties
  * a page. Native username lookup precedes enumeration and is never contacts-only. */
 async conversations({query='',cursor=null,limit=50,resolveExact=true}){
  if(settings.selfId&&['self','me','избранное','saved messages'].includes(query.trim().toLocaleLowerCase('ru')))return {items:[{id:String(settings.selfId),title:'Избранное',kind:'direct',canSend:true,isSelf:true}],next:null,complete:true};
  let offset=0;
  if(cursor){let c;try{c=JSON.parse(Buffer.from(cursor,'base64url').toString());}catch{throw new HubError('cursor_invalid');}if(c.query!==query||c.limit!==limit||!Number.isSafeInteger(c.offset)||c.offset<0)throw new HubError('cursor_invalid');offset=c.offset;}
  if(query&&!cursor&&resolveExact){const a=telegramAddress(query);if(a.kind==='username'){
   try{const r=telegramReadResult(await upstream.call('hub_read_resolve',{username:a.value,...account}));return {items:[telegramPeer(r?.item)],next:null,complete:true,coverage:{source:'telegram_exact_username',complete:true}};}
   catch(e){if(e.code!=='conversation_not_found'||!a.bare)throw e;}
  }}
  const searchAddress=query?telegramAddress(query):null,searchQuery=searchAddress?.kind==='id'?searchAddress.value:query;
  const r=telegramReadResult(await upstream.call('hub_read_catalog',{offset,limit,query:searchQuery,...account}));
  if(!Array.isArray(r?.items)||!Object.hasOwn(r,'next')||typeof r.complete!=='boolean'||r.next!==null&&(!/^\d+$/.test(r.next)||Number(r.next)<=offset))throw new HubError('telegram_read_provider_failed');
  const q=searchQuery.trim().toLocaleLowerCase();
  const items=r.items.map(telegramPeer).filter(x=>!q||`${x.title} ${x.id} ${x.username??''}`.toLocaleLowerCase().includes(q));
  return {items,next:r.next===null?null:Buffer.from(JSON.stringify({query,limit,offset:Number(r.next)})).toString('base64url'),complete:r.complete,coverage:{...r.coverage,complete:r.complete,filteredPage:true}};
 },
 /** Ambiguity is decided only after exhaustive bounded enumeration. Exact
  * username is authoritative; a partial catalog cannot prove a unique title. */
 async resolveConversation({address,allowed}){
  if(address.kind==='username'){
   try{const r=telegramReadResult(await upstream.call('hub_read_resolve',{username:address.value,...account}));return telegramPeer(r?.item);}
   catch(e){if(e.code!=='conversation_not_found'||!address.bare)throw e;}
  }
  const query=address.value,found=new Map();let cursor=null,complete=false;
  for(let n=0;n<100;n++){
   const r=await this.conversations({query,cursor,limit:100,resolveExact:false});
   for(const x of r.items)if(allowed==='*'||allowed.includes(x.id))found.set(x.id,x);
   complete=r.complete;cursor=r.next;if(!cursor)break;
  }
  const candidates=[...found.values()];
  if(!complete)throw new HubError('conversation_search_incomplete',{candidates,next:cursor,query,limit:100,coverage:{complete:false},nextAction:'Continue messenger_conversations with readMode:refresh, the same query/limit and next cursor, or supply an exact username/link/ID.'});
  if(!candidates.length)throw new HubError('conversation_not_found');
  if(candidates.length>1)throw new HubError('conversation_ambiguous',{candidates});
  return candidates[0];
 },topics,history,attachmentInfo,attachmentFile,
 async videoThumbnail(v){if(v.attachmentId!==`message:${v.messageId}`)throw new HubError('attachment_mismatch');return upstream.call('hub_video_thumbnail',{...args(v.conversationId),message_id:Number(v.messageId)});},
 async identity(){try{const r=await upstream.call('hub_native_identity',account);if(!r?.self?.isSelf||!r.self.verified||String(r.self.id)!==String(settings.selfId))throw new HubError('native_account_mismatch');return r;}catch(e){throw recoveryError(e);}},
 async message(v){
  if(nativeRead(v.conversationId)&&!v.topicId){const r=await upstream.call('hub_native_message',{...args(v.conversationId),message_id:Number(v.messageId)});return r?.message??null;}

  // Exact topic RPC evidence is required; generic context cannot prove a forum route.
  if(v.topicId){let cursor=null;for(let depth=0;depth<20;depth++){const p=await history({...v,cursor,limit:100,includeMetadata:true});const found=p.items.find(m=>m.id===v.messageId);if(found)return found;if(!p.next)return null;cursor=p.next;}throw new HubError('topic_message_window_exceeded');}
  const raw=await upstream.call('get_message_context',{...args(v.conversationId),message_id:Number(v.messageId),context_size:0});
  const x=(Array.isArray(raw)?raw:raw?.results)?.find(m=>String(m.id)===v.messageId&&m.is_target);if(!x)return null;
  const sender=String(x.sender_id??/\[id=(-?\d+)\]/.exec(x.sender??'')?.[1]??'unknown');
  let attachment;try{attachment=await attachmentInfo(v);}catch{/* Text remains readable when optional attachment metadata fails. */}
  return {id:String(x.id),conversationId:v.conversationId,kind:'message',direction:sender===String(settings.selfId)?'outbound':'inbound',senderId:sender,...(x.sender_name||x.sender?.replace(/\s*\[id=.*$/, '')?{authorLabel:String(x.sender_name||x.sender.replace(/\s*\[id=.*$/, '')).slice(0,500)}:{}),isSelf:sender===String(settings.selfId),at:new Date(x.date).toISOString(),text:x.text??'',replyTo:x.reply_to?String(x.reply_to):null,replyToKnown:Object.hasOwn(x,'reply_to'),attachments:attachment?[attachment]:[],...(x.rich_message?{richMessage:x.rich_message,contentComplete:!x.rich_message.part}:{})};
 },
 async search({conversationId,query,cursor,limit}){
  // Upstream search has no offset. Expand a bounded native window and slice locally; cursor binds the query/chat.
  let offset=0;if(cursor){let c;try{c=JSON.parse(Buffer.from(cursor,'base64url').toString());}catch{throw new HubError('cursor_invalid');}if(c.conversationId!==conversationId||c.query!==query||!Number.isSafeInteger(c.offset)||c.offset<0||c.offset>=1000)throw new HubError('cursor_invalid');offset=c.offset;}
  const requested=Math.min(1000,offset+limit);
  const raw=await upstream.call('search_messages',{...args(conversationId),query,limit:requested});const r=Array.isArray(raw)?raw:raw?.results;
  if(!Array.isArray(r))throw new HubError('telegram_search_shape');
  const items=await metadata(r.slice(offset,requested).map(x=>{const sender=/\[id=(-?\d+)\]/.exec(x.sender??'')?.[1]??null;
   return {id:String(x.id),conversationId,direction:sender===String(settings.selfId)?'outbound':'inbound',senderId:sender,...(x.sender_name||x.sender?.replace(/\s*\[id=.*$/, '')?{authorLabel:String(x.sender_name||x.sender.replace(/\s*\[id=.*$/, '')).slice(0,500)}:{}),isSelf:sender===String(settings.selfId),at:new Date(x.date).toISOString(),text:x.text??'',replyTo:x.reply_to?String(x.reply_to):null,replyToKnown:Object.hasOwn(x,'reply_to'),attachments:[]};}),true);
  const complete=r.length<requested,next=!complete&&requested<1000?Buffer.from(JSON.stringify({offset:requested,conversationId,query})).toString('base64url'):null;
  return {items,next,complete,order:'numeric'};
 },
 async contacts({query,limit,cursor}){
  if(settings.selfId&&['self','me','избранное','saved messages'].includes((query??'').trim().toLocaleLowerCase('ru')))return {items:[{id:String(settings.selfId),title:'Избранное',kind:'direct',canSend:true,isSelf:true}],next:null,complete:true};
  const offset=cursor?Number(cursor):0;if(!Number.isSafeInteger(offset)||offset<0)throw new HubError('cursor_invalid');
  const r=await upstream.call(query?'search_contacts':'list_contacts',{...(query?{query}:{}),...account});
  const rows=typeof r==='string'&&r.startsWith('No contacts')?[]:Array.isArray(r)?r:r.results;if(!Array.isArray(rows))throw new HubError('telegram_contacts_shape');
  const next=offset+limit<rows.length?String(offset+limit):null;
  return {items:rows.slice(offset,offset+limit).map(x=>({id:String(x.id),title:x.name||[x.first_name,x.last_name].filter(Boolean).join(' ')||String(x.id),kind:'direct',canSend:true})),next,complete:next===null&&(!query||rows.length<50)};
 },
 async send(v,{checkpoint=()=>{}}={}){v=await topicRoute(v);
  const before=await history({...v,cursor:null,limit:100,includeMetadata:false}),max=Math.max(0,...before.items.map(x=>Number(x.id)));
  // Rich transport returns a server-correlated ID. Plain text matching is invalid
  // for rendered blocks (headings/tables/details no longer equal source markup).
  let response;
  // A known quote-only RPC rejection is the sole safe downgrade after I/O.
  // Persist the effective quote before the one unquoted attempt. Timeouts and
  // unclassified errors never fall through to another write.
  for(let attempt=0;attempt<2;attempt++){
   try{response=await upstream.call(v.replyTo?'reply_to_message':'send_message',{
    ...args(v.conversationId),...(v.replyTo?{message_id:Number(v.replyTo),text:v.text}:{message:v.text}),
    ...(v.format?.startsWith('rich_')?{parse_mode:v.format}:{})
   });break;}catch(e){
    if(attempt===0&&v.replyTo&&!v.topicId&&e.code==='reply_target_invalid'&&e.details?.messageCreated===false){const requestedReplyTo=v.replyTo;v={...v,replyTo:null};checkpoint({effectiveReplyTo:null,replyFallback:{status:'omitted',requestedReplyTo,effectiveReplyTo:null,reason:'reply_target_rejected'}});continue;}
    break;
   }
  }
  if(v.format?.startsWith('rich_')){
   const ids=response?.message_ids;
   if(response?.sent!==true||response.format!==v.format||!Array.isArray(ids)||ids.length!==1||!Number.isSafeInteger(ids[0])||ids[0]<=max)return {status:'unknown',messageId:null};
   try{
    const raw=await upstream.call('get_message_context',{...args(v.conversationId),message_id:ids[0],context_size:0});
    const rows=Array.isArray(raw)?raw:raw?.results;
    const target=rows?.find(x=>String(x.id)===String(ids[0])&&x.is_target===true);
    const rich=target?.rich_message;
    const sender=String(target?.sender_id??/\[id=(-?\d+)\]/.exec(target?.sender??'')?.[1]);
    if(sender===String(settings.selfId)&&String(target.reply_to??'')===String(v.replyTo??'')&&rich?.part===false&&Array.isArray(rich.blocks)&&rich.blocks.length&&hasRichStructure(v.text,v.format,rich.blocks)){
     return {status:'sent',messageId:String(ids[0])};
    }
   }catch{/* A missing readback is uncertainty, never permission to send again. */}
   return {status:'unknown',messageId:null};
  }
  const after=await history({...v,cursor:null,limit:100,includeMetadata:false});
  const found=after.items.filter(x=>Number(x.id)>max&&x.direction==='outbound'&&x.text===v.text&&x.replyTo===(v.replyTo??null));
  return found.length===1?{status:'sent',messageId:found[0].id}:{status:'unknown',messageId:null};
 },
 async attachment(v){
  if(v.attachmentId!==`message:${v.messageId}`)throw new HubError('attachment_mismatch');
  // Original transfers may take minutes; MCP waits are bounded separately in
  // MediaService. This budget belongs only to read/download, never send/ASR.
  const timeoutMs=settings.downloadTimeoutMs??600000;if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>1800000)throw new HubError('download_timeout_config_invalid');
  const r=await upstream.call('download_media',{...args(v.conversationId),message_id:Number(v.messageId)},{timeoutMs});
  const filename=telegramDownloadPath(r);
  return boundedFile(filename,settings.mediaRoot);
 },close:()=>upstream.close()};
}};
