import {z} from 'zod';
import {mkdir,realpath,stat,copyFile,readFile,unlink,chmod} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {route,id,ref,HubError,key} from './contracts.mjs';
import {hash} from './store.mjs';
import {detectMime} from './media.mjs';
import {diagnostic} from './errors.mjs';
export const mediaType=z.enum(['image','document','voice','audio','video']);
export const stageInput=route.extend({localPath:z.string().min(1).max(4000),type:mediaType}).strict();
export const sendMediaInput=route.extend({requestId:id,localPath:z.string().min(1).max(4000).optional(),fileId:z.string().uuid().optional(),type:mediaType,caption:z.string().max(1024).default(''),replyTo:ref.nullable().default(null)}).strict().refine(v=>!!v.localPath!==!!v.fileId,'Supply exactly one of localPath/fileId');
export const mediaDeliveryInput=route.extend({requestId:id}).strict();

/** Scope-specific staging and frozen bytes prevent the file path from becoming an arbitrary-read API. */
export class OutboundMedia {
 constructor(hub){this.hub=hub;this.media=hub.media;this.db=this.media.db;this.db.exec('CREATE TABLE IF NOT EXISTS media_sends(identity TEXT PRIMARY KEY,digest TEXT NOT NULL,body TEXT NOT NULL)');}
 uploadRoot(scope){return path.join(this.media.root,'outbox',scope);}
 async stage(scope,input){
  const v=stageInput.parse(input);this.hub.access(scope,v.connectionId,v.conversationId,true);
  const root=this.uploadRoot(scope);await mkdir(root,{recursive:true,mode:0o700});
  const actual=await realpath(v.localPath);if(!actual.startsWith(await realpath(root)+path.sep))throw new HubError('upload_path_denied',{uploadRoot:root,nextAction:'Copy the intended file into this scope-specific uploadRoot, then call media_stage/send_media.'});
  const size=(await stat(actual)).size;if(size<1||size>25*1024*1024||!(await stat(actual)).isFile())throw new HubError('file_size_limit');
  const temp=path.join(this.media.root,'upload-'+randomUUID());await copyFile(actual,temp);await chmod(temp,0o600);
  try{
   if((await stat(temp)).size>25*1024*1024)throw new HubError('file_size_limit');
   const bytes=await readFile(temp);if(bytes.length<1||bytes.length>25*1024*1024)throw new HubError('file_size_limit');
   const digest=createHash('sha256').update(bytes).digest('hex'),detected=await detectMime(temp);
   if(v.type==='image'&&!detected.mimeType?.startsWith('image/')||v.type==='video'&&!detected.mimeType?.startsWith('video/')||['voice','audio'].includes(v.type)&&!detected.mimeType?.startsWith('audio/'))throw new HubError('media_type_mismatch');
   if(v.type==='voice'&&!(detected.mimeType==='audio/ogg'&&bytes.subarray(0,8192).includes(Buffer.from('OpusHead'))))throw new HubError('voice_requires_ogg_opus');
   const filename=path.basename(actual),metadata={id:'upload:'+digest,kind:v.type,filename,size:bytes.length,mimeType:detected.mimeType??'application/octet-stream',providerVersion:digest};
   const f=this.media.register(v.connectionId,{id:'upload:'+digest,conversationId:v.conversationId,kind:'message',direction:'outbound',senderId:null,at:new Date().toISOString(),text:'',attachments:[metadata]},metadata);
   const destination=path.join(this.media.root,f.id+'-'+filename);await copyFile(temp,destination);await chmod(destination,0o600);
   this.media.save({...this.media.get(f.id),path:destination,filename,size:bytes.length,mimeType:metadata.mimeType,mimeDetected:!!detected.mimeDetected,digest,staged:true});
   return this.media.fileResult(this.media.get(f.id));
  }finally{await unlink(temp).catch(()=>{});}
 }
 get(identity){const r=this.db.prepare('SELECT body FROM media_sends WHERE identity=?').get(identity);return r?JSON.parse(r.body):null;}
 save(identity,body){this.db.prepare('UPDATE media_sends SET body=? WHERE identity=?').run(JSON.stringify(body),identity);}
 public(op){const quoted=op.effectiveInput?.replyTo??(op.replyFallback?null:op.input.replyTo);return {status:op.status,messageId:op.messageId??null,requestId:op.input.requestId,fileId:op.fileId,sha256:op.sha256,confirmation:op.status==='sent'?'provider_sent':op.status==='failed'?'not_created':'unconfirmed',recipientDelivery:'unknown',recipientRead:'unknown',replyTo:quoted,...(op.replyFallback?{replyFallback:op.replyFallback}:{}),replyVerification:op.replyVerification??(quoted?'unavailable':'not_requested'),...(quoted&&['unavailable','mismatch'].includes(op.replyVerification)?{replyNextAction:'Submission is confirmed separately. Inspect the native messenger to check the quoted message; do not resend this media to repair a receipt.'}:{}),...(['unknown','failed'].includes(op.status)?{diagnostic:op.diagnostic??diagnostic(new HubError('send_unconfirmed'),'send','media-'+op.input.requestId)}:{})};}
 async send(scope,input){
  const v=sendMediaInput.parse(input),{instance}=this.hub.access(scope,v.connectionId,v.conversationId,true);
  if(!instance.sendMedia||!instance.capabilities.sendAttachments)throw new HubError('send_attachments_unsupported');
  // Reject unsupported caption semantics before staging or starting a transport attempt.
  if(this.hub.config.connections[v.connectionId].plugin==='whatsapp'&&['voice','audio'].includes(v.type)&&v.caption)throw new HubError('audio_caption_unsupported',{nextAction:'Use an empty caption, or send the audio as a document with a caption.'});
  const file=v.localPath?await this.stage(scope,{connectionId:v.connectionId,conversationId:v.conversationId,localPath:v.localPath,type:v.type}):await this.media.download(scope,v.fileId);
  if(v.type==='image'&&!file.mimeType?.startsWith('image/')||v.type==='video'&&!file.mimeType?.startsWith('video/')||['voice','audio'].includes(v.type)&&!file.mimeType?.startsWith('audio/'))throw new HubError('media_type_mismatch');
  if(v.type==='voice'&&!(file.mimeType==='audio/ogg'&&(await readFile(file.path)).subarray(0,8192).includes(Buffer.from('OpusHead'))))throw new HubError('voice_requires_ogg_opus');
  const registered=this.media.authorize(scope,file.fileId);if(registered.connectionId!==v.connectionId||registered.conversationId!==v.conversationId)throw new HubError('file_route_mismatch');
  const identity=key(scope,v.connectionId,v.requestId),digest=hash({...v,sha256:file.sha256});
  const existing=this.db.prepare('SELECT digest,body FROM media_sends WHERE identity=?').get(identity);
  if(existing){if(existing.digest!==digest)throw new HubError('idempotency_conflict');return this.delivery(scope,v);}
  const op={status:'unknown',input:v,fileId:file.fileId,sha256:file.sha256,evidence:{startedAt:new Date().toISOString()}};
  this.db.prepare('INSERT INTO media_sends VALUES(?,?,?)').run(identity,digest,JSON.stringify(op));
  const checkpoint=e=>{if(Object.hasOwn(e,'effectiveReplyTo'))op.effectiveInput={...(op.effectiveInput??op.input),replyTo:e.effectiveReplyTo};if(e.replyFallback)op.replyFallback=e.replyFallback;op.evidence={...op.evidence,...e};this.save(identity,op);};
  try{const resolved=await this.hub.optionalReply(scope,v);op.effectiveInput=resolved.input;op.replyFallback=resolved.replyFallback;this.save(identity,op);op.submissionStarted=true;this.save(identity,op);Object.assign(op,await instance.sendMedia({...resolved.input,path:file.path,filename:file.filename,mimeType:file.mimeType,size:file.size},{checkpoint}));}
  catch(e){op.diagnostic=diagnostic(e,'send');if(!op.submissionStarted||e instanceof HubError&&e.details?.messageCreated===false)op.status='failed';}
  this.save(identity,op);return this.public(op);
 }
 async delivery(scope,input){
  const v=mediaDeliveryInput.parse({connectionId:input.connectionId,conversationId:input.conversationId,requestId:input.requestId}),{instance}=this.hub.access(scope,v.connectionId,v.conversationId,true);
  const identity=key(scope,v.connectionId,v.requestId),op=this.get(identity);if(!op)return {status:'not_found'};
  if(op.input.conversationId!==v.conversationId)throw new HubError('not_authorized');
  // Pinned legacy quote guards ran before any upload, so correcting their
  // receipt needs no provider write or re-upload.
  if(op.status==='unknown'&&op.diagnostic?.code==='reply_not_in_context'&&['telegram','whatsapp'].includes(this.hub.config.connections[v.connectionId].plugin)){op.status='failed';this.save(identity,op);}
  if((op.status==='unknown'||op.replyVerification==='unavailable')&&instance.reconcileMedia){try{const r=await instance.reconcileMedia(op.effectiveInput??op.input,op.evidence);if(r.status==='sent'){Object.assign(op,r);delete op.diagnostic;this.save(identity,op);}}catch{/* Never resend while investigating uncertain media. */}}
  return this.public(op);
 }
}
