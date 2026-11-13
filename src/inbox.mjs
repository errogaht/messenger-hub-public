import {z} from 'zod';
import {checkedMentions} from './mentions.mjs';
import {classify,readOrigin,originEnvelope,cutover} from './inbox-origin.mjs';
import {EventEmitter} from 'node:events';
import {InboxRead,projectBinding} from './inbox-read.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,readFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {id,route,HubError,key} from './contracts.mjs';
import {hash} from './store.mjs';
import {diagnostic} from './errors.mjs';
import {processAlive} from './groups.mjs';
import {resultChars} from './tool-result.mjs';

export const inboxConfig=z.object({enabled:z.boolean().default(false),workerScopes:z.array(id).optional(),push:z.object({enabled:z.boolean().default(false)}).strict().default({}),projects:z.array(projectBinding).max(1000).default([]),store:z.string().optional(),tickMs:z.number().int().min(100).max(60000).default(1000),workers:z.number().int().min(1).max(20).default(4),pagesPerTick:z.number().int().min(1).max(20).default(3),pageSize:z.number().int().min(1).max(100).default(100),overlapPages:z.number().int().min(1).max(20).default(2)}).strict();
export const inboxGrant=z.object({read:z.boolean().default(false),manage:z.boolean().default(false),push:z.boolean().default(false),nativeIngest:z.boolean().default(false)}).strict();
export const subscriptionInput=route.extend({subscriptionId:id,revision:z.number().int().nonnegative(),enabled:z.boolean().default(false),pollMs:z.number().int().min(1000).max(3600000).default(10000),fullRescanMs:z.number().int().min(60000).max(604800000).default(86400000),settleMs:z.number().int().min(0).max(30000).default(6000),direction:z.enum(['inbound','all']).default('inbound'),initialHistory:z.enum(['available','from_now']).default('available'),autoAudio:z.boolean().default(true),acknowledgeGap:z.boolean().default(false)}).strict();
export const subscriptionStatusInput=z.object({subscriptionId:id.optional()}).strict();
export const consumerInput=z.object({consumerId:id,subscriptionIds:z.array(id).min(1).max(100),start:z.enum(['beginning','now']).default('beginning')}).strict();
export const claimInput=z.object({consumerId:id,leaseMs:z.number().int().min(1000).max(3600000).default(60000),limit:z.number().int().min(1).max(100).default(50),maxResponseChars:z.number().int().min(2000).max(200000).default(16000),maxTextChars:z.number().int().min(0).max(10000).default(1200)}).strict();
export const ackInput=z.object({consumerId:id,batchId:z.string().uuid(),leaseToken:z.string().uuid()}).strict();
export const eventInput=z.object({consumerId:id,eventId:z.string().uuid()}).strict();
const audio=a=>/^(audio|voice|ptt)$/i.test(a.kind)||a.mimeType?.startsWith('audio/');
const parse=row=>row?JSON.parse(row.body):null;

/** Private at-least-once inbox, independent of the legacy observation journal.
 * Provider history cursors and consumer acknowledgement offsets are separate.
 * Bodies are retained for immutable edit/media evidence, never sent to an LLM.
 * Only the HTTP service starts a worker; MCP consumers do not drive collection. */
