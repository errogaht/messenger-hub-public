import {z} from 'zod';
import {execFile} from 'node:child_process';
import {readFile,stat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {HubError} from './contracts.mjs';
import {fileInput} from './media.mjs';

export const videoConfig=z.object({enabled:z.boolean().default(false),settingsFile:z.string().optional(),pollMs:z.number().int().min(100).max(60000).default(5000)}).strict().default({enabled:false,pollMs:5000});
export const videoPrepareInput=fileInput.extend({waitMs:z.number().int().min(0).max(30000).default(0)}).strict();
export const videoReadInput=fileInput.extend({offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(100)}).strict();
export const videoFramesInput=fileInput.extend({timestamps:z.array(z.number().finite().nonnegative()).min(1).max(12),crop:z.object({x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),width:z.number().int().positive(),height:z.number().int().positive()}).strict().optional()}).strict();
const core=fileURLToPath(new URL('../video-review/core.py',import.meta.url));
/** One headless implementation for CLI and Hub. Subprocess stdout is private
 * factual JSON; raw stderr (possibly provider/path details) is never logged. */
export function runVideoCore(payload,config){return new Promise((resolve,reject)=>{
 const child=execFile('python3',[core,'hub'],{timeout:300000,maxBuffer:16000000,env:{...process.env,...(config.settingsFile?{VIDEO_REVIEW_SETTINGS_FILE:config.settingsFile}:{})}},(err,stdout)=>{
  try{const value=JSON.parse(stdout);if(err||typeof value.error==='string'){reject(new HubError(typeof value.error==='string'?value.error:'video_core_failed'));return;}resolve(value);}catch{reject(new HubError('video_core_failed'));}
 });child.stdin.end(JSON.stringify(payload));
});}

/** Source-scoped queue over the existing media DB. Shared paid receipts/locks
 * remain in the Python core: source UUIDs confer no access to another route's
 * same-content artifacts. Only explicit prepare creates work; status is inert. */
