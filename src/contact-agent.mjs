import {protectedLiterals} from './protected-literals.mjs';
import {diagnostic} from './errors.mjs';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {id,ref,HubError,key,textFormat,textLimit} from './contracts.mjs';
import {ContactBook,contactSchema,normalize,endpointKey} from './contact-book.mjs';
import {StyleModel} from './llm.mjs';
import {hash} from './store.mjs';

export const assistantConfig=z.object({root:z.string(),enabled:z.boolean().default(false),baseUrl:z.string().url().refine(v=>v.startsWith('https://')),keyFile:z.string(),model:z.string().default('gpt-6-luna'),effort:z.enum(['low','medium','high']).default('medium'),timeoutMs:z.number().int().min(1000).max(120000).default(45000)}).strict();
export const composeInput=z.object({recipient:z.string().min(1).max(500),connectionId:id.optional(),conversationId:ref.optional(),requestId:id,retryPreparation:z.boolean().optional(),format:z.enum(['auto','plain','rich_markdown','rich_html']).optional(),text:z.string().min(1).max(30000),replyTo:ref.nullable().default(null)}).strict();
export const mergeInput=z.object({targetId:id,sourceId:id,targetRevision:z.number().int().positive(),sourceRevision:z.number().int().positive()}).strict();
const searchInput=z.object({query:z.string().max(200).default(''),connectionId:id.optional(),conversationId:ref.optional(),discover:z.boolean().default(false)}).strict();
const profileInput=z.object({contactId:id,connectionId:id.optional(),conversationId:ref.optional(),markdown:z.string().min(1).max(100000)}).strict();
// Prompts and code form one deployment; live file edits must not change an old process contract.
const prompts=Object.fromEntries(['profile','rewrite'].map(name=>[name,readFileSync(new URL(`../prompts/${name}.md`,import.meta.url),'utf8')]));
const prompt=name=>prompts[name];
// The wire contract constrains syntax, never grants semantic/send authority.
// All returned fields still pass Zod, transport format and factual-literal guards.
const rewriteSchema={type:'object',properties:{text:{type:'string'},format:{type:'string',enum:['plain','rich_markdown','rich_html']},warnings:{type:'array',items:{type:'string'}}},required:['text','format','warnings'],additionalProperties:false};
const rewriteOptions={jsonSchema:rewriteSchema};
const personKey=c=>'person:'+c.id;
const chatKey=e=>'conversation:'+endpointKey(e);

