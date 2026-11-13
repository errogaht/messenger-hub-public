import {CodexLBASR,codexlbConfig} from './codexlb-asr.mjs';
import {PalatineASR,palatineConfig} from './palatine.mjs';
import {diagnostic} from './errors.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,createReadStream} from 'node:fs';
import {readFile,writeFile,copyFile,stat,realpath,rename,unlink,open} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {HubError,key} from './contracts.mjs';

const execute=promisify(execFile);
// Legacy keyFile/asrUrl/asrTimeoutMs are accepted only for config compatibility;
// executable recognition settings belong to the explicitly selected ASR purpose.
export const mediaConfig=z.object({root:z.string(),asrProvider:z.enum(['palatine','codexlb']).default('palatine'),codexlb:codexlbConfig.optional(),palatine:palatineConfig.optional(),keyFile:z.string().optional(),asrUrl:z.string().url().refine(v=>v.startsWith('https://')).optional(),autoAudio:z.boolean().default(true),historyWaitMs:z.number().int().min(0).max(30000).default(15000),asrTimeoutMs:z.number().int().min(1000).max(120000).default(60000),maxFileBytes:z.number().int().positive().max(512*1024*1024).default(256*1024*1024),maxAudioBytes:z.number().int().positive().max(25*1024*1024).default(25*1024*1024),maxAudioSeconds:z.number().positive().max(7200).default(1200),maxCallSeconds:z.number().positive().max(7200).default(3600),maxVideoSeconds:z.number().positive().max(7200).default(3600),workers:z.number().int().min(1).max(4).default(2)}).strict();
export const batchFileInput=z.object({fileIds:z.array(z.string().uuid()).min(1).max(20),waitMs:z.number().int().min(0).max(25000).default(25000)}).strict();
export const fileInput=z.object({fileId:z.string().uuid().describe('Hub file UUID from attachments[].fileId, e.g. 11111111-1111-4111-8111-111111111111. Not attachments[].id (provider attachmentId).')}).strict();
export const downloadInput=fileInput.extend({waitMs:z.number().int().min(0).max(25000).default(25000)}).strict();
export const transcriptionInput=fileInput.extend({waitMs:z.number().int().min(0).max(30000).default(0),retry:z.boolean().default(false)}).strict();
const isAudio=a=>/^(audio|voice|ptt)$/i.test(a.kind)||a.mimeType?.startsWith('audio/');
const isVideo=a=>/video/i.test(a.kind)||a.mimeType?.startsWith('video/');
const safeName=name=>path.basename(name||'attachment.bin').replace(/[\r\n\x00-\x1f]/g,'_').slice(0,180);