export class VideoReview {
 constructor(hub,config,deps={}){
  this.hub=hub;this.config=config;this.db=hub.media.db;this.core=deps.core??((p)=>runVideoCore(p,config));this.jobs=new Map();this.waiters=new Set();this.closed=false;
  this.db.exec('CREATE TABLE IF NOT EXISTS video_jobs(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  // Durable selected jobs resume paid GETs after restart, never new admission.
  queueMicrotask(()=>{if(config.enabled&&!this.closed)for(const row of this.db.prepare('SELECT body FROM video_jobs').all()){const j=JSON.parse(row.body);if(['queued','downloading','transcribing'].includes(j.status))this.start(j.scope,j.fileId);else{try{this.source(j.scope,j.fileId);this.save(j);this.hub.inbox?.mediaChanged(this.hub.media.get(j.fileId));}catch{/* Revoked sources stay private; no external work is resumed. */}}}});
 }
 source(scope,id){const f=this.hub.media.authorize(scope,id);if(f.metadata.kind!=='video')throw new HubError('video_source_required');return f;}
 get(id){const r=this.db.prepare('SELECT body FROM video_jobs WHERE id=?').get(id);return r?JSON.parse(r.body):null;}
 /** Persist job before publishing cache readiness. Only factual media metadata
  * changes: native captions/source versions and ordinary audio ASR stay intact.
  * The existing inbox journal deduplicates terminal supplements per subscription. */
 save(j){this.db.prepare('INSERT INTO video_jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(j.fileId,JSON.stringify(j));
  const f=this.hub.media.get(j.fileId),summary=Object.fromEntries(['status','durationSeconds','width','height','hasAudio','sha256','segmentCount','timelineAlignment','error'].filter(k=>j[k]!=null).map(k=>[k,j[k]]));
  if(JSON.stringify(f.videoReview)!==JSON.stringify(summary))this.hub.media.save({...f,videoReview:summary});return j;
 }
 public(j,id){const {settings,scope,cache,...v}=j??{status:'queued',progress:{phase:'not_prepared'}};return {fileId:id,...v};}
 /** Only a verified cached original can recover a legacy pre-ASR download
  * failure. Durable core-entry evidence, SHA or a paid terminal state fences
  * retries; core still reconciles its own OS-locked receipt before any POST. */
 recoverableDownload(j,f){return !!f.path&&j?.status==='failed'&&!j.coreStarted&&!j.sha256&&(!j.failureStage||j.failureStage==='downloading')&&['upstream_unavailable','attachment_temporarily_unavailable','download_failed','attachment_download_timeout'].includes(j.error?.code);}
 async status(scope,id){const f=this.source(scope,id),j=this.get(id);if(!f.path)return this.public(j,id);
  const settings=j?.settings??await this.core({action:'settings'});
  const state=await this.core({action:'status',source:await this.hub.media.checkedPath(f.path),settings});
  if(state.status==='ready')return this.public({...j,...state,error:undefined},id);
  const result=state.status==='queued'&&['failed','submission_unknown'].includes(j?.status)?j:{...j,...state};
  return this.public(this.recoverableDownload(j,f)?{...result,error:{...j.error,retryable:true,stage:'download'},canResume:true,nextAction:'Original is now verified in cache. Call messenger_video_prepare with the SAME fileId to resume pre-ASR preparation; no failed or unknown paid receipt is resubmitted.'}:result,id);
 }
 async prepare(scope,input){const v=videoPrepareInput.parse(input);this.source(scope,v.fileId);if(!this.config.enabled)throw new HubError('video_review_disabled');
  let j=this.get(v.fileId);
  if(this.recoverableDownload(j,this.source(scope,v.fileId))){
   await this.hub.media.checkedPath(this.source(scope,v.fileId).path);
   const {error,failureStage,...prior}=j;
   j=this.save({...prior,status:'queued',progress:{phase:'queued'},recovery:{reason:'original_download_recovered',previousError:error.code,at:new Date().toISOString()}});
  }
  if(!j){j=this.save({fileId:v.fileId,scope,status:'queued',progress:{phase:'queued'}});}
  if(!['failed','submission_unknown','ready'].includes(j.status))this.start(scope,v.fileId);
  if(v.waitMs&&this.jobs.has(v.fileId))await Promise.race([this.jobs.get(v.fileId),new Promise(r=>setTimeout(r,v.waitMs).unref())]);
  return this.status(scope,v.fileId);
 }
 start(scope,id){if(this.jobs.has(id)||this.closed)return;const work=this.process(scope,id).finally(()=>this.jobs.delete(id));this.jobs.set(id,work);}
 async process(scope,id){
  try{let j=this.get(id);this.source(scope,id);
   // Persist purpose snapshot before download and every paid core invocation.
   if(!j.settings)j=this.save({...j,settings:await this.core({action:'settings'})});
   j=this.save({...j,status:'downloading',progress:{phase:'downloading'}});
   const file=await this.hub.media.download(scope,id);
   do{
    this.source(scope,id);j=this.save({...j,status:'transcribing',coreStarted:true,sha256:file.sha256,progress:{phase:'transcribing'}});
    const result=await this.core({action:'prepare',source:await this.hub.media.checkedPath(file.path),settings:j.settings});const {error:priorError,...previous}=j;j=this.save({...previous,...result,...(result.lockBusy&&result.status==='queued'?{status:'transcribing'}:{})});
    if(j.status!=='transcribing'||this.closed)break;
    await new Promise(r=>{const done=()=>{clearTimeout(timer);this.waiters.delete(done);r();};const timer=setTimeout(done,this.config.pollMs);this.waiters.add(done);});
   }while(!this.closed);
  }catch(e){const old=this.get(id);if(old)this.save({...old,status:'failed',failureStage:old.progress?.phase??'unknown',progress:{phase:'failed'},error:{code:e instanceof HubError?e.code:'video_prepare_failed',stage:old.progress?.phase??'unknown',retryable:old.progress?.phase==='downloading'&&['upstream_unavailable','attachment_temporarily_unavailable','download_failed','attachment_download_timeout'].includes(e.code)}});}
 }
 /** Derivatives get their own UUID but inherit exact original source ACL/version.
  * Copy only trusted provider bytes or a core path proven inside its private
  * content cache; no caller-controlled file path is accepted. */
 async derivative(scope,source,kind,bytes,metadata){
  this.source(scope,source.id);const digest=createHash('sha256').update(bytes).digest('hex');
  const record=this.hub.media.register(source.connectionId,source.message,{id:`video:${source.id}:${kind}:${digest}`,kind:'image',filename:kind+'.'+(metadata.mimeType==='image/jpeg'?'jpg':'png'),mimeType:metadata.mimeType,size:bytes.length,providerVersion:source.metadata.providerVersion});
  if(!record.path){const target=path.join(this.hub.media.root,record.id+'-'+kind+(metadata.mimeType==='image/jpeg'?'.jpg':'.png'));await (await import('node:fs/promises')).writeFile(target,bytes,{mode:0o600});this.hub.media.save({...record,path:target,mimeType:metadata.mimeType,mimeDetected:true,size:bytes.length,digest,derivativeOf:source.id});}
  return {...metadata,fileId:record.id,mimeType:metadata.mimeType,sha256:digest,sourceFileId:source.id,sourceVersion:source.metadata.providerVersion??null};
 }
 async thumbnail(scope,id){let f=this.source(scope,id);if(f.videoThumbnail)return {status:'ready',thumbnail:f.videoThumbnail,...(f.metadata.video??{})};
  const p=this.hub.instances.get(f.connectionId);if(!p.videoThumbnail)return {status:'unavailable',thumbnail:null,...(f.metadata.video??{})};
  const r=await p.videoThumbnail({conversationId:f.conversationId,messageId:f.messageId,attachmentId:f.attachmentId});
  if(!r?.base64)return {status:r?.status??'unavailable',thumbnail:null,...(r?.video??f.metadata.video??{})};
  const bytes=Buffer.from(r.base64,'base64');if(bytes.length>2*1024*1024)throw new HubError('video_thumbnail_size_limit');
  const thumbnail=await this.derivative(scope,f,'thumbnail',bytes,{mimeType:r.mimeType??'image/jpeg',width:r.width??null,height:r.height??null});
  this.hub.media.save({...this.hub.media.get(id),videoThumbnail:thumbnail,metadata:{...f.metadata,video:{...(r.video??f.metadata.video??{}),thumbnailFileId:thumbnail.fileId}}});return {status:'ready',thumbnail,...(r.video??f.metadata.video??{})};
 }
 async read(scope,input){const v=videoReadInput.parse(input),f=this.source(scope,v.fileId),j=this.get(v.fileId);if(!f.path)throw new HubError('video_not_ready');const settings=j?.settings??await this.core({action:'settings'});return this.core({action:'read',source:await this.hub.media.checkedPath(f.path),settings,offset:v.offset,limit:v.limit});}
 async frames(scope,input){const v=videoFramesInput.parse(input),f=this.source(scope,v.fileId);if(!f.path)throw new HubError('video_not_cached');
  const settings=this.get(v.fileId)?.settings??await this.core({action:'settings'}),r=await this.core({action:'frames',source:await this.hub.media.checkedPath(f.path),settings,timestamps:v.timestamps,...(v.crop?{crop:v.crop}:{})});
  if(r.lockBusy)throw new HubError('video_cache_busy');const result=[];
  const cacheRoot=await realpath(path.join(process.env.HOME,'.cache/codex-video-review'));
  for(const frame of r.frames){const filename=await realpath(frame.path);if(!filename.startsWith(cacheRoot+path.sep))throw new HubError('video_artifact_path_denied');const size=(await stat(filename)).size;if(size>16*1024*1024)throw new HubError('video_frame_size_limit');const {path:local,...metadata}=frame;result.push(await this.derivative(scope,f,'frame',await readFile(filename),{...metadata,mimeType:'image/png'}));}
  return {sha256:r.sha256,durationSeconds:r.durationSeconds,frames:result};
 }
 async close(){this.closed=true;for(const wake of this.waiters)wake();await Promise.allSettled(this.jobs.values());}
}