/** The service orchestrates bounded read -> profile -> rewrite. The LLM has no tools or send authority. */
export class ContactAgent {
 constructor(hub,config,dependencies={}){this.hub=hub;this.config=config;this.book=dependencies.book??new ContactBook(config.root);this.model=dependencies.model??new StyleModel(config);this.profileJobs=new Map();}
 allowed(scope,e,write=false,profiles=true){try{const g=this.hub.access(scope,e.connectionId,e.conversationId,write);return !profiles||g.scope.profiles;}catch{return false;}}
 require(scope,e,write=false){if(!this.allowed(scope,e,write))throw new HubError('not_authorized');}
 visible(scope,c){const endpoints=c.endpoints.filter(e=>this.allowed(scope,e));return endpoints.length?{...c,endpoints}:null;}
 admin(scope){if(!this.hub.config.scopes[scope]?.contactAdmin)throw new HubError('not_authorized');}
 readableProfile(scope,identity){const p=this.book.profile(identity);if(p?.sources.some(e=>!this.allowed(scope,e)))throw new HubError('profile_sources_not_authorized');return p;}
 async search(scope,input){
  const v=searchInput.parse(input);
  if(v.connectionId)this.hub.access(scope,v.connectionId);
  if(v.conversationId&&!v.connectionId)throw new HubError('connection_required');
  if(v.conversationId){this.require(scope,v);const c=this.book.byEndpoint(v);return {items:c?[{...this.visible(scope,c),match:'exact'}]:[],discovered:[],errors:[],coverage:{sources:['address_book_endpoint'],complete:true}};}
  const items=this.book.search(v.query,c=>{const visible=this.visible(scope,c);return visible&&(!v.connectionId||visible.endpoints.some(e=>e.connectionId===v.connectionId))?visible:null;});
  const discovered=[],errors=[];
  if(v.discover&&v.query){
   const connections=(await this.hub.call(scope,'connections')).items.filter(c=>!v.connectionId||c.id===v.connectionId).slice(0,8);
   for(const c of connections){
    if(!this.hub.config.scopes[scope].connections[c.id].profiles)continue;
    try{
     const result=await this.hub.call(scope,'contacts',{connectionId:c.id,query:v.query,limit:100});
     for(const row of result.items){const e={connectionId:c.id,conversationId:row.id,kind:row.kind,label:row.title};if(!this.book.byEndpoint(e))discovered.push(e);}
     if(result.next)errors.push({connectionId:c.id,error:'discovery_incomplete'});
    }catch{errors.push({connectionId:c.id,error:'discovery_unavailable'});}
   }
  }
  return {items,discovered,errors,coverage:{sources:['address_book',...(v.discover?['provider_contacts']:[])],complete:errors.length===0}};
 }
 async resolve(scope,v){
  if(v.connectionId)this.hub.access(scope,v.connectionId);
  // An exact caller-confirmed endpoint precedes fuzzy display names. Self aliases
  // use the authorized Telegram account identity, never a chat-title substring.
  let connectionId=v.connectionId,conversationId=v.conversationId;
  if(['self','me','избранное','saved messages'].includes(normalize(v.recipient))){
   const choices=Object.entries(this.hub.config.connections).filter(([id,c])=>c.plugin==='telegram'&&c.settings.selfId&&(!connectionId||id===connectionId)&&this.allowed(scope,{connectionId:id,conversationId:String(c.settings.selfId)}));
   if(choices.length!==1)return {status:'needs_route',candidates:choices.map(([id,c])=>({connectionId:id,conversationId:String(c.settings.selfId),label:'Избранное'}))};
   connectionId=choices[0][0];const selfId=String(choices[0][1].settings.selfId);
   if(conversationId&&conversationId!==selfId)throw new HubError('recipient_endpoint_conflict');
   conversationId=selfId;
  }
  if(connectionId&&!conversationId){
   const plugin=this.hub.config.connections[connectionId]?.plugin;
   if(plugin==='telegram'&&/^-?\d+$/.test(v.recipient))conversationId=v.recipient;
   if(plugin==='whatsapp'&&/^\+?[\d ()-]{7,}$/.test(v.recipient))conversationId=v.recipient.replace(/\D/g,'')+'@s.whatsapp.net';
  }
  if(conversationId){
   if(!connectionId)throw new HubError('connection_required');
   const route={connectionId,conversationId};this.require(scope,route);
   let c=this.book.byEndpoint(route);
   const named=this.book.get(v.recipient);
   if(named&&c&&named.id!==c.id)throw new HubError('recipient_endpoint_conflict');
   if(!c){
    const config=this.hub.config.connections[connectionId];
    let endpoint;
    if(config.plugin==='telegram'&&conversationId===String(config.settings.selfId))endpoint={...route,kind:'direct',label:'Избранное'};
    else{
     const found=await this.hub.call(scope,'contacts',{connectionId,query:conversationId.split('@')[0],limit:100});
     const exact=found.items.find(x=>x.id===conversationId);
     if(exact)endpoint={...route,kind:exact.kind,label:exact.title};
    }
    if(!endpoint)return {status:'needs_recipient',endpoint:route,reason:'endpoint_not_verified',nextAction:'Confirm the endpoint with provider contacts before saving it.'};
    if(named)throw new HubError('recipient_endpoint_conflict');
    c=this.book.put({id:'contact-'+randomUUID(),name:endpoint.label||v.recipient,aliases:[],endpoints:[endpoint]});
   }
   return {contact:this.visible(scope,c),endpoint:c.endpoints.find(e=>e.connectionId===connectionId&&e.conversationId===conversationId)};
  }
  const result=await this.search(scope,{query:v.recipient,connectionId:v.connectionId,discover:false});
  let exact=result.items.filter(c=>c.match==='exact');
  // An explicit stored contact ID is stable even if the person's display name changes.
  const byId=this.book.get(v.recipient);if(byId){const visible=this.visible(scope,byId);exact=visible?[visible]:[];}
  if(!exact.length&&!result.items.length){
   const discovery=await this.search(scope,{query:v.recipient,connectionId:v.connectionId,discover:true});
   const routes=discovery.discovered.filter(e=>(normalize(e.label)===normalize(v.recipient)||v.conversationId===e.conversationId)&&(!v.conversationId||v.conversationId===e.conversationId));
   if(routes.length===1&&!discovery.errors.length){
    this.require(scope,routes[0]);
    const c=this.book.put({id:'contact-'+randomUUID(),name:routes[0].label||v.recipient,aliases:[],endpoints:routes});exact=[c];
   }else return {status:'needs_recipient',...discovery};
  }
  if(exact.length!==1)return {status:'needs_recipient',...result};
  const contact=exact[0],endpoints=contact.endpoints.filter(e=>(!v.connectionId||e.connectionId===v.connectionId)&&(!v.conversationId||e.conversationId===v.conversationId));
  if(endpoints.length!==1)return {status:'needs_route',contact};
  this.require(scope,endpoints[0]);return {contact,endpoint:endpoints[0]};
 }
 async history(scope,e){
  const result=await this.hub.call(scope,'history',{connectionId:e.connectionId,conversationId:e.conversationId,limit:100});
  // Evidence size is bounded without silently treating truncated text as complete evidence.
  let budget=60000;const items=[];let truncated=false;
  for(const m of result.items){const text=m.text??'';if(text.length>budget){truncated=true;continue;}budget-=text.length;items.push({id:m.id,direction:m.direction,at:m.at,text,replyTo:m.replyTo,attachments:m.attachments.map(a=>({kind:a.kind,transcribed:a.transcription?.status==='ready'})),kind:m.kind});}
  return {route:e,items,complete:result.complete,truncated,mediaNotInspected:items.some(m=>m.attachments.some(a=>!a.transcribed))};
 }
 /** Optional quote resolution is shared with raw/media sends. The model gets
  * only an exact source excerpt; an unavailable quote cannot block its text. */
 async replyContext(scope,e,history,messageId){
  if(!messageId)return {replyTo:null};
  const resolved=await this.hub.optionalReply(scope,{...e,replyTo:messageId});
  if(resolved.replyFallback)return {replyTo:null,replyFallback:resolved.replyFallback};
  const m=resolved.message;
  if(m){const text=m.text??'';
   history.replyTarget={id:m.id,direction:m.direction,at:m.at,text:text.slice(0,30000),textTruncated:text.length>30000,contentComplete:resolved.complete,replyTo:m.replyTo,attachments:m.attachments.map(a=>({kind:a.kind,transcribed:a.transcription?.status==='ready'})),kind:m.kind};
   if(history.replyTarget.attachments.some(a=>!a.transcribed))history.mediaNotInspected=true;
  }
  return {replyTo:messageId};
 }
 async ensureProfile(scope,c,e,targetHistory){
  const identity=['group','channel','calls'].includes(e.kind)?chatKey(e):personKey(c);
  const existing=this.readableProfile(scope,identity);if(existing)return existing;
  // One generation per profile in this process; a second scope still rechecks provenance afterwards.
  if(this.profileJobs.has(identity)){await this.profileJobs.get(identity);return this.readableProfile(scope,identity);}
  const work=(async()=>{
   const histories=[targetHistory];
   if(identity===personKey(c))for(const other of c.endpoints.filter(x=>['direct','email'].includes(x.kind)&&endpointKey(x)!==endpointKey(e)&&this.allowed(scope,x)).slice(0,3))histories.push(await this.history(scope,other));
   let markdown;
   // Only generation is optional. Scope checks, other-history reads and profile
   // persistence stay outside this catch so they cannot become send authority.
   try{markdown=await this.model.generate(await prompt('profile'),{name:c.name,kind:e.kind,histories});}
   catch(error){throw new HubError('profile_style_generation_failed',{styleCause:diagnostic(error,'profile_generation')});}
   this.book.setProfile(identity,markdown,histories.map(h=>({connectionId:h.route.connectionId,conversationId:h.route.conversationId})));
  })();
  this.profileJobs.set(identity,work);
  try{await work;}finally{this.profileJobs.delete(identity);}
  return this.readableProfile(scope,identity);
 }
 /** Deterministic guard protects the easiest expensive mistakes; semantic fidelity remains an LLM limitation. */
 validateText(source,output,format='plain'){
  // Formatting may wrap URLs and introduce h2 tags; compare protected literals,
  // not markup punctuation. Keep multiplicity: deleting a repeated amount still fails.
  if(format==='plain'){
   const literals=s=>[...s.matchAll(/https?:\/\/[^\s<>]+|\b\d+(?:[.,:/-]\d+)*\b/g)].map(m=>m[0]).sort();
   if(JSON.stringify(literals(source))!==JSON.stringify(literals(output)))throw new HubError('rewrite_changed_numbers_or_links');
   return;
  }
  if(JSON.stringify(protectedLiterals(source))!==JSON.stringify(protectedLiterals(output)))throw new HubError('rewrite_changed_numbers_or_links');
 }

