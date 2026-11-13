import {z} from 'zod';
import {checkedMentions} from './mentions.mjs';
import {producerEvidence} from './inbox-origin.mjs';
import {readFileSync,statSync} from 'node:fs';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {id,ref,message,key,HubError} from './contracts.mjs';
import {hash} from './store.mjs';
export const nativeConfig=z.object({enabled:z.boolean().default(false),bindings:z.array(z.object({connectionId:id,scope:id,transport:z.enum(['telegram_native','gowa_webhook']),subscriberScopes:z.array(id).max(100).default([]),secretFile:z.string().optional(),deviceId:z.string().optional()}).strict()).max(100).default([])}).strict();
export const nativeInput=z.object({providerEventId:ref,accountSelfId:ref.nullable().optional(),producer:producerEvidence.optional(),message:message}).strict();

/** Only explicit selected subscriptions admit native events. The existing
 * session owner supplies updates; Hub never logs in or starts a provider.
 * Durable intent/receipt and cache/inbox publication share one transaction. */
export class NativeIngress {
 constructor(hub){this.hub=hub;this.config=nativeConfig.parse(hub.config.native??{});if(new Set(this.config.bindings.map(b=>key(b.connectionId,b.transport))).size!==this.config.bindings.length)throw new HubError('native_binding_conflict');this.db=hub.inbox.db;this.db.exec('CREATE TABLE IF NOT EXISTS native_receipts(identity TEXT PRIMARY KEY,digest TEXT NOT NULL,body TEXT NOT NULL)');}
 /** Configuration is not proof of a connected provider. Only receipts measure
  * commit latency; source timestamp age is clock-dependent, not network SLA. */
 describe(scope,connectionId){const binding=this.config.bindings.find(b=>(b.scope===scope||b.subscriberScopes.includes(scope))&&b.connectionId===connectionId),enabled=this.config.enabled&&!!binding&&!!this.hub.config.scopes[binding?.scope]?.inbox?.nativeIngest;const rows=this.db.prepare('SELECT body FROM inbox_subs WHERE scope=?').all(scope).map(r=>JSON.parse(r.body)).filter(s=>s.connectionId===connectionId&&s.lastNativeAt).sort((a,b)=>b.lastNativeAt.localeCompare(a.lastNativeAt));const last=rows[0];return {configured:enabled,mode:enabled?(last?binding.transport+(this.hub.inbox.workerEnabled(scope)?'+history_poll_recovery':''):binding.transport+'_awaiting_receipt'):this.hub.inbox.workerEnabled(scope)?'history_poll':'explicit_refresh_only',lastReceiptAt:last?.lastNativeAt??null,commitLatencyMs:last?.nativeCommitMs??null,sourceTimestampAgeMs:last?.nativeSourceAgeMs??null,producerCapturedAt:last?.lastProducerCapturedAt??null,providerEventId:last?.lastProviderEventId??null,sourceAgeClockDependent:true};}
 binding(connectionId,transport){const b=this.config.bindings.find(b=>b.connectionId===connectionId&&b.transport===transport);if(!this.config.enabled||!b||!this.hub.config.scopes[b.scope]?.inbox?.nativeIngest)throw new HubError('native_ingest_disabled');if(this.hub.config.connections[connectionId]?.plugin!==(transport==='telegram_native'?'telegram':'whatsapp'))throw new HubError('native_plugin_mismatch');return b;}
 accept(scope,connectionId,input,transport='telegram_native'){
  const begin=performance.now(),b=this.binding(connectionId,transport);if(b.scope!==scope)throw new HubError('native_not_authorized');const v=nativeInput.parse(input);if(v.message.mentionEvidence)v.message.mentionEvidence=checkedMentions(v.message.text,v.message.mentionEvidence);this.hub.inbox.authorize(scope);const expectedSelf=this.hub.config.connections[connectionId]?.settings.selfId;if(transport==='telegram_native'&&expectedSelf!==undefined&&v.accountSelfId!==String(expectedSelf))throw new HubError('native_account_mismatch');this.hub.access(scope,connectionId,v.message.conversationId);
  const targets=[...new Set([scope,...b.subscriberScopes])];const subs=targets.flatMap(target=>this.db.prepare('SELECT body FROM inbox_subs WHERE scope=?').all(target).map(r=>JSON.parse(r.body))).filter(s=>{if(!s.enabled||s.connectionId!==connectionId||s.conversationId!==v.message.conversationId||s.topicId!==undefined&&s.topicId!==v.message.topicId)return false;try{this.hub.inbox.authorize(s.scope);this.hub.access(s.scope,connectionId,v.message.conversationId);return true;}catch{return false;}});if(!subs.length)throw new HubError('native_route_unselected');
  const identity=key(scope,connectionId,v.providerEventId),digest=hash(v),result=this.hub.inbox.transaction(()=>{const old=this.db.prepare('SELECT * FROM native_receipts WHERE identity=?').get(identity);if(old){if(old.digest!==digest)throw new HubError('native_event_conflict');return {...JSON.parse(old.body),duplicate:true};}
   for(const s of subs){this.hub.inbox.observe(s,v.message,{transport,phase:'native_callback',providerEventId:v.providerEventId,producer:v.producer});s.lastNativeAt=new Date().toISOString();s.lastProducerCapturedAt=v.producer?.capturedAt??null;s.lastProviderEventId=v.providerEventId;s.transportMode=transport;s.nativeSourceAgeMs=Math.max(0,Date.now()-Date.parse(v.message.at));s.nativeCommitMs=performance.now()-begin;this.hub.inbox.saveSub(s);}
   const receipt={status:'committed',transportMode:transport,providerEventId:v.providerEventId,receivedAt:new Date().toISOString(),commitLatencyMs:performance.now()-begin,duplicate:false};this.db.prepare('INSERT INTO native_receipts VALUES(?,?,?)').run(identity,digest,JSON.stringify(receipt));return receipt;
  });
  // Media runs after raw commit; no settling or ASR latency delays UI arrival.
  queueMicrotask(()=>{for(const s of subs)try{this.hub.inbox.collectMedia(s);}catch{/* Status is durable; a later explicit retry/poll can reconcile media. */}});return result;
 }
 webhook(connectionId,raw,signature){const b=this.binding(connectionId,'gowa_webhook');if(!b.secretFile||(statSync(b.secretFile).mode&0o077))throw new HubError('native_secret_required');const secret=readFileSync(b.secretFile,'utf8').trim();if(secret.length<32)throw new HubError('native_secret_required');const expected=createHmac('sha256',secret).update(raw).digest(),hex=/^sha256=([a-f0-9]{64})$/i.exec(signature??'')?.[1];if(!hex||!timingSafeEqual(expected,Buffer.from(hex,'hex')))throw new HubError('native_signature_invalid');
  const root=JSON.parse(raw),p=root.payload;if(!b.deviceId||root.device_id!==b.deviceId)throw new HubError('native_device_mismatch');if(!p||!['message','message.edited','message.deleted','message.revoked'].includes(root.event))return {status:'ignored',reason:'unsupported_event'};
  const chat=p.chat_id,id=String(p.original_message_id??p.deleted_message_id??p.id??'');this.hub.access(b.scope,connectionId,chat);if(typeof chat!=='string'||!id)throw new HubError('native_payload_invalid');
  const deleted=['message.deleted','message.revoked'].includes(root.event),previous=deleted?this.hub.cache.get(b.scope,{connectionId,conversationId:chat,messageId:id}).message:null;
  const at=new Date(p.timestamp??root.timestamp).toISOString(),media=p.image?'image':p.document?'document':p.audio?'audio':p.video?'video':p.media_type;
  const m=previous?{...previous,deletedAt:at}:{id,conversationId:chat,kind:'message',direction:p.is_from_me?'outbound':'inbound',isSelf:typeof p.is_from_me==='boolean'?p.is_from_me:null,senderId:p.from??null,...(p.sender_name||p.push_name?{authorLabel:String(p.sender_name||p.push_name).slice(0,500)}:{}),at,text:p.body??'',...(root.event==='message.edited'?{editedAt:at}:{}),replyTo:p.reply_message_id??p.quoted_message_id??null,attachments:media?[{id,kind:media,filename:p.filename??null,mimeType:p.mime_type??null,size:p.file_length?Number(p.file_length):null}]:[]};
  return this.accept(b.scope,connectionId,{providerEventId:hash([root.event,root.device_id,p]),message:m,...(root.hub_producer?{producer:root.hub_producer}:{})},'gowa_webhook');
 }
}