export class Inbox {
 constructor(hub,config={},deps={}){
  this.hub=hub;this.config=inboxConfig.parse(config);this.now=deps.now??Date.now;this.jobs=new Map();this.closed=false;this.changes=new EventEmitter();this.changes.setMaxListeners(100);
  this.owner=`${process.pid}:${readFileSync(`/proc/${process.pid}/stat`,'utf8').split(') ')[1].split(' ')[19]}`;
  const filename=this.config.store??(hub.config.store===':memory:'?':memory:':hub.config.store+'.inbox');
  if(filename!==':memory:')mkdirSync(dirname(filename),{recursive:true,mode:0o700});
  this.db=new DatabaseSync(filename);if(filename!==':memory:')chmodSync(filename,0o600);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS inbox_subs(identity TEXT PRIMARY KEY,scope TEXT NOT NULL,body TEXT NOT NULL,lock_owner TEXT);
   CREATE TABLE IF NOT EXISTS inbox_origins(identity TEXT PRIMARY KEY,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS inbox_sources(identity TEXT PRIMARY KEY,subscription TEXT NOT NULL,message TEXT NOT NULL,digest TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS inbox_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,subscription TEXT NOT NULL,body TEXT NOT NULL,available_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS inbox_events_sub ON inbox_events(subscription,sequence);
   CREATE TABLE IF NOT EXISTS inbox_consumers(identity TEXT PRIMARY KEY,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS inbox_batches(id TEXT PRIMARY KEY,consumer TEXT NOT NULL,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS inbox_media(identity TEXT PRIMARY KEY,subscription TEXT NOT NULL,file TEXT NOT NULL,digest TEXT,revision INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS inbox_media_file ON inbox_media(file);
   CREATE TABLE IF NOT EXISTS inbox_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,scope TEXT NOT NULL,action TEXT NOT NULL,identity TEXT NOT NULL);
  `);this.read=new InboxRead(this);
 }
 /** An optional operator allowlist confines background I/O without revoking
  * cached reads or native ingress. Empty means no workers; absent is legacy. */
 workerEnabled(scope){return this.config.enabled&&(!this.config.workerScopes||this.config.workerScopes.includes(scope));}
 visible(scope,manage=false){const g=this.hub.config.scopes[scope]?.inbox;return !!(manage?g?.manage:g?.read||g?.manage);}
 authorize(scope,manage=false){if(!this.visible(scope,manage))throw new HubError('inbox_not_authorized');}
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 audit(scope,action,identity){this.db.prepare('INSERT INTO inbox_audit(at,scope,action,identity) VALUES(?,?,?,?)').run(new Date(this.now()).toISOString(),scope,action,identity);}
 sub(scope,id){const identity=key(scope,id),s=parse(this.db.prepare('SELECT body FROM inbox_subs WHERE identity=?').get(identity));if(!s)throw new HubError('subscription_not_found');this.hub.access(scope,s.connectionId,s.conversationId);return s;}
 saveSub(s){const current=parse(this.db.prepare('SELECT body FROM inbox_subs WHERE identity=?').get(key(s.scope,s.subscriptionId)));s.lastActivityAt=Math.max(s.lastActivityAt??0,current?.lastActivityAt??0);
  // Recovery polls may finish after a live receipt; never erase newer native diagnostics.
  if(current?.lastNativeAt&&Date.parse(current.lastNativeAt)>Date.parse(s.lastNativeAt??'1970-01-01'))for(const field of ['lastNativeAt','lastProducerCapturedAt','lastProviderEventId','transportMode','nativeSourceAgeMs','nativeCommitMs'])s[field]=current[field];this.db.prepare('UPDATE inbox_subs SET body=? WHERE identity=?').run(JSON.stringify(s),key(s.scope,s.subscriptionId));}
 /** CAS changes cannot reroute durable identities or change the initial baseline.
  * Pause/resume retains history and consumer positions; there is no deletion API. */
 save(scope,input){
  this.authorize(scope,true);const v=subscriptionInput.parse(input);this.hub.access(scope,v.connectionId,v.conversationId);
  if(v.autoAudio&&this.hub.config.connections[v.connectionId]?.plugin!=='mts'&&!this.hub.media?.asr)throw new HubError('asr_not_configured',{nextAction:'Configure the selected media ASR purpose privately or choose autoAudio:false; no fallback.'});
  return this.transaction(()=>{
   const identity=key(scope,v.subscriptionId),row=this.db.prepare('SELECT * FROM inbox_subs WHERE identity=?').get(identity),prior=parse(row);
   if(!prior&&this.db.prepare('SELECT COUNT(*) n FROM inbox_subs WHERE scope=?').get(scope).n>=100)throw new HubError('subscription_limit');
   if((prior?.revision??0)!==v.revision)throw new HubError('revision_conflict');
   if(row?.lock_owner&&processAlive(row.lock_owner))throw new HubError('subscription_busy');
   if(prior&&(prior.connectionId!==v.connectionId||prior.conversationId!==v.conversationId||prior.topicId!==v.topicId||prior.initialHistory!==v.initialHistory))throw new HubError('subscription_identity_immutable');
   const {acknowledgeGap,...spec}=v,s={...prior,...spec,scope,createdAt:prior?prior.createdAt??null:new Date(this.now()).toISOString(),activeSince:prior?.enabled===v.enabled?prior.activeSince??prior.createdAt??null:v.enabled?new Date(this.now()).toISOString():prior?.activeSince??null,revision:v.revision+1,status:v.enabled?'pending':'paused',nextPollAt:0,coverage:prior?.coverage??{mode:'provider_history_poll',initialHistory:v.initialHistory,complete:false,gap:false,edits:'overlap_plus_periodic_available_history_rescan',deletions:'explicit_tombstones_only',providerCompleteness:'not_guaranteed'}};
   if(acknowledgeGap){s.coverage.gap=false;s.cycle=null;this.audit(scope,'acknowledge_gap',identity);}
   this.db.prepare('INSERT INTO inbox_subs VALUES(?,?,?,NULL) ON CONFLICT(identity) DO UPDATE SET body=excluded.body,lock_owner=NULL').run(identity,scope,JSON.stringify(s));this.audit(scope,'subscription_save',identity);return this.publicSub(s);
  });
 }
 publicSub(s){const {scope,cycle,head,...r}=s;const counts={};if(this.hub.media)for(const f of this.db.prepare('SELECT file FROM inbox_media WHERE subscription=?').all(key(scope,s.subscriptionId))){try{const file=this.hub.media.get(f.file);const t=file.transcription.status;counts[t]=(counts[t]??0)+1;}catch{counts.unavailable=(counts.unavailable??0)+1;}}return {...r,cutover:cutover(s),initialHistoryBehavior:'retain_all_events_filter_in_consumer',transportMode:this.hub.native?.describe(scope,s.connectionId).mode??'history_poll',rawArrival:'journal_commit_immediate',settleAppliesTo:'claim_only',workerEnabled:this.workerEnabled(scope),syncAgeMs:s.lastSuccessAt?Math.max(0,this.now()-Date.parse(s.lastSuccessAt)):null,collection:{continuationPending:!!cycle,pagesInCycle:cycle?.pages??0},media:counts};}
 status(scope,input){this.authorize(scope);const v=subscriptionStatusInput.parse(input);if(v.subscriptionId)return this.publicSub(this.sub(scope,v.subscriptionId));const items=[];for(const row of this.db.prepare('SELECT body FROM inbox_subs WHERE scope=?').all(scope)){const s=parse(row);try{this.hub.access(scope,s.connectionId,s.conversationId);items.push(this.publicSub(s));}catch{/* Revoked routes must not leak their cached status. */}}return {workerEnabled:this.workerEnabled(scope),workerDiagnostic:this.workerDiagnostic??null,items};}
 consumer(scope,input){this.authorize(scope);const v=consumerInput.parse(input);v.subscriptionIds=[...new Set(v.subscriptionIds)].sort();for(const id of v.subscriptionIds)this.sub(scope,id);
  return this.transaction(()=>{const identity=key(scope,v.consumerId),prior=parse(this.db.prepare('SELECT body FROM inbox_consumers WHERE identity=?').get(identity));
   if(prior){if(hash(prior.spec)!==hash(v))throw new HubError('consumer_identity_immutable');return {consumerId:v.consumerId,offset:prior.offset,subscriptionIds:v.subscriptionIds};}
   const subs=v.subscriptionIds.map(x=>key(scope,x));
   const offset=v.start==='now'?this.db.prepare(`SELECT COALESCE(MAX(sequence),0) n FROM inbox_events WHERE subscription IN (${subs.map(()=>'?').join(',')})`).get(...subs).n:0;
   this.db.prepare('INSERT INTO inbox_consumers VALUES(?,?)').run(identity,JSON.stringify({spec:v,offset,batchId:null}));this.audit(scope,'consumer_create',identity);return {consumerId:v.consumerId,offset,subscriptionIds:v.subscriptionIds};
  });
 }
 getConsumer(scope,id){this.authorize(scope);const c=parse(this.db.prepare('SELECT body FROM inbox_consumers WHERE identity=?').get(key(scope,id)));if(!c)throw new HubError('consumer_not_found');for(const sub of c.spec.subscriptionIds)this.sub(scope,sub);return c;}
 setConsumer(scope,id,c){this.db.prepare('UPDATE inbox_consumers SET body=? WHERE identity=?').run(JSON.stringify(c),key(scope,id));}
 /** Snapshot a settled contiguous prefix, then persist its receipt before reply.
  * Expiration redelivers the exact same immutable batch, with a new lease token.
  * Unsettled events block later events; no offset may skip unacknowledged work. */
 claim(scope,input){const v=claimInput.parse(input);return this.transaction(()=>{
  const c=this.getConsumer(scope,v.consumerId),identity=key(scope,v.consumerId);
  if(c.batchId){const b=parse(this.db.prepare('SELECT body FROM inbox_batches WHERE id=? AND consumer=?').get(c.batchId,identity));if(b.expiresAt<=this.now()){b.leaseToken=randomUUID();b.expiresAt=this.now()+v.leaseMs;this.db.prepare('UPDATE inbox_batches SET body=? WHERE id=?').run(JSON.stringify(b),b.batchId);}return b;}
  const subs=c.spec.subscriptionIds.map(x=>key(scope,x)),rows=this.db.prepare(`SELECT sequence,id,subscription,available_at FROM inbox_events WHERE sequence>? AND subscription IN (${subs.map(()=>'?').join(',')}) ORDER BY sequence LIMIT ?`).all(c.offset,...subs,v.limit+1);
  const b={status:'leased',batchId:randomUUID(),leaseToken:randomUUID(),consumerId:v.consumerId,expiresAt:this.now()+v.leaseMs,from:c.offset,to:c.offset,items:[],hasMore:false};
  for(const row of rows){if(b.items.length>=v.limit||row.available_at>this.now()){b.hasMore=true;break;}
   const e=parse(this.db.prepare('SELECT body FROM inbox_events WHERE id=?').get(row.id)),s=this.sub(scope,e.subscriptionId);if(row.available_at>this.now()||s.lastActivityAt&&this.now()-s.lastActivityAt<s.settleMs){b.hasMore=true;break;}
   const item=this.brief(e,v.maxTextChars);b.items.push(item);b.to=row.sequence;
   if(resultChars(b)>v.maxResponseChars){b.items.pop();b.to=b.items.at(-1)?.sequence??c.offset;
    if(!b.items.length){b.items.push({eventId:e.eventId,sequence:row.sequence,subscriptionId:e.subscriptionId,source:e.source,kind:e.kind,version:e.version,detailsOmitted:true});b.to=row.sequence;}
    b.hasMore=true;break;
   }
  }
  if(!b.items.length)return {status:'empty',consumerId:v.consumerId,offset:c.offset,hasMore:b.hasMore};
  if(resultChars(b)>v.maxResponseChars)throw new HubError('inbox_response_budget_too_small',{nextAction:'Increase maxResponseChars; no consumer offset was advanced.'});
  this.db.prepare('INSERT INTO inbox_batches VALUES(?,?,?)').run(b.batchId,identity,JSON.stringify(b));c.batchId=b.batchId;this.setConsumer(scope,v.consumerId,c);return JSON.parse(JSON.stringify(b));
 });}
 /** Older retained snapshots gain additive provenance without changing their
  * immutable source body/version. Missing native evidence remains unknown. */
 provenance(e){return {...e,ingestion:readOrigin(e),receivedAt:e.receivedAt??e.observedAt,sourceTimestamp:e.sourceTimestamp??e.message.at,sourceUrl:e.sourceUrl??e.message.sourceUrl??null,author:{...e.author,displayName:typeof e.author?.displayName==='string'?e.author.displayName:e.message.authorLabel??null,labelTrusted:false,labelEvidence:typeof e.author?.displayName==='string'||e.message.authorLabel?'provider_display_metadata':'unavailable',id:e.message.senderId,isSelf:e.message.isSelf??null,evidence:e.message.isSelf==null?'unavailable':'native_sender_and_account_identity'},replyEvidence:e.replyEvidence??{replyTo:e.message.replyTo,referenceKnown:e.message.replyToKnown??(e.message.replyTo?true:null),quoteAvailable:false}};}
 brief(e,n){e=this.provenance(e);const cut=t=>typeof t==='string'&&t.length>n?{text:t.slice(0,n),textLength:t.length,textTruncated:true}:{text:t};
  const m=e.message;return {...e,message:{...m,...cut(m.text),...(m.mentionEvidence&&typeof m.text==='string'&&m.text.length>n?{mentionEvidence:{...m.mentionEvidence,complete:false,errorCode:'text_truncated'}}:{}),sourceText:undefined,segments:undefined,attachments:m.attachments.map(a=>({fileId:a.fileId,id:a.id,kind:a.kind,filename:a.filename,mimeType:a.mimeType,size:a.size,...(a.video?{video:a.video}:{}),transcription:a.transcription?{...a.transcription,...cut(a.transcription.text),transitions:undefined,segments:undefined}:undefined}))},context:e.context.map(m=>({id:m.id,direction:m.direction,at:m.at,...cut(m.text)})),fullEventAvailable:true};
 }
 ack(scope,input){const v=ackInput.parse(input);return this.transaction(()=>{
  const c=this.getConsumer(scope,v.consumerId),row=this.db.prepare('SELECT body FROM inbox_batches WHERE id=? AND consumer=?').get(v.batchId,key(scope,v.consumerId)),b=parse(row);
  if(!b||b.leaseToken!==v.leaseToken)throw new HubError('inbox_receipt_invalid');if(b.acknowledgedAt)return {status:'acknowledged',batchId:b.batchId,offset:b.to};
  if(c.batchId!==b.batchId||b.expiresAt<=this.now())throw new HubError('inbox_lease_expired');
  b.acknowledgedAt=new Date(this.now()).toISOString();c.offset=b.to;c.batchId=null;this.db.prepare('UPDATE inbox_batches SET body=? WHERE id=?').run(JSON.stringify(b),b.batchId);this.setConsumer(scope,v.consumerId,c);this.audit(scope,'ack',b.batchId);return {status:'acknowledged',batchId:b.batchId,offset:c.offset};
 });}
 event(scope,input){const v=eventInput.parse(input),c=this.getConsumer(scope,v.consumerId),row=this.db.prepare('SELECT * FROM inbox_events WHERE id=?').get(v.eventId);if(!row||!c.spec.subscriptionIds.some(x=>key(scope,x)===row.subscription))throw new HubError('inbox_event_not_found');return this.provenance(JSON.parse(row.body));}
 /** A source version hashes native content only. Dynamic file paths/ASR state
  * cannot fabricate edits; every emitted snapshot remains immutable afterward. */
 observe(s,m,evidence={}){
  // A provider can index a call before assigning its recording UUID. Retain
  // the first observed call identity when that UUID arrives, across restarts.
  if(this.hub.config.connections[s.connectionId]?.plugin==='mts'){
   let parts;try{parts=JSON.parse(m.id);}catch{}
   const prior=Array.isArray(parts)?this.db.prepare("SELECT body FROM inbox_sources WHERE subscription=? AND json_valid(message) AND json_extract(message,'$[0]')=? LIMIT 1").get(key(s.scope,s.subscriptionId),parts[0]):null;
   if(prior){const p=parse(prior);if(p.id!==m.id&&JSON.parse(p.id)[1]==='')m={...m,id:p.id,attachments:m.attachments.map(a=>({...a,id:p.id}))};}
  }
  if(m.mentionEvidence)m={...m,mentionEvidence:checkedMentions(m.text,m.mentionEvidence)};this.hub.cache?.observe(s.connectionId,m);const sub=key(s.scope,s.subscriptionId),identity=key(sub,m.id),old=this.db.prepare('SELECT * FROM inbox_sources WHERE identity=?').get(identity),baseline=old&&this.hub.config.connections[s.connectionId]?.plugin==='mts'?parse(this.db.prepare("SELECT body FROM inbox_events WHERE subscription=? AND json_extract(body,'$.message.id')=? AND json_extract(body,'$.version')=? ORDER BY sequence LIMIT 1").get(sub,m.id,old.version))?.message:null,digest=hash(Object.fromEntries(Object.entries(m).filter(([k])=>k!=='authorLabel'&&(k!=='callState'||this.hub.config.connections[s.connectionId]?.plugin!=='mts')).map(([k,v])=>[k,k==='attachments'&&this.hub.config.connections[s.connectionId]?.plugin==='mts'?v.map(({transcription,...native})=>({...native,size:old?(baseline??parse(old)).attachments.find(a=>a.id===native.id)?.size??null:native.size})):v])));const stored=parse(this.db.prepare('SELECT body FROM inbox_origins WHERE identity=?').get(identity)),valid=originEnvelope.safeParse(stored),ingestion=classify(s,m,valid.success?valid.data.sourceOrigin:null,!!old,evidence,this.now());
  // A late MTS transcript changes media evidence, never the native call version.
  if(old?.digest===digest){if(this.hub.media&&this.hub.config.connections[s.connectionId]?.plugin==='mts')for(const a of m.attachments)this.hub.media.register(s.connectionId,m,a);if(ingestion.activity.triage==='fresh'&&evidence?.producer&&(!valid.success||valid.data.observation.providerEventId!==evidence.providerEventId)){if(ingestion.activity.classification==='live_create')ingestion.activity={classification:'origin_confirmed',basis:'live_callback_confirms_existing_discovery',triage:'fresh'};this.db.prepare('INSERT OR REPLACE INTO inbox_origins VALUES(?,?)').run(identity,JSON.stringify(ingestion));if(s.direction==='all'||m.direction==='inbound')this.emit(s,{kind:'source_evidence_updated',version:old.version,message:parse(old),ingestion,source:{sourceId:hash([s.connectionId,s.conversationId,m.id]),connectionId:s.connectionId,conversationId:s.conversationId,...(m.topicId?{topicId:m.topicId}:{}),messageId:m.id,versionHash:digest}});}return;}
  this.db.prepare('INSERT OR REPLACE INTO inbox_origins VALUES(?,?)').run(identity,JSON.stringify(ingestion));
  const version=(old?.version??0)+1;let enriched={...m,attachments:[...m.attachments]};
  if(this.hub.media)enriched.attachments=m.attachments.map(a=>{let f=this.hub.media.register(s.connectionId,m,a);
   // Pin the purpose even when automatic recognition is off: a later explicit
   // retry selects the configured purpose without erasing ready historical text.
   if(audio(a)&&f.requiredAsr!==this.hub.media.requiredProvider(f))f=this.hub.media.save({...f,requiredAsr:this.hub.media.requiredProvider(f)});this.db.prepare('INSERT OR IGNORE INTO inbox_media(identity,subscription,file) VALUES(?,?,?)').run(key(sub,f.id),sub,f.id);const metadata=this.hub.media.metadata(f);return metadata;});
  // Archive speech is retained as provider evidence, never presented as new
  // new recognition. Calls expose speech only through their audio result.
  if(m.kind==='call'&&m.attachments.some(audio)){enriched.sourceText=m.text;enriched.text=null;enriched.segments=undefined;}
  this.db.prepare('INSERT INTO inbox_sources VALUES(?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET digest=excluded.digest,version=excluded.version,body=excluded.body').run(identity,sub,m.id,digest,version,JSON.stringify(enriched));
  if(s.direction==='all'||m.direction==='inbound')this.emit(s,{kind:m.deletedAt?'message_deleted':old?'message_updated':'message_created',version,message:enriched,ingestion,source:{sourceId:hash([s.connectionId,s.conversationId,m.id]),connectionId:s.connectionId,conversationId:s.conversationId,...(m.topicId?{topicId:m.topicId}:{}),messageId:m.id,versionHash:digest}});
 }
 emit(s,value){const sub=key(s.scope,s.subscriptionId),eventId=randomUUID(),receivedAt=new Date(this.now()).toISOString(),e={eventId,subscriptionId:s.subscriptionId,observedAt:receivedAt,receivedAt,sourceTimestamp:value.message.at,sourceUrl:value.message.sourceUrl??null,replyEvidence:{replyTo:value.message.replyTo,referenceKnown:value.message.replyToKnown??(value.message.replyTo?true:null),quoteAvailable:false},author:{id:value.message.senderId,...(value.message.authorLabel?{displayName:value.message.authorLabel,labelEvidence:'provider_display_metadata',labelTrusted:false}:{displayName:null,labelEvidence:'unavailable',labelTrusted:false}),isSelf:value.message.isSelf??null,evidence:value.message.isSelf==null?'unavailable':'native_sender_and_account_identity'},...value,context:[]};
  const context=this.db.prepare('SELECT body FROM inbox_sources WHERE subscription=? AND message<>? AND json_extract(body,\'$.at\')<=? ORDER BY json_extract(body,\'$.at\') DESC LIMIT 5').all(sub,value.message.id,value.message.at).map(parse);
  // Reply context is exact if already observed; unresolved is explicit, never guessed by text.
  const reply=value.message.replyTo?parse(this.db.prepare('SELECT body FROM inbox_sources WHERE identity=?').get(key(sub,value.message.replyTo))):null;
  e.context=[...(reply?[reply]:[]),...context.filter(x=>x.id!==reply?.id)].slice(0,5);e.replyContextKnown=!!reply||value.message.replyToKnown===true&&!value.message.replyTo;
  const seq=this.db.prepare('INSERT INTO inbox_events(id,subscription,body,available_at) VALUES(?,?,?,?)').run(eventId,sub,JSON.stringify(e),this.now()+s.settleMs).lastInsertRowid;e.sequence=Number(seq);this.db.prepare('UPDATE inbox_events SET body=? WHERE id=?').run(JSON.stringify(e),eventId);s.lastActivityAt=this.now();
  // Publish only after the caller commits; listeners read the durable journal.
  queueMicrotask(()=>{if(!this.closed)this.changes.emit('observed');});
 }
 /** Late ready/failed media becomes a new event tied to the original source
  * version. Interrupted uploads are reported, never silently billed again. */
 mediaChanged(f){if(this.closed||!this.hub.media)return;for(const row of this.db.prepare('SELECT * FROM inbox_media WHERE file=?').all(f.id)){
  const s=parse(this.db.prepare('SELECT body FROM inbox_subs WHERE identity=?').get(row.subscription));if(!s)continue;
  try{this.authorize(s.scope);this.hub.access(s.scope,s.connectionId,s.conversationId);}catch{continue;}
  // Video readiness supplements retain the source's history/live affiliation.
  // Progress alone never wakes triage, and paid unknown receipts are not retries.
  const video=f.metadata.kind==='video'&&f.videoReview;
  if(video?!['ready','failed','submission_unknown'].includes(video.status):f.transcriptionOwner!=='mts_mcp'&&!['ready','no_transcript','failed','interrupted','too_large'].includes(f.transcription.status))continue;
  const digest=hash(video?{videoReview:video}:f.transcriptionOwner==='mts_mcp'?{transcription:f.transcription,callState:f.message.callState??null,size:f.metadata.size}:f.transcription);if(row.digest===digest)continue;
  this.transaction(()=>{const source=this.db.prepare('SELECT * FROM inbox_sources WHERE identity=?').get(key(row.subscription,f.messageId));if(!source)return;const m=parse(source),i=m.attachments.findIndex(a=>a.fileId===f.id);if(i<0)return;m.attachments[i]=this.hub.media.metadata(f);if(f.message.callState)m.callState=f.message.callState;this.db.prepare('UPDATE inbox_sources SET body=? WHERE identity=?').run(JSON.stringify(m),source.identity);this.db.prepare('UPDATE inbox_media SET digest=?,revision=revision+1 WHERE identity=?').run(digest,row.identity);const prior=readOrigin({ingestion:parse(this.db.prepare('SELECT body FROM inbox_origins WHERE identity=?').get(source.identity)),observedAt:new Date(this.now()).toISOString()});const ingestion={...prior,observation:{...prior.observation,transport:video?'palatine_video_review_media':f.transcriptionOwner==='mts_mcp'?'mts_archive_media':f.transcription.source+'_media',phase:'late_media'},activity:{classification:'media_update',basis:'original_source_affiliation_retained',triage:prior.sourceOrigin.classification==='historical_snapshot'?'historical':prior.sourceOrigin.classification==='live_native'?'fresh':'review'}};this.emit(s,{ingestion,kind:video?(video.status==='ready'?'media_ready':video.status==='failed'?'media_failed':'media_updated'):f.transcription.status==='ready'?'media_ready':['failed','interrupted','too_large'].includes(f.transcription.status)?'media_failed':'media_updated',version:source.version,mediaRevision:row.revision+1,fileId:f.id,source:{sourceId:hash([s.connectionId,s.conversationId,f.messageId]),connectionId:s.connectionId,conversationId:s.conversationId,...(m.topicId?{topicId:m.topicId}:{}),messageId:f.messageId,versionHash:source.digest},message:m});this.saveSub(s);});
 }}
 collectMedia(s){if(!this.hub.media)return;s.mediaDiagnostic=null;for(const row of this.db.prepare('SELECT file FROM inbox_media WHERE subscription=?').all(key(s.scope,s.subscriptionId))){let f=this.hub.media.get(row.file);const current=parse(this.db.prepare('SELECT body FROM inbox_sources WHERE identity=?').get(key(key(s.scope,s.subscriptionId),f.messageId)));if(!current||current.deletedAt||!current.attachments.some(a=>a.fileId===f.id))continue;if(s.autoAudio&&audio(f.metadata)&&!f.message.deletedAt){try{this.hub.media.start(s.scope,f.id,false);}catch(e){s.mediaDiagnostic=diagnostic(e,'subscription_asr');}}f=this.hub.media.get(row.file);this.mediaChanged(f);}const current=parse(this.db.prepare('SELECT body FROM inbox_subs WHERE identity=?').get(key(s.scope,s.subscriptionId)));this.saveSub({...current,mediaDiagnostic:s.mediaDiagnostic});}
 start(){if(!this.config.enabled||this.timer)return;const run=()=>void this.tick().catch(e=>{this.workerDiagnostic=diagnostic(e,'inbox_worker');});this.timer=setInterval(run,this.config.tickMs);this.timer.unref();run();}
 // Old due times run first: a multi-page archive must not monopolize every
 // slot and starve newly added channels while its initial scan continues.
 async tick(){if(this.closed||this.stopping)return;for(const row of this.db.prepare("SELECT * FROM inbox_subs ORDER BY json_extract(body,'$.nextPollAt'),identity").all()){
  const s=parse(row);if(this.config.workerScopes&&!this.config.workerScopes.includes(s.scope))continue;if(this.jobs.size>=this.config.workers)break;
  if(!s.enabled||s.nextPollAt>this.now()||this.jobs.has(row.identity))continue;
  if(row.lock_owner&&processAlive(row.lock_owner))continue;
  const acquired=this.transaction(()=>{const current=this.db.prepare('SELECT * FROM inbox_subs WHERE identity=?').get(row.identity);if(current.lock_owner&&processAlive(current.lock_owner))return false;this.db.prepare('UPDATE inbox_subs SET lock_owner=? WHERE identity=?').run(this.owner,row.identity);return true;});if(!acquired)continue;
  const job=this.poll(s).finally(()=>{this.db.prepare('UPDATE inbox_subs SET lock_owner=NULL WHERE identity=? AND lock_owner=?').run(row.identity,this.owner);this.jobs.delete(row.identity);});this.jobs.set(row.identity,job);
 }await Promise.allSettled(this.jobs.values());}
 async poll(s){try{
  this.authorize(s.scope);this.hub.access(s.scope,s.connectionId,s.conversationId);s.status='syncing';this.saveSub(s);
  // A cached history read succeeding does not prove upstream MTS freshness.
  if(this.hub.config.connections[s.connectionId]?.plugin==='mts'){try{s.sourceSync=(await this.hub.access(s.scope,s.connectionId,s.conversationId).instance.health()).sourceSync;}catch(e){s.sourceSync={errorCode:e.code??'archive_unavailable'};}}
  // MTS is a local cache: revisit older pending calls within a minute so
  // delayed transcripts do not wait for the ordinary daily remote rescan.
  const cycle=s.cycle??{cursor:null,pages:0,previousHead:s.head??[],head:[],overlap:false,full:!s.initialized||this.now()-(s.lastFullScanAt??0)>=(this.hub.config.connections[s.connectionId]?.plugin==='mts'?Math.min(s.fullRescanMs,60000):s.fullRescanMs),baseline:false,initial:!s.initialized};
  // Upgrade an unfinished legacy from_now cycle without suppressing any further pages.
  cycle.baseline=false;cycle.initial??=!s.initialized;
  for(let n=0;n<this.config.pagesPerTick;n++){
   const p=await this.hub.readHistory(s.scope,{connectionId:s.connectionId,conversationId:s.conversationId,cursor:cycle.cursor,limit:this.config.pageSize});
   this.authorize(s.scope);this.hub.access(s.scope,s.connectionId,s.conversationId);
   if(p.next!==null&&p.next===cycle.cursor)throw new HubError('provider_cursor_stalled');
   // Persist page snapshots and next provider cursor in one transaction. Crashes
   // replay a page harmlessly; no provider progress precedes its durable events.
   this.transaction(()=>{
    if(!cycle.pages)cycle.head=p.items.map(x=>x.id);cycle.pages++;
    if(p.items.some(m=>cycle.previousHead.includes(m.id)))cycle.overlap=true;
    for(const m of [...p.items].filter(m=>s.topicId===undefined||m.topicId===s.topicId).sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id)))this.observe(s,m,{transport:'history_poll',phase:cycle.initial?'initial_snapshot':cycle.full?'recovery_rescan':'overlap',providerWindowComplete:p.complete});
    const end=!p.next,stop=cycle.baseline||!cycle.full&&cycle.overlap&&cycle.pages>=this.config.overlapPages||end;
    s.coverage={...s.coverage,complete:end&&p.complete,scannedPages:cycle.pages,gap:s.coverage.gap||!!(s.initialized&&cycle.previousHead.length&&!cycle.overlap&&end),caughtUp:stop&&(cycle.baseline||cycle.overlap||!s.initialized&&end&&p.complete),lastPollAt:new Date(this.now()).toISOString()};
    if(end&&!p.complete)s.coverage.gap=true;
    if(stop){if(cycle.full&&end&&p.complete)s.lastFullScanAt=this.now();s.head=cycle.head;s.cycle=null;s.initialized=true;s.lastSuccessAt=new Date(this.now()).toISOString();s.status=s.coverage.gap?'history_gap':'active';s.nextPollAt=this.now()+s.pollMs;}
    else{cycle.cursor=p.next;s.cycle=cycle;s.nextPollAt=this.now();s.status='catching_up';}
    s.diagnostic=null;this.saveSub(s);
   });if(!s.cycle)break;
  }
  this.collectMedia(s);
 }catch(e){s.status=/not_authorized|http_401|session_expired|auth_key/.test(e.code??'')?'authorization_lost':/chat_access_denied|permission_denied|http_403/.test(e.code??'')?'access_denied':'provider_error';s.diagnostic=diagnostic(e,'subscription_sync');s.nextPollAt=this.now()+s.pollMs;this.saveSub(s);}}
 async call(scope,method,input){if(method==='inbox_projects')return this.read.projects(scope,input);if(method==='inbox_replay')return this.read.replay(scope,input);if(method==='inbox_context')return this.read.context(scope,input);if(method==='inbox_diagnostics')return this.read.diagnostics(scope,input);if(method==='subscription_save')return this.save(scope,input);if(method==='subscription_status')return this.status(scope,input);if(method==='inbox_consumer_ensure')return this.consumer(scope,input);if(method==='inbox_claim')return this.claim(scope,input);if(method==='inbox_ack')return this.ack(scope,input);if(method==='inbox_event_get')return this.event(scope,input);throw new HubError('method_unknown');}
 async stop(){this.stopping=true;clearInterval(this.timer);await Promise.allSettled(this.jobs.values());}
 async close(){await this.stop();this.closed=true;this.db.close();}
}