 checkOperation(scope,op,write=false){
  if(op.endpoint)this.require(scope,op.endpoint,write);
  for(const e of op.sources??[])this.require(scope,e);
 }
 async compose(scope,input,send){
  const {retryPreparation,...v}=composeInput.parse(input);
  if(!this.config.enabled)throw new HubError('assistant_disabled');
  if(v.conversationId&&!v.connectionId)throw new HubError('connection_required');
  const identity=key(scope,v.requestId),digest=hash(v),prior=this.book.operation(identity);
  const retry=retryPreparation===true&&prior?.status==='failed'&&prior.diagnostic?.stage!=='send';
  if(prior){
   this.checkOperation(scope,prior,send);
   this.book.reserve(identity,digest,{});
   if(!retry)return send?this.dispatch(scope,identity,prior):this.publicOperation(prior);
   this.book.saveOperation(identity,{...prior,status:'preparing'});
  }
  // A discovery refusal may include the requested route without a verified contact.
  const resolved=await this.resolve(scope,v);if(!resolved.contact||!resolved.endpoint)return resolved;
  const {contact,endpoint}=resolved;this.require(scope,endpoint,send);
  if(!contact.allowSend)throw new HubError('contact_outbound_blocked');
  if(send&&!this.hub.instances.get(endpoint.connectionId).capabilities.send)throw new HubError('send_unsupported');
  const reservation=this.book.reserve(identity,digest,{status:'preparing',contactId:contact.id,endpoint,requestId:v.requestId,sources:[]});
  if(!reservation.fresh&&!retry)return this.publicOperation(reservation.body);
  const {error:previousError,diagnostic:previousDiagnostic,canRetryPreparation:previousRetry,...baseReservation}=reservation.body;
  const correlationId=randomUUID();let stage='format_validation',rewriteAttempts=0;
  try{
   // Reject impossible formatting before any provider history/profile/model work.
   const caps=this.hub.instances.get(endpoint.connectionId).capabilities;
   const requestedFormat=v.format??'auto';
   if(requestedFormat!=='auto'&&!(caps.formats??['plain']).includes(requestedFormat))throw new HubError('format_unsupported',{allowedFormats:caps.formats??['plain']});
   stage='history';
   const history=await this.history(scope,endpoint);
   stage='reply_context';
   const reply=await this.replyContext(scope,endpoint,history,v.replyTo);
   stage='profile';
   let profile,profileStyleFailure;
   try{profile=await this.ensureProfile(scope,contact,endpoint,history);}
   catch(error){if(error.code!=='profile_style_generation_failed')throw error;profileStyleFailure=error.details.styleCause;}
   const override=this.readableProfile(scope,chatKey(endpoint));
   const sources=[...(profile?.sources??[]),...(override?.sources??[]),{connectionId:endpoint.connectionId,conversationId:endpoint.conversationId}];
   const defaultFormat=caps.formats?.includes('rich_markdown')?'rich_markdown':'plain';
   const formatting={requested:requestedFormat,default:defaultFormat,allowed:requestedFormat==='auto'?(caps.formats??['plain']):[requestedFormat]};
   const rewriteData={source:v.text,formatting,personality:this.book.personality(),profile:profile?.markdown??'',conversationOverride:override?.markdown??'',recentHistory:history,recipient:contact.name,channel:this.hub.config.connections[endpoint.connectionId].plugin,protectedLiterals:protectedLiterals(v.text)};
   const instructions=await prompt('rewrite');
   const parseRewrite=raw=>{
    stage='rewrite_parse';
    let json;try{json=JSON.parse(raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw new HubError('rewrite_invalid_json');}
    const output=z.object({text:z.string().min(1).max(30000),format:textFormat.optional(),warnings:z.array(z.string().max(1000)).max(20)}).strict().parse(json);
    const format=output.format??(requestedFormat==='auto'?defaultFormat:requestedFormat);
    if(!formatting.allowed.includes(format))throw new HubError('rewrite_format_invalid');
    return {...output,format};
   };
   const validateRewrite=output=>{stage='rewrite_validation';this.validateText(v.text,output.text,output.format);if(output.text.length>textLimit(caps,output.format))throw new HubError('text_too_long');};
   stage='rewrite';rewriteAttempts=1;
   let output,stylePreparation;
   try{
    if(profileStyleFailure){stage='profile_generation';rewriteAttempts=0;throw new HubError(profileStyleFailure.code);}
    try{output=parseRewrite(await this.model.generate(instructions,rewriteData,rewriteOptions));}catch(e){
     if(e.code!=='rewrite_invalid_json')throw e;
     // Retry generation once from trusted source, not by extracting a fragment
     // from malformed model output. No transport is invoked during preparation.
     rewriteAttempts=2;stage='rewrite_repair';
     output=parseRewrite(await this.model.generate(instructions,{...rewriteData,jsonRepair:true},rewriteOptions));
    }
    try{validateRewrite(output);}catch(e){
     if(e.code!=='rewrite_changed_numbers_or_links'||rewriteAttempts>=2)throw e;
     // Plain reports need the same bounded fact-preserving repair as rich reports;
     // a first rejected rewrite is not itself a delivery failure. This repair
     // never relaxes the guard, retries a transport, or makes unsafe text sendable.
     rewriteAttempts=2;stage='rewrite_repair';
     const requiredFormat=output.format;
     output=parseRewrite(await this.model.generate(instructions,{...rewriteData,correction:{reason:'protected_literals_mismatch',previousCandidate:output.text,requiredFormat}},rewriteOptions));
     if(output.format!==requiredFormat)throw new HubError('rewrite_format_invalid');
     validateRewrite(output);
    }
   }catch(error){
    // Styling is optional, authority and transport are not. This boundary wraps
    // only model output/generation: discarded candidates never reach dispatch.
    // Persist the unchanged source through the normal prepared/send ledger so
    // preview, concurrency and ambiguous-send reconciliation stay identical.
    const cause=diagnostic(error,stage,correlationId);
    // Long auto reports may use the existing native Markdown transport without
    // rewriting any source bytes; never force an otherwise supported report
    // into the shorter plain-message limit merely because styling failed.
    const sourceFormat=v.text.length>textLimit(caps,'plain')&&caps.formats?.includes('rich_markdown')?'rich_markdown':'plain';
    output={text:v.text,format:requestedFormat==='auto'?sourceFormat:requestedFormat,warnings:[]};
    stylePreparation={status:'original_fallback',reason:cause.code,stage:cause.stage,correlationId};
   }
   // Original fallback still obeys the caller's explicit format and provider
   // limits. Do not turn an oversized source or unsupported input into a send.
   if(stylePreparation)stage='source_validation';
   if(output.text.length>textLimit(caps,output.format))throw new HubError('text_too_long');
   const format=output.format;
   const op=this.book.saveOperation(identity,{...baseReservation,status:output.warnings.length?'needs_review':'prepared',text:output.text,format,warnings:output.warnings,rewriteAttempts,...(stylePreparation?{stylePreparation}:{}),...reply,sources,preparedAt:new Date().toISOString(),mediaNotInspected:history.mediaNotInspected});
   return send?this.dispatch(scope,identity,op):this.publicOperation(op);
  }catch(e){
   const detail=diagnostic(e,stage,correlationId);console.warn(JSON.stringify({event:'preparation_failed',code:detail.code,stage:detail.stage,correlationId}));
   detail.nextAction='No send was attempted. For unchanged parameters, resolve the indicated cause then use the same requestId with retryPreparation=true. Changed parameters require a new requestId.';
   return this.publicOperation(this.book.saveOperation(identity,{...baseReservation,status:'failed',error:detail.code,diagnostic:detail,rewriteAttempts,canRetryPreparation:true}));
  }
 }
 /** Old failed previews receive current guidance without rerunning preparation.
  * A changed payload never reuses the old idempotency key, even before sending. */
 publicOperation(op){const {sources,...safe}=op;
  if(op.status==='failed'&&op.error==='format_unsupported'){
   const allowedFormats=this.hub.instances.get(op.endpoint?.connectionId)?.capabilities.formats??['plain'];
   safe.diagnostic={...(op.diagnostic??diagnostic(new HubError('format_unsupported'))),stage:'format_validation',retryable:false,allowedFormats,requestIdPolicy:'new_request_id_for_changed_payload',nextAction:'No send was attempted. Choose an allowed format (or auto) and submit the changed payload with a NEW requestId. Do not retry the unsupported payload.'};
   safe.canRetryPreparation=false;
   return safe;
  }
  if(op.status==='failed'&&op.diagnostic?.stage==='send'){
   // Transport refusal is distinct from preparation. It cannot restart rewrite
   // or resend under this key; only a changed, authorized request may be new.
   safe.canRetryPreparation=false;safe.sendAttempted=true;safe.preparationStatus='prepared';return safe;
  }
  if(op.status==='failed'&&op.error==='rewrite_invalid_json'){
   safe.sendAttempted=false;safe.preparationStatus='failed';
   safe.diagnostic={...diagnostic(new HubError(op.error),'rewrite_parse',op.diagnostic?.correlationId),...(op.diagnostic??{}),stage:'rewrite_parse',description:'The style model returned invalid JSON during preparation. No message was sent.'};
  }
  // Publish actionable recovery guidance only for the provider-fenced path.
  // This is computed from the current adapter, never permission to change ID.
  if(op.status==='unknown'&&!op.messageId&&typeof this.hub.instances.get(op.endpoint?.connectionId)?.resumeSend==='function'&&['portal_transport_failed','portal_timeout','portal_response_invalid','portal_unavailable','portal_recovery_storage_unavailable'].includes(op.diagnostic?.code)){
   safe.canRetrySend=true;
   safe.nextAction='Repeat contact_send with the EXACT original source payload and requestId. Bitrix resumes the preserved prepared message under its native UUID/fence. Do not use retryPreparation, rewrite the source, delete journals or create a new requestId.';
  }
  if(op.status==='sent'){delete safe.diagnostic;delete safe.error;delete safe.canRetryPreparation;}return {...safe,...(['sent','unknown','sending'].includes(op.status)?{confirmation:op.status==='sent'?'provider_sent':'unconfirmed',recipientDelivery:'unknown',recipientRead:'unknown'}:{}),...(op.status==='failed'&&!op.diagnostic?{diagnostic:diagnostic(new HubError(op.error??'preparation_failed'),'legacy_preparation','legacy-'+op.requestId),canRetryPreparation:true}:{})};}
 async dispatch(scope,identity,op){
  this.checkOperation(scope,op,true);
  const current=this.book.byEndpoint(op.endpoint);if(!current?.allowSend)throw new HubError('contact_outbound_blocked');
  if(current.id!==op.contactId)throw new HubError('recipient_changed');
  // A repeated smart send may resume a provider-fenced transport operation,
  // preserving the prepared text/key and skipping model/preview regeneration.
  // Other providers still return the existing uncertainty without another I/O.
  const resume=op.status==='unknown'&&typeof this.hub.instances.get(op.endpoint.connectionId)?.resumeSend==='function';
  if(op.status!=='prepared'&&!resume)return this.publicOperation(op);
  if(!resume&&Date.now()-Date.parse(op.preparedAt)>15*60*1000)throw new HubError('preview_expired');
  // This synchronous state transition happens before transport I/O. A concurrent retry observes sending.
  this.book.saveOperation(identity,{...op,status:'sending'});
  try{
   const receipt=await this.hub.call(scope,'send',{connectionId:op.endpoint.connectionId,conversationId:op.endpoint.conversationId,requestId:'ai-'+hash(identity),text:op.text,...(op.format?{format:op.format}:{}),replyTo:op.replyTo});
   return this.publicOperation(this.book.saveOperation(identity,{...op,...receipt}));
  }catch(e){return this.publicOperation(this.book.saveOperation(identity,{...op,status:'unknown',error:e instanceof HubError?e.code:'send_failed'}));}
 }
 async call(scope,method,input){
  if(!this.hub.config.scopes[scope]?.assistant)throw new HubError('not_authorized');
  if(method==='contact_resolve')return this.resolve(scope,z.object({recipient:z.string().min(1).max(500),connectionId:id.optional(),conversationId:ref.optional()}).strict().parse(input));
  if(method==='contact_search')return this.search(scope,input);
  if(method==='contact_save'){
   this.admin(scope);const c=contactSchema.parse(input),old=this.book.get(c.id);
   // Replacing a contact is allowed only when every old and new endpoint is visible to the editor.
   for(const e of [...(old?.endpoints??[]),...c.endpoints])this.require(scope,e);
   return {contact:this.book.put(c)};
  }
  if(method==='contact_merge'){
   this.admin(scope);const v=mergeInput.parse(input);
   for(const id of [v.targetId,v.sourceId]){const c=this.book.get(id);if(!c)throw new HubError('contact_not_found');for(const e of c.endpoints)this.require(scope,e);this.readableProfile(scope,personKey(c));}
   return {contact:this.book.merge(v.targetId,v.sourceId,v.targetRevision,v.sourceRevision)};
  }
  if(method==='contact_profile_set'){
   this.admin(scope);const v=profileInput.parse(input),c=this.book.get(v.contactId);if(!c)throw new HubError('contact_not_found');
   for(const e of c.endpoints)this.require(scope,e);
   let identity=personKey(c),sources=c.endpoints;
   if(v.connectionId||v.conversationId){const e=c.endpoints.find(e=>e.connectionId===v.connectionId&&e.conversationId===v.conversationId);if(!e)throw new HubError('contact_route_missing');identity=chatKey(e);sources=[e];}
   this.book.setProfile(identity,v.markdown,sources.map(e=>({connectionId:e.connectionId,conversationId:e.conversationId})));return {updated:true};
  }
  if(method==='personality_set'){this.admin(scope);const v=z.object({markdown:z.string().min(1).max(20000)}).strict().parse(input);this.book.setPersonality(v.markdown);return {updated:true};}
  if(method==='contact_prepare'||method==='contact_send')return this.compose(scope,input,method==='contact_send');
  if(method==='contact_delivery'){
   const v=z.object({requestId:id}).strict().parse(input),op=this.book.operation(key(scope,v.requestId));if(!op)return {status:'not_found'};
   this.checkOperation(scope,op);
   // A crash after transport receipt but before updating the preparation ledger is recoverable by reading only.
   if(['sending','unknown'].includes(op.status)&&op.text&&this.allowed(scope,op.endpoint,true)){
    const receipt=await this.hub.reconcileSend(scope,{connectionId:op.endpoint.connectionId,conversationId:op.endpoint.conversationId,requestId:'ai-'+hash(key(scope,v.requestId)),text:op.text,...(op.format?{format:op.format}:{}),replyTo:op.replyTo},op.preparedAt);
    if(receipt.tracked&&receipt.status!=='unknown'){const {tracked,...result}=receipt;return this.publicOperation(this.book.saveOperation(key(scope,v.requestId),{...op,...result}));}
   }
   return this.publicOperation(op);
  }
  throw new HubError('method_unknown');
 }
 close(){this.book.close();}
}
export {searchInput,profileInput};