/** Private media registry and bounded work queue; UUIDs never replace route authorization. */
export class MediaService {
 constructor(hub,config,deps={}){
  this.hub=hub;this.config=config;this.root=path.resolve(config.root);mkdirSync(this.root,{recursive:true,mode:0o700});chmodSync(this.root,0o700);
  this.db=new DatabaseSync(path.join(this.root,'media.sqlite'));chmodSync(path.join(this.root,'media.sqlite'),0o600);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,route TEXT UNIQUE NOT NULL,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS transcripts(digest TEXT PRIMARY KEY,text TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS palatine_results(digest TEXT PRIMARY KEY,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS historical_transcripts(file TEXT PRIMARY KEY,body TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS files_chat ON files(json_extract(body,'$.connectionId'),json_extract(body,'$.conversationId'));
  `);
  // Provider changes preserve ready text and failed receipts. Explicit retry uses
  // the new purpose; never re-upload all historical files on installation.
  // An interrupted billable request is never silently retried after restart.
  for(const row of this.db.prepare('SELECT id,body FROM files').all()){const f=JSON.parse(row.body);if(f.download?.status==='running'){f.download={...f.download,status:'interrupted',error:'service_restarted'};this.save(f);}if(['queued','running'].includes(f.transcription?.status)){f.transcription={status:'interrupted',text:null,error:'service_restarted',...(f.transcription.source?{source:f.transcription.source}:{})};this.save(f);}}
  this.asrProvider=config.asrProvider??'palatine';this.codexlb=config.codexlb?(deps.codexlb??new CodexLBASR(config.codexlb,config.maxAudioBytes)):null;this.palatine=config.palatine?(deps.palatine??new PalatineASR(config.palatine,config.maxAudioBytes)):null;this.probe=deps.probe??probeMedia;this.extract=deps.extract??extractAudio;
  this.jobs=new Map();this.downloads=new Map();this.digestJobs=new Map();this.queue=[];this.active=0;this.closed=false;
 }
 /** MTS retains upstream ownership; all other media uses the configured purpose. */
 requiredProvider(f){return f.transcriptionOwner==='mts_mcp'?'palatine':this.asrProvider;}
 get asr(){return this[this.asrProvider];}
 save(f){
  // Keep observable lifecycle evidence even when queued/running completes between client polls.
  const old=this.db.prepare('SELECT body FROM files WHERE id=?').get(f.id);const previous=old?JSON.parse(old.body).transcription:null;
  if(f.transcription){const transitions=previous?.transitions??[];f.transcription={...f.transcription,transitions:previous?.status!==f.transcription.status?[...transitions,{status:f.transcription.status,at:new Date().toISOString()}].slice(-20):transitions};}
  this.db.prepare('UPDATE files SET body=? WHERE id=?').run(JSON.stringify(f),f.id);
  // Defer completion publication until any caller transaction has committed.
  queueMicrotask(()=>{try{if(!f.derivativeOf)this.hub.inbox?.mediaChanged(f);}catch{/* Durable media state is reconciled on the next subscription poll. */}});return f;}
 get(id){const row=this.db.prepare('SELECT body FROM files WHERE id=?').get(id);if(!row)throw new HubError('file_not_found');return JSON.parse(row.body);}
 authorize(scope,id){const f=this.get(id);this.hub.access(scope,f.connectionId,f.conversationId);return f;}
 register(connectionId,m,a){
  const {fileId,downloadUrl,downloadRequires,transcription,...native}=a;a=native;
  // Ownership is trusted adapter metadata, never a client-supplied label.
  const mts=this.hub.config.connections[connectionId]?.plugin==='mts';
  const supplied=mts&&transcription?.owner==='mts_mcp'&&transcription.source==='palatine'?transcription:null;
  const identity=key(connectionId,m.conversationId,m.id,a.id,a.providerVersion??null);
  const row=this.db.prepare('SELECT body FROM files WHERE route=?').get(identity);if(row){const old=JSON.parse(row.body);return this.save({...old,...(mts?{transcription:supplied??{status:'not_started',text:null,source:'palatine',owner:'mts_mcp'},transcriptionOwner:'mts_mcp'}:{}),requiredAsr:mts?'palatine':this.asrProvider,metadata:a,message:{...m,text:m.sourceText??m.text,attachments:[a]}});}
  const f={id:randomUUID(),connectionId,conversationId:m.conversationId,messageId:m.id,attachmentId:a.id,metadata:a,message:{...m,text:m.sourceText??m.text,attachments:[a]},transcription:{status:isVideo(a)?'not_requested':'not_started',text:null}};
  // MTS supplies verified Palatine cache results; other provider text remains
  // historical evidence and never satisfies this purpose's ASR.
  f.requiredAsr=mts?'palatine':this.asrProvider;if(mts){f.transcriptionOwner='mts_mcp';f.transcription=supplied??{status:'not_started',text:null,source:'palatine',owner:'mts_mcp'};}
  this.db.prepare('INSERT INTO files VALUES(?,?,?)').run(f.id,identity,JSON.stringify(f));return f;
 }
 url(f){return `http://127.0.0.1:${this.hub.config.port}/files/${f.id}`;}
 metadata(f){return {...f.metadata,...((f.videoThumbnail||f.videoReview)?{video:{...(f.metadata.video??{}),...(f.videoReview??{}),...(f.videoThumbnail?{thumbnailFileId:f.videoThumbnail.fileId}:{})}}:{}),filename:f.filename??f.metadata.filename,originalFilename:f.originalFilename??f.metadata.filename??f.filename??null,size:f.size??f.metadata.size,mimeType:f.mimeType??f.metadata.mimeType,fileId:f.id,downloadUrl:this.url(f),downloadRequires:'scoped Bearer header or messenger_file_download',transcription:this.transcriptionResult(f)};}
 /** The page has one shared wait budget; slow audio never holds all other messages indefinitely. */
 async enrich(scope,connectionId,page,{automatic=true,waitMs=this.config.historyWaitMs,hydrateMetadata=false}={}){
  const {instance}=this.hub.access(scope,connectionId);
  if(hydrateMetadata&&instance.attachmentInfo){
   for(const m of page.items)for(let i=0;i<m.attachments.length;i++){const a=m.attachments[i];if(!a.providerVersion)try{const info=await instance.attachmentInfo({conversationId:m.conversationId,messageId:m.id,attachmentId:a.id});if(info)m.attachments[i]=info;}catch{/* Existing descriptor remains useful if optional metadata is unavailable. */}}
  }
  const registered=[];
  for(const m of page.items)for(const a of m.attachments){const f=this.register(connectionId,m,a);registered.push(f.id);if(automatic&&this.config.autoAudio&&isAudio(a)&&f.transcription.status==='not_started'){try{this.start(scope,f.id,false);}catch(e){this.save({...f,transcription:{status:'failed',text:null,source:this.asrProvider,error:e instanceof HubError?e.code:'queue_failed'}});}}}
  if(waitMs>0){const pending=registered.map(id=>this.jobs.get(id)).filter(Boolean);if(pending.length)await boundedWait(Promise.allSettled(pending),waitMs);}
  return {...page,items:page.items.map(m=>{
   const attachments=m.attachments.map(a=>this.metadata(this.get(this.register(connectionId,m,a).id)));
   const texts=attachments.filter(a=>a.transcription.status==='ready'&&a.transcription.source!=='archive').map(a=>a.transcription.text);
   const sourceText=m.sourceText??m.text;
   return {...m,...(texts.length?{sourceText,text:[sourceText,...texts.map(t=>'[Транскрипция аудио]\n'+t)].filter(Boolean).join('\n\n')}:{}),attachments};
  })};
 }
 /** A prior provider rejection is immutable evidence, not a verdict on the new
  * purpose. Offer only an explicit scoped retry; never retry old failures on reads. */
 transcriptionResult(f){
  if(f.transcriptionOwner==='mts_mcp'&&f.transcription.error)return {...f.transcription,diagnostic:{...diagnostic(new HubError(f.transcription.error),'mts_transcription',f.id),nextAction:'MTS MCP owns recognition and paced recovery. Restore its key/balance or MTS login there; Hub refreshes the result automatically without re-uploading audio.'}};
  const t=f.transcription,detail=t.error?(t.diagnostic??diagnostic(new HubError(t.error),t.phase??'transcription',f.id)):null;
  const changed=t.status==='failed'&&t.source&&t.source!==this.asrProvider&&!!this.asr;
  return {...t,...(detail?{diagnostic:{...detail,...(changed?{failedProvider:t.source,currentProvider:this.asrProvider,canRetryUsingCurrentProvider:true,nextAction:'The recorded failure belongs to the previous provider. The owner may explicitly retry this same fileId with messenger_transcribe_media retry:true using the current configured provider. No automatic retry or fallback occurs.'}:{})}}:{})};
 }
 /** MCP waits are bounded independently of provider transfer time. A pending
  * result is not an error: the existing single-flight read continues, with
  * lifecycle persisted before I/O. Repeated calls recheck scope and join it.
  * Restart marks abandoned reads interrupted; only an explicit read retries. */
 async requestDownload(scope,input){
  const v=downloadInput.parse(input);const source=this.authorize(scope,v.fileId);
  if(source.path)return {...await this.download(scope,v.fileId),status:'ready'};
  const completed=this.download(scope,v.fileId).then(value=>({value}),error=>({error}));
  let timer;const result=await Promise.race([completed,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),v.waitMs);})]);clearTimeout(timer);
  if(result?.error)throw result.error;
  if(result)return {...result.value,status:'ready'};
  const {downloadDiagnostic,...file}=this.fileResult(this.authorize(scope,v.fileId));
  return {...file,status:'downloading',retryAfterMs:1000,nextAction:'Download is still running, not a service outage. Repeat messenger_file_download with the SAME fileId to join it. No ASR or send was started.'};
 }
 /** One shared page budget prevents a batch from exceeding MCP client timeout. */
 async batch(scope,input){const {fileIds,waitMs}=batchFileInput.parse(input),deadline=Date.now()+waitMs,results=[];
  for(const fileId of fileIds){try{const r=await this.requestDownload(scope,{fileId,waitMs:Math.max(0,deadline-Date.now())});const {transcription,...brief}=r;results.push({...brief,transcription:{status:transcription.status,characters:transcription.text?.length??0}});}catch(e){results.push({fileId,status:'failed',diagnostic:diagnostic(e,'download')});}}return {items:results};
 }
 async download(scope,id){
  const f=this.authorize(scope,id);if(f.path){await this.checkedPath(f.path);const detected=f.mimeDetected?{}:await detectMime(f.path);await this.normalizeFilename({...f,...detected});this.clearDownloadDiagnostic(id);return this.fileResult(this.get(id));}
  if(this.downloads.has(id)){await this.downloads.get(id);return this.fileResult(this.authorize(scope,id));}
  this.save({...f,download:{status:'running',startedAt:new Date().toISOString()}});
  const job=this.performDownload(scope,f);this.downloads.set(id,job);
  try{await job;this.save({...this.get(id),download:{...this.get(id).download,status:'ready',finishedAt:new Date().toISOString()}});return this.fileResult(this.authorize(scope,id));}catch(e){const latest=this.get(id),detail=diagnostic(e,'download',id);this.save({...latest,downloadDiagnostic:detail,download:{...latest.download,status:'failed',finishedAt:new Date().toISOString(),error:detail.code},...(latest.transcription?.status==='failed'&&['upstream_rejected','attachment_unavailable'].includes(latest.transcription.error)?{transcription:{...latest.transcription,error:detail.code,diagnostic:detail}}:{})});throw e;}finally{this.downloads.delete(id);}
 }
 /** The active download error describes current byte availability, not ASR or
  * historical attempts. Clear it only after bounded cache/new-byte validation;
  * fetch the latest row so concurrent transcript/audit updates are preserved. */
 clearDownloadDiagnostic(id){
  const f=this.get(id);if(!Object.hasOwn(f,'downloadDiagnostic')&&(!f.download||f.download.status==='ready'))return;
  const {downloadDiagnostic,...current}=f;this.save({...current,...(f.download?{download:{...f.download,status:'ready',finishedAt:f.download.finishedAt??new Date().toISOString()}}:{})});
 }
 /** Reuse the trusted file registry for a mistakenly supplied UUID, never a
  * name/format guess. Both the requested and registered route must be readable
  * and identical before cached bytes or a provider can be touched. */
 resolveAttachment(scope,v){
  if(!z.string().uuid().safeParse(v.attachmentId).success)return null;
  let f;try{f=this.get(v.attachmentId);}catch(e){if(e.code==='file_not_found')return null;throw e;}
  this.authorize(scope,f.id);
  if(f.connectionId!==v.connectionId||f.conversationId!==v.conversationId||f.messageId!==v.messageId)throw new HubError('attachment_route_mismatch');
  return f;
 }
 /** Native MCP image content uses the same authorized download/cache as files.
  * Bound inline bytes independently of download limits; no model, public URL,
  * arbitrary filesystem read or image decoding service is involved. */
 async imageContent(scope,id){
  const f=this.authorize(scope,id);
  if(!['image/jpeg','image/png','image/webp','image/gif'].includes(f.mimeType??f.metadata.mimeType))return null;
  const filename=await this.checkedPath(f.path);
  if((await stat(filename)).size>8*1024*1024)return null;
  return {type:'image',mimeType:f.mimeType??f.metadata.mimeType,data:(await readFile(filename)).toString('base64')};
 }
 async checkedPath(filename){const actual=await realpath(filename);if(!actual.startsWith(this.root+path.sep))throw new HubError('file_path_denied');const s=await stat(actual);if(!s.isFile()||s.size<1||s.size>this.config.maxFileBytes)throw new HubError('file_size_limit');return actual;}
 fileResult(f){return {fileId:f.id,filename:f.filename??f.metadata.filename,originalFilename:f.originalFilename??f.metadata.filename??f.filename??null,mimeType:f.mimeType??f.metadata.mimeType,size:f.size??f.metadata.size,path:f.path??null,downloadUrl:this.url(f),authorization:'Bearer required',sha256:f.digest??null,...(f.download?{download:f.download}:{}),...(f.downloadDiagnostic?{downloadDiagnostic:f.downloadDiagnostic}:{}),transcription:this.transcriptionResult(f)};}
 /** Keep provider names as evidence while the local extension describes actual bytes.
  * Copy instead of moving: concurrent downloads may still hold the old cached path. */
 async normalizeFilename(f){
  const extensions={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','audio/ogg':'.ogg','audio/wav':'.wav','audio/mpeg':'.mp3','application/pdf':'.pdf','video/mp4':'.mp4'};
  const originalFilename=f.originalFilename??f.filename??f.metadata.filename;
  let filename=f.filename??f.metadata.filename;
  const ext=f.mimeDetected?extensions[f.mimeType]:null;
  if(filename&&ext&&!(f.mimeType==='image/jpeg'&&/\.jpe?g$/i.test(filename))&&path.extname(filename).toLowerCase()!==ext){
   filename=path.basename(filename,path.extname(filename))+ext;
   const destination=path.join(this.root,f.id+'-'+safeName(filename));
   if(destination!==f.path){await copyFile(f.path,destination);chmodSync(destination,0o600);f={...f,path:destination};}
  }
  this.save({...f,filename,originalFilename});
 }
 async performDownload(scope,f){
  const {instance}=this.hub.access(scope,f.connectionId,f.conversationId);
  if(f.metadata.size>this.config.maxFileBytes)throw new HubError('file_size_limit');
  const args={connectionId:f.connectionId,conversationId:f.conversationId,messageId:f.messageId,attachmentId:f.attachmentId};
  if(instance.attachmentInfo&&f.metadata.providerVersion){const current=await instance.attachmentInfo(args);if(current?.providerVersion!==f.metadata.providerVersion)throw new HubError('attachment_changed');}
  const r=instance.attachmentFile?await instance.attachmentFile({...args,maxBytes:this.config.maxFileBytes}):await instance.attachment({...args,maxBytes:this.config.maxFileBytes});
  const filename=safeName(f.metadata.filename??r.filename),destination=path.join(this.root,f.id+'-'+filename),temp=destination+'.tmp';
  try{
   if(r.path){if(r.size>this.config.maxFileBytes)throw new HubError('file_size_limit');await copyFile(r.path,temp);}
   else {if(typeof r.base64!=='string'||r.base64.length>Math.ceil(this.config.maxFileBytes*4/3)+4)throw new HubError('file_size_limit');await writeFile(temp,Buffer.from(r.base64,'base64'),{mode:0o600});}
   chmodSync(temp,0o600);const size=(await stat(temp)).size;if(size<1||size>this.config.maxFileBytes)throw new HubError('file_size_limit');
   // Hash bounded file bytes; returned paths originate only in the trusted plugin's validated root.
   const hasher=createHash('sha256');for await(const chunk of createReadStream(temp))hasher.update(chunk);const digest=hasher.digest('hex');
   const detected=await detectMime(temp);
   await rename(temp,destination);await this.normalizeFilename({...this.get(f.id),path:destination,filename,size,mimeType:(r.mimeType&&r.mimeType!=='application/octet-stream'?r.mimeType:f.metadata.mimeType)??'application/octet-stream',digest,...detected});
   this.clearDownloadDiagnostic(f.id);
  }catch(e){await unlink(temp).catch(()=>{});throw e;}
 }
 start(scope,id,retry,source=this.asrProvider){
  // Existing completed evidence (speech or no transcript) survives provider changes; retry failed/interrupted
  // jobs explicitly. Active requests finish before a new job can start.
  const f=this.authorize(scope,id);source=this.asrProvider;
  // MTS owns retries, credentials and billing. A Hub retry must not upload a
  // second copy while waiting for the next archive refresh.
  if(f.transcriptionOwner==='mts_mcp'||this.hub.config.connections[f.connectionId]?.plugin==='mts')return;
  if(!this.asr)throw new HubError(source+'_not_configured');
  if(this.jobs.has(id))return;
  const switchProvider=f.transcription.source!==source&&!['ready','no_transcript'].includes(f.transcription.status)&&retry;
  if(!switchProvider&&(['ready','no_transcript'].includes(f.transcription.status)||!retry&&!['not_started','not_requested'].includes(f.transcription.status)))return;
  if(!isAudio(f.metadata)&&!isVideo(f.metadata))throw new HubError('file_not_audio_or_video');
  if(isAudio(f.metadata)&&f.metadata.size>this.config.maxFileBytes){this.save({...f,transcription:{status:'too_large',text:null,error:'audio_size_limit',source}});return;}
  if(this.closed)throw new HubError('service_closing');
  if(this.queue.length>=500)throw new HubError('transcription_queue_full');
  this.save({...f,transcription:{status:'queued',text:null,source}});
  let resolve;const promise=new Promise(r=>{resolve=r;});this.jobs.set(id,promise);this.queue.push({scope,id,source,resolve});this.pump();
 }
 pump(){while(!this.closed&&this.active<this.config.workers&&this.queue.length){const job=this.queue.shift();this.active++;void this.process(job.scope,job.id,job.source).catch(()=>{}).finally(()=>{this.active--;this.jobs.delete(job.id);job.resolve();this.pump();});}}
 async process(scope,id,source=this.asrProvider){
  try{
   let f=this.authorize(scope,id);this.save({...f,transcription:{status:'running',text:null,phase:'download',source}});
   await this.download(scope,id);f=this.authorize(scope,id);
   // Raw call recordings may exceed the bounded encoded upload; extraction
   // still has a strict per-request byte limit and never truncates speech.
   const info=await this.probe(f.path),video=isVideo(f.metadata);
   if(!info.hasAudio)throw new HubError('no_audio_track');
   if(info.duration>(video?this.config.maxVideoSeconds:f.message.kind==='call'?this.config.maxCallSeconds:this.config.maxAudioSeconds))throw new HubError('audio_duration_limit');
   const cacheKey=key(source,this.config[source],f.digest);
   const cached=this.db.prepare('SELECT body FROM palatine_results WHERE digest=?').get(cacheKey);
   let result=cached?JSON.parse(cached.body):undefined;
   if(result===undefined){
    if(!this.digestJobs.has(cacheKey)){
     const job=(async()=>{const audio=path.join(this.root,id+'.asr.mp3');try{
      this.save({...this.get(id),transcription:{status:'running',text:null,phase:'transcribe',source}});
      await this.extract(f.path,audio);if((await stat(audio)).size>this.config.maxAudioBytes)throw new HubError('audio_size_limit');
      this.authorize(scope,id);
      const result=this.asr.transcribeResult?await this.asr.transcribeResult(audio,'audio/mpeg'):{text:await this.asr.transcribe(audio,'audio/mpeg'),speakerAttribution:'unavailable'};
      this.db.prepare('INSERT OR REPLACE INTO palatine_results VALUES(?,?)').run(cacheKey,JSON.stringify(result));return result;
     }finally{await unlink(audio).catch(()=>{});}})();
     this.digestJobs.set(cacheKey,job);void job.finally(()=>this.digestJobs.delete(cacheKey)).catch(()=>{});
    }
    result=await this.digestJobs.get(cacheKey);
   }
   // Preserve an empty recognition as its own terminal result, including in digest cache.
   this.save({...this.get(id),transcription:{status:result.outcome==='no_transcript'?'no_transcript':'ready',...result,source,completedAt:new Date().toISOString()}});
  }catch(e){this.save({...this.get(id),transcription:{status:'failed',text:null,source,error:e instanceof HubError?e.code:'media_processing_failed',diagnostic:diagnostic(e,this.get(id).transcription?.phase??'transcription',id)}});}
 }
 async transcribe(scope,input){const v=transcriptionInput.parse(input);const f=this.authorize(scope,v.fileId);if(this.hub.config.connections[f.connectionId]?.plugin==='mts'){if(f.transcription.status!=='ready'){const {instance}=this.hub.access(scope,f.connectionId,f.conversationId);if(typeof instance.requestTranscription!=='function')throw new HubError('mts_prepare_unsupported');await instance.requestTranscription({conversationId:f.conversationId,messageId:f.messageId});}return this.fileResult(this.authorize(scope,v.fileId));}this.start(scope,v.fileId,v.retry);const job=this.jobs.get(v.fileId);if(job&&v.waitMs)await boundedWait(job,v.waitMs);return this.fileResult(this.authorize(scope,v.fileId));}
 cachedSearch(scope,route,query,limit){
  // Query only this authorized chat; cached audio is an observed subset, not a full-account search index.
  this.hub.access(scope,route.connectionId,route.conversationId);const matches=new Map();
  const rows=this.db.prepare("SELECT body FROM files WHERE json_extract(body,'$.connectionId')=? AND json_extract(body,'$.conversationId')=?").all(route.connectionId,route.conversationId);
  for(const row of rows){const f=JSON.parse(row.body);if(f.transcription.status!=='ready'||!f.transcription.text?.toLocaleLowerCase().includes(query.toLocaleLowerCase()))continue;
   const previous=matches.get(f.messageId),text=[previous?.text??f.message.text,'[Транскрипция аудио]\n'+f.transcription.text].filter(Boolean).join('\n\n');
   matches.set(f.messageId,{...f.message,sourceText:f.message.text,text,attachments:[...(previous?.attachments??[]),this.metadata(f)]});
  }
  return [...matches.values()].slice(0,limit);
 }
 async close(){this.closed=true;for(const job of this.queue.splice(0)){this.save({...this.get(job.id),transcription:{status:'interrupted',text:null,error:'service_stopped',source:job.source}});this.jobs.delete(job.id);job.resolve();}await Promise.allSettled([...this.jobs.values(),...this.downloads.values()]);this.db.close();}
}

/** Deadline only bounds the caller's wait; a shared read-only ASR job continues for subsequent polls. */
export async function boundedWait(promise,ms){let timer;try{await Promise.race([promise,new Promise(r=>{timer=setTimeout(r,ms);})]);}finally{clearTimeout(timer);}}
export async function probeMedia(filename){
 try{const {stdout}=await execute('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',filename],{timeout:15000,maxBuffer:100000});const p=JSON.parse(stdout),duration=Number(p.format?.duration);if(!Number.isFinite(duration)||duration<0)throw new Error();return {duration,hasAudio:p.streams?.some(s=>s.codec_type==='audio')===true};}catch{throw new HubError('media_probe_failed');}
}
export async function extractAudio(source,destination){
 try{await execute('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',source,'-map','0:a:0','-vn','-ac','1','-ar','16000','-codec:a','libmp3lame','-b:a','48k','-y',destination],{timeout:120000,maxBuffer:100000});chmodSync(destination,0o600);}catch{throw new HubError('audio_extract_failed');}
}


/** Byte signatures, not filenames, identify common messenger media; unknown formats remain generic. */
export async function detectMime(filename){
 const handle=await open(filename,'r');const buffer=Buffer.alloc(8192);let bytesRead;
 try{({bytesRead}=await handle.read(buffer,0,buffer.length,0));}finally{await handle.close();}
 const b=buffer.subarray(0,bytesRead),starts=hex=>b.subarray(0,hex.length/2).equals(Buffer.from(hex,'hex'));
 let mimeType;
 if(b.subarray(0,4).toString()==='OggS')mimeType='audio/ogg';
 else if(starts('ffd8ff'))mimeType='image/jpeg';
 else if(starts('89504e470d0a1a0a'))mimeType='image/png';
 else if(b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP')mimeType='image/webp';
 else if(b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WAVE')mimeType='audio/wav';
 else if(b.subarray(0,4).toString()==='%PDF')mimeType='application/pdf';
 else if(b.subarray(0,3).toString()==='ID3'||b[0]===255&&(b[1]&0xe0)===0xe0)mimeType='audio/mpeg';
 else if(b.subarray(4,8).toString()==='ftyp')mimeType='video/mp4';
 return mimeType?{mimeType,mimeDetected:true}:{mimeDetected:false};
}
