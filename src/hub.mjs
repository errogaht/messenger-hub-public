import {resolveReadRoute} from './telegram-address.mjs';
import {VideoReview,videoConfig} from './video-review.mjs';
import {MessageMarkers} from './message-markers.mjs';
import {NativeIngress,nativeConfig} from './native-ingress.mjs';
import {mentionEvidence,checkedMentions} from './mentions.mjs';
import {originEnvelope} from './inbox-origin.mjs';
import {ReadCache,cacheConfig,catalogInput,topicsInput,contextReadInput} from './cache.mjs';
import {Inbox,inboxConfig,inboxGrant} from './inbox.mjs';
import {Groups,groupConfig,groupGrant} from './groups.mjs';
import {ResponsePages} from './response-pages.mjs';
import {diagnostic} from './errors.mjs';
import {OutboundMedia} from './outbound-media.mjs';
import {historyInput,messageInput} from './presentation.mjs';
import {runtimeInfo} from './version.mjs';
import {textLimit} from './contracts.mjs';
import {MediaService,mediaConfig,fileInput} from './media.mjs';
import {ReadTools} from './read-tools.mjs';
import {ContactAgent,assistantConfig} from './contact-agent.mjs';
import {findIdentityProfile} from './profiles.mjs';
import {z} from 'zod';
import {readFile,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {timingSafeEqual} from 'node:crypto';
import {id,ref,route,page,attachment,conversation,capabilities,sendInput,receipt,HubError} from './contracts.mjs';

/** Grants are server-side identities. AGENTS.md is workflow guidance, never tenant authorization. */
const grant=z.object({read:z.boolean().default(true),send:z.boolean().default(false),conversations:z.union([z.literal('*'),z.array(ref)]),profiles:z.boolean().default(false),groups:groupGrant.optional()}).strict();
export const configSchema=z.object({version:z.literal(1),port:z.number().int().min(1024).max(65535).default(8792),store:z.string(),cache:cacheConfig.optional(),native:nativeConfig.optional(),inbox:inboxConfig.optional(),groupProvisioning:groupConfig.optional(),assistant:assistantConfig.optional(),media:mediaConfig.optional(),videoReview:videoConfig,readStore:z.string().optional(),plugins:z.record(id,z.string()),connections:z.record(id,z.object({plugin:id,label:z.string(),settings:z.record(z.string(),z.unknown())}).strict()),scopes:z.record(id,z.object({token:z.string().min(32),inbox:inboxGrant.optional(),assistant:z.boolean().default(false),contactAdmin:z.boolean().default(false),connections:z.record(id,grant)}).strict())}).strict();

export async function loadPlugins(config){
  const loaded={};
  for(const [name,filename] of Object.entries(config.plugins)){
    if(!path.isAbsolute(filename))throw new HubError('plugin_path_must_be_absolute');
    const plugin=(await import(pathToFileURL(filename).href)).default;
    if(plugin.contractVersion!==1||plugin.id!==name||typeof plugin.create!=='function')throw new HubError('plugin_contract_incompatible');
    loaded[name]=plugin;
  }
  return loaded;
}

export class Hub {
  constructor(config,plugins,store,dependencies={}){
    this.config=configSchema.parse(config);this.plugins=plugins;this.store=store;this.instances=new Map();this.sendRecoveries=new Map();
    for(const [name,c] of Object.entries(config.connections)){
      if(!plugins[c.plugin])throw new HubError('plugin_missing');
      const instance=plugins[c.plugin].create(c.settings);
      instance.capabilities=capabilities.parse({...instance.capabilities,downloadAttachments:instance.capabilities.attachments,sendAttachments:instance.capabilities.sendAttachments??!!instance.sendMedia});
      // Reject an incomplete external plugin at installation/startup, before any project can select it.
      for(const method of ['conversations','history',...(instance.capabilities.send?['send']:[]),...(instance.capabilities.attachments?['attachment']:[])]){
        if(typeof instance[method]!=='function')throw new HubError('plugin_contract_incomplete');
      }
      for(const method of ['attachmentInfo','attachmentFile','search','contacts'])if(instance[method]!==undefined&&typeof instance[method]!=='function')throw new HubError('plugin_contract_incomplete');
      this.instances.set(name,instance);
    }
    for(const scope of Object.values(this.config.scopes))for(const connection of Object.keys(scope.connections))if(!this.instances.has(connection))throw new HubError('scope_connection_missing');
    this.media=this.config.media?new MediaService(this,this.config.media,dependencies.media):null;
    this.video=this.media?new VideoReview(this,this.config.videoReview,dependencies.videoReview):null;
    this.outbound=this.media?new OutboundMedia(this):null;
    this.readTools=new ReadTools(this,this.config.readStore??(this.config.store===':memory:'?':memory:':this.config.store+'.reads'),dependencies.readTools);
    this.responsePages=new ResponsePages(this,this.readTools.db);
    this.contactAgent=this.config.assistant?new ContactAgent(this,this.config.assistant,dependencies):null;
    this.groups=new Groups(this,dependencies.groups);this.markers=new MessageMarkers(this);
    this.inbox=new Inbox(this,this.config.inbox,dependencies.inbox);this.cache=new ReadCache(this,this.inbox.db);this.native=new NativeIngress(this);
  }
  authenticate(token){
    if(typeof token!=='string')throw new HubError('unauthorized');
    for(const [name,scope] of Object.entries(this.config.scopes)){
      const a=Buffer.from(token),b=Buffer.from(scope.token);
      if(a.length===b.length&&timingSafeEqual(a,b))return name;
    }
    throw new HubError('unauthorized');
  }
  access(scopeId,connectionId,conversationId,write=false){
    const scope=this.config.scopes[scopeId]?.connections[connectionId];
    if(!scope||!scope.read||write&&!scope.send||conversationId!==undefined&&scope.conversations!=='*'&&!scope.conversations.includes(conversationId))throw new HubError('not_authorized');
    const instance=this.instances.get(connectionId);
    if(!instance)throw new HubError('not_authorized');
    return {instance,scope};
  }
  /** Raw provider history is reused by wait/search without starting expensive media work. */
  async readHistory(scopeId,v){
    const {instance}=this.access(scopeId,v.connectionId,v.conversationId);
    const r=page.parse(await instance.history(v));
    r.items=r.items.map(m=>m.mentionEvidence?{...m,mentionEvidence:checkedMentions(m.text,m.mentionEvidence)}:m);if(r.items.some(x=>x.conversationId!==v.conversationId))throw new HubError('provider_route_mismatch');
    if(v.includeMetadata!==false)this.store.observe(v.connectionId,r.items);this.cache?.page(v.connectionId,v.conversationId,r,v);return r;
  }
  /** A quote is optional presentation, never recipient authority. Resolve only
   * within the already authorized route; missing/deleted targets drop the quote,
   * while wrong-route evidence and authorization errors still fail closed.
   * Callers persist this choice before sending so reconciliation uses the same
   * effective quote without changing the original idempotency payload. */
  async optionalReply(scope,v){
    this.access(scope,v.connectionId,v.conversationId);
    if(!v.replyTo||v.topicId===v.replyTo)return {input:v};
    const omit=reason=>({input:{...v,replyTo:null},replyFallback:{status:'omitted',requestedReplyTo:v.replyTo,effectiveReplyTo:null,reason}});
    if(v.topicId&&this.config.connections[v.connectionId].plugin==='telegram')return omit('topic_quote_unsupported');
    try{
      const lookup={connectionId:v.connectionId,conversationId:v.conversationId,...(v.topicId?{topicId:v.topicId}:{}),messageId:v.replyTo};
      let r;try{r=await this.call(scope,'message_get',{...lookup,readMode:'cached'});}catch(e){if(e.code!=='message_not_cached')throw e;r=await this.call(scope,'message_get',{...lookup,readMode:'refresh'});}
      if(r.message.id!==v.replyTo||r.message.conversationId!==v.conversationId)throw new HubError('provider_route_mismatch');
      return r.message.deletedAt?omit('reply_target_deleted'):{input:v,message:r.message,complete:r.complete};
    }catch(e){if(['message_not_found_in_window','message_not_found','reply_not_in_context'].includes(e.code))return omit('reply_target_unavailable');throw e;}
  }
  /** Reconciliation reads provider evidence only; never resends old writes. */
  async reconcileSend(scopeId,v,legacyStartedAt){
    v=sendInput.parse(v);
    const {instance}=this.access(scopeId,v.connectionId,v.conversationId,true);
    if(!this.store.hasSend(scopeId,v))return {status:'not_sent',messageId:null,tracked:false};
    const identity=this.store.beginSend(scopeId,v);let result=this.store.delivery(identity);
    const evidence=this.store.evidence(identity)??(legacyStartedAt?{startedAt:legacyStartedAt}:null);
    // These legacy adapter guards ran before the provider write. Correct the
    // receipt only, never resend a historical request during reconciliation.
    if(result.status==='unknown'&&evidence?.diagnostic?.code==='reply_not_in_context'&&['telegram','whatsapp'].includes(this.config.connections[v.connectionId].plugin))result=this.store.finish(identity,{status:'failed',messageId:null});
    if(result.status==='unknown'&&instance.reconcile&&evidence){
      try{const observed=receipt.parse(await instance.reconcile({...v,...(Object.hasOwn(evidence,'effectiveReplyTo')?{replyTo:evidence.effectiveReplyTo}:{})},evidence));if(observed.status==='sent')result=this.store.finish(identity,observed);}catch{/* Keep prior uncertainty; a failed read is not proof of nondelivery. */}
    }
    return {...result,...(evidence?.replyFallback?{replyFallback:evidence.replyFallback}:{}),...(['unknown','failed'].includes(result.status)?{diagnostic:evidence?.diagnostic??diagnostic(new HubError('send_unconfirmed'),'send','send-'+identity)}:{}),tracked:true,confirmation:result.status==='sent'?'provider_sent':result.status==='failed'?'not_created':'unconfirmed',recipientDelivery:'unknown',recipientRead:'unknown'};
  }
  /** Resume only a provider that implements durable native idempotency/fencing.
   * This runs on an explicit repeated send, never on delivery/status reads. The
   * stored digest and effective reply freeze intent; no rewrite or quote lookup.
   * Providers without this opt-in keep unknown forever until reconciled.
   */
  async resumeSend(scopeId,v,instance,result){
    const identity=this.store.beginSend(scopeId,v),evidence=this.store.evidence(identity);
    const recoverable=['portal_transport_failed','portal_timeout','portal_response_invalid','portal_unavailable','portal_recovery_storage_unavailable'];
    if(result.status!=='unknown'||result.messageId||typeof instance.resumeSend!=='function'||!recoverable.includes(evidence?.diagnostic?.code))return result;
    if(this.sendRecoveries.has(identity))return this.sendRecoveries.get(identity);
    const job=(async()=>{
      this.store.saveEvidence(identity,{recoveryAttempts:(evidence.recoveryAttempts??0)+1,lastRecoveryAt:new Date().toISOString()});
      try{
        const recovered=receipt.parse(await instance.resumeSend({...v,...(Object.hasOwn(evidence,'effectiveReplyTo')?{replyTo:evidence.effectiveReplyTo}:{})}));
        this.store.finish(identity,recovered);
      }catch(error){
        const detail=diagnostic(error,'send');
        this.store.saveEvidence(identity,{diagnostic:detail});
        // Recovery errors must retain prior uncertainty, including a remote
        // refusal that cannot establish what the ORIGINAL attempt created.
      }
      return this.reconcileSend(scopeId,v);
    })();
    this.sendRecoveries.set(identity,job);
    try{return await job;}finally{this.sendRecoveries.delete(identity);}
  }
  async call(scopeId,method,input={}){
    if(!this.config.scopes[scopeId])throw new HubError('unauthorized');
    if(method.startsWith('subscription_')||method.startsWith('inbox_'))return this.inbox.call(scopeId,method,input);
    if(['group_ensure','group_result'].includes(method))return this.groups.call(scopeId,method,input);
    if(['media_stage','send_media','media_delivery'].includes(method)){if(!this.outbound)throw new HubError('media_not_configured');return this.outbound[method==='media_stage'?'stage':method==='send_media'?'send':'delivery'](scopeId,input);}
    // Read aliases never reach writes, journals, media or route grants unnormalized.
    if(['history','message_get','attachment','message_context','topics','search_messages'].includes(method)&&typeof input?.conversationId==='string')input=await resolveReadRoute(this,scopeId,input);
    if(method==='contacts')return this.readTools.contacts(scopeId,input);
    if(method==='search_messages')return this.readTools.search(scopeId,input);
    if(method==='wait_for_settled_message')return this.readTools.wait(scopeId,input);
    if(method.startsWith('video_')){if(!this.video)throw new HubError('media_disabled');
      if(method==='video_prepare')return this.video.prepare(scopeId,input);
      if(method==='video_read')return this.video.read(scopeId,input);
      if(method==='video_frames')return this.video.frames(scopeId,input);
      const v=fileInput.parse(input);if(method==='video_status')return this.video.status(scopeId,v.fileId);
      if(method==='video_thumbnail')return this.video.thumbnail(scopeId,v.fileId);throw new HubError('method_unknown');
    }
    if(['file_download','files_download','transcribe_media','transcription_status'].includes(method)){
      if(!this.media)throw new HubError('media_not_configured');
      if(method==='files_download')return this.media.batch(scopeId,input);
      if(method==='file_download')return this.media.requestDownload(scopeId,input);
      if(method==='transcription_status')return this.media.fileResult(this.media.authorize(scopeId,fileInput.parse(input).fileId));
      return this.media.transcribe(scopeId,input);
    }
    if(method.startsWith('contact_')||method==='personality_set'){
      if(!this.contactAgent)throw new HubError('assistant_not_configured');
      return this.contactAgent.call(scopeId,method,input);
    }
    // Explicit raw alias keeps the v1 exact-text contract used by WorkZone.
    if(method==='send_raw')method='send';
    if(method==='schema')return {...runtimeInfo(),videoAttachmentSchema:z.toJSONSchema(attachment.shape.video),inboxProvenanceSchema:z.toJSONSchema(originEnvelope),mentionEvidenceSchema:z.toJSONSchema(mentionEvidence),...this.schemaInfo?.get(scopeId)};
    if(method==='connections')return {version:1,inbox:{read:this.inbox.visible(scopeId),workerEnabled:this.inbox.config.enabled,pushConfigured:this.inbox.config.push.enabled,pushAuthorized:!!this.config.scopes[scopeId].inbox?.push,asrProvider:this.media?.asrProvider??null,upstreamCallTranscripts:'mts_mcp'},server:{...runtimeInfo(),schemaHash:this.schemaInfo?.get(scopeId)?.schemaHash},items:Object.entries(this.config.scopes[scopeId].connections).filter(([,g])=>g.read).map(([connectionId,g])=>{
      const c=this.config.connections[connectionId],p=this.instances.get(connectionId);
      return {id:connectionId,plugin:c.plugin,label:c.label,sourceCapabilities:{videoReview:{contractVersion:1,enabled:this.config.videoReview.enabled,thumbnail:!!p.videoThumbnail},cachedRead:true,mentionEvidence:c.plugin==='telegram'?{version:1,nativeEntities:true,coordinateSystem:'utf16',legacyCacheMayBeIncomplete:true}:null,topics:!!p.topics,topicHistory:c.plugin==='telegram'?'existing_bridge_scoped_refresh_and_cache':'unsupported',nativeConfigured:this.native.config.enabled&&this.native.config.bindings.some(b=>b.connectionId===connectionId),ingestion:this.native.describe(scopeId,connectionId),email:c.plugin==='email'?'read_only_rfc822_export':c.plugin==='files'?'imported_snapshot':'not_email'},...(g.send&&this.outbound?{uploadRoot:this.outbound.uploadRoot(scopeId)}:{}),capabilities:{...p.capabilities,messageMarkers:!!p.markMessage&&g.send,markerStatuses:p.markMessage?['viewed','in_progress','completed','question']:[],groupProvisioning:this.groups.configured(connectionId)&&this.groups.visible(scopeId,connectionId,true),send:p.capabilities.send&&g.send,sendAttachments:p.capabilities.sendAttachments&&g.send&&!!this.outbound}};
    })};
    if(method==='events'){
      const v=z.object({after:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(500).default(100)}).strict().parse(input);
      const items=this.store.events(v.after,v.limit,this.config.scopes[scopeId].connections);return {items,next:items.at(-1)?.sequence??v.after};
    }
    if(method==='conversations'||method==='topics')return this.cache.catalog(scopeId,input,method==='topics');
    if(method==='message_context')return this.cache.context(scopeId,contextReadInput.parse(input));
    if(method==='history'){
      return this.responsePages.history(scopeId,historyInput.parse(input));
    }
    if(method==='message_get'){
      const v=messageInput.parse(input);if(this.cache.mode(v)==='cached')return this.cache.get(scopeId,v);const {instance}=this.access(scopeId,v.connectionId,v.conversationId);
      let message;if(instance.message)message=await instance.message(v);
      else{let cursor=null;for(let n=0;n<20;n++){const r=await this.readHistory(scopeId,{...v,cursor,limit:100});message=r.items.find(m=>m.id===v.messageId);if(message||!r.next)break;cursor=r.next;}}
      if(!message)throw new HubError('message_not_found_in_window',{nextAction:'Page history beyond the bounded 2000-message lookup.'});
      if(v.topicId!==undefined&&message.topicId!==v.topicId)throw new HubError('topic_metadata_unavailable');
      if(message.conversationId!==v.conversationId)throw new HubError('provider_route_mismatch');
      this.cache.observe(v.connectionId,message);let r={items:[message],next:null,complete:true};if(this.media)r=await this.media.enrich(scopeId,v.connectionId,r);return {message:r.items[0],complete:message.contentComplete!==false};
    }
    if(method==='send'){
      const v=sendInput.parse(input),{instance}=this.access(scopeId,v.connectionId,v.conversationId,true);
      if(v.topicId&&!instance.topics)throw new HubError('topics_unsupported');
      if(!instance.capabilities.send||!instance.send)throw new HubError('send_unsupported');
      if(v.format&&v.format!=='plain'&&!instance.capabilities.formats?.includes(v.format))throw new HubError('format_unsupported');
      if(v.text.length>textLimit(instance.capabilities,v.format))throw new HubError('text_too_long');
      const exists=this.store.hasSend(scopeId,v),identity=this.store.beginSend(scopeId,v);
      if(exists)return this.resumeSend(scopeId,v,instance,await this.reconcileSend(scopeId,v));
      let submissionStarted=false;
      try{const resolved=await this.optionalReply(scopeId,v);this.store.saveEvidence(identity,{effectiveReplyTo:resolved.input.replyTo,...(resolved.replyFallback?{replyFallback:resolved.replyFallback}:{})});
      submissionStarted=true;
      const r=this.store.finish(identity,receipt.parse(await instance.send(resolved.input,{checkpoint:e=>this.store.saveEvidence(identity,e)})));return {...r,...(this.store.evidence(identity)?.replyFallback?{replyFallback:this.store.evidence(identity).replyFallback}:{}),...(r.status==='unknown'?{diagnostic:diagnostic(new HubError('send_unconfirmed'),'send','send-'+identity)}:{}),confirmation:r.status==='sent'?'provider_sent':'unconfirmed',recipientDelivery:'unknown',recipientRead:'unknown'};}
      catch(e){const detail=diagnostic(e,'send');console.warn(JSON.stringify({event:'send_failed',code:detail.code,stage:detail.stage,correlationId:detail.correlationId}));this.store.saveEvidence(identity,{diagnostic:detail});return {...this.store.finish(identity,{status:!submissionStarted||e instanceof HubError&&e.details?.messageCreated===false?'failed':'unknown',messageId:e?.details?.candidateMessageId??null}),diagnostic:detail,...(this.store.evidence(identity)?.replyFallback?{replyFallback:this.store.evidence(identity).replyFallback}:{}),confirmation:!submissionStarted||e instanceof HubError&&e.details?.messageCreated===false?'not_created':'unconfirmed',recipientDelivery:'unknown',recipientRead:'unknown'};}
    }
    if(method==='delivery'){
      return this.reconcileSend(scopeId,sendInput.parse(input));
    }
    if(method==='attachment'){
      const v=route.extend({messageId:ref,attachmentId:ref}).strict().parse(input);
      const {instance}=this.access(scopeId,v.connectionId,v.conversationId);
      if(!instance.capabilities.attachments||!instance.attachment)throw new HubError('attachment_unsupported');
      // A Hub UUID is not a provider attachment ID. Resolve only a registered,
      // scope-authorized exact source; unknown identifiers retain adapter checks.
      const registered=this.media?.resolveAttachment(scopeId,v);
      if(registered){
        const file=await this.media.download(scopeId,registered.id);
        if(file.size>26000000)throw new HubError('file_size_limit');
        return {base64:(await readFile(file.path)).toString('base64'),mimeType:file.mimeType,filename:file.filename};
      }
      return z.object({base64:z.string().max(35000000),mimeType:z.string().max(200),filename:z.string().max(2000).nullable()}).strict().parse(await instance.attachment(v));
    }
    if(method==='profile'){
      const v=route.parse(input),{scope}=this.access(scopeId,v.connectionId,v.conversationId);
      if(!scope.profiles)throw new HubError('not_authorized');
      if(this.contactAgent){
        const agent=this.contactAgent,c=agent.book.byEndpoint(v);
        if(c){
          const override=agent.readableProfile(scopeId,'conversation:'+JSON.stringify([v.connectionId,v.conversationId]));
          const person=agent.readableProfile(scopeId,'person:'+c.id);
          if(person||override)return {found:true,markdown:[person?.markdown,override?.markdown].filter(Boolean).join('\n\n')};
        }
      }
      const settings=this.config.connections[v.connectionId].settings;
      const files=settings.profiles??{};
      let filename=files[v.conversationId];
      // Existing Telegram filenames are keyed by exact numeric identity, never fuzzy names.
      if(!filename&&settings.profileRoot&&/^-?\d+$/.test(v.conversationId)){
        const matches=(await readdir(settings.profileRoot)).filter(n=>n.startsWith(v.conversationId+'-')&&n.endsWith('.md'));
        if(matches.length===1)filename=path.join(settings.profileRoot,matches[0]);
      }
      if(!filename&&settings.profileRoot&&settings.profileIdentityField)filename=await findIdentityProfile(settings.profileRoot,settings.profileIdentityField,v.conversationId);
      if(!filename)return {found:false,markdown:null};
      const actual=await realpath(filename),root=await realpath(settings.profileRoot??path.dirname(filename));
      if(!actual.startsWith(root+path.sep))throw new HubError('profile_path_invalid');
      const markdown=await readFile(actual,'utf8');
      if(Buffer.byteLength(markdown)>100000)throw new HubError('profile_too_large');
      return {found:true,markdown};
    }
    if(method==='message_mark')return this.markers.mark(scopeId,input);
    if(method==='message_mark_result')return this.markers.result(scopeId,input);
    if(method==='identity'){const v=z.object({connectionId:id}).strict().parse(input);const {instance}=this.access(scopeId,v.connectionId);if(!instance.identity)throw new HubError('identity_unsupported');return {connectionId:v.connectionId,...await instance.identity()};}
    if(method==='health'){
      const v=z.object({connectionId:id.optional()}).strict().parse(input);
      const server={...runtimeInfo(),schemaHash:this.schemaInfo?.get(scopeId)?.schemaHash};
      if(!v.connectionId)return {available:true,server};
      const {instance,scope}=this.access(scopeId,v.connectionId);
      return {...(instance.health?await instance.health():{available:true,checked:'configuration'}),server,capabilities:{...instance.capabilities,groupProvisioning:this.groups.configured(v.connectionId)&&this.groups.visible(scopeId,v.connectionId,true),send:instance.capabilities.send&&scope.send,sendAttachments:instance.capabilities.sendAttachments&&scope.send&&!!this.outbound}};
    }
    throw new HubError('method_unknown');
  }
  async close(){await this.inbox.stop();await this.groups.close();await this.readTools.close();await this.video?.close();await this.media?.close();for(const p of this.instances.values())await p.close?.();this.contactAgent?.close();await this.inbox.close();this.store.close();}
}
