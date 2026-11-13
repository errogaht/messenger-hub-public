import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {id,route,key,HubError} from './contracts.mjs';
import {hash} from './store.mjs';
import {resultChars} from './tool-result.mjs';

/** These operator-confirmed links describe routing, never grant provider access.
 * Names are labels. Shared conversations intentionally return multiple projects. */
export const projectBinding=z.object({scope:id,projectId:id,clientId:id,label:z.string().max(200).optional(),contactId:id.optional(),confirmed:z.literal(true),routes:z.array(route.strict()).min(1).max(100)}).strict();
export const projectsInput=z.object({projectId:id.optional()}).strict();
export const replayInput=z.object({consumerId:id,cursor:z.string().uuid().optional(),after:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(50),maxResponseChars:z.number().int().min(2000).max(200000).default(16000),maxTextChars:z.number().int().min(0).max(10000).default(1200)}).strict();
export const diagnosticsInput=z.object({consumerId:id}).strict();
export const contextInput=z.object({consumerId:id,eventId:z.string().uuid(),before:z.number().int().min(0).max(20).default(5),after:z.number().int().min(0).max(20).default(5),replyDepth:z.number().int().min(0).max(20).default(5),maxResponseChars:z.number().int().min(2000).max(200000).default(16000),maxTextChars:z.number().int().min(0).max(10000).default(1200)}).strict();
const parse=r=>r?JSON.parse(r.body):null;

/** Read models share the existing inbox journal. Replay and SSE never advance
 * consumer ack, acquire a lease, contact a provider, or execute external work.
 * Opaque cursor records bind every page/resume position to one exact consumer. */
export class InboxRead {
 constructor(inbox){this.i=inbox;this.db=inbox.db;this.db.exec("CREATE TABLE IF NOT EXISTS inbox_read_cursors(id TEXT PRIMARY KEY,consumer TEXT NOT NULL,body TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS inbox_push_position ON inbox_read_cursors(consumer,json_extract(body,'$.after')) WHERE json_extract(body,'$.kind')='push'");}
 projects(scope,input={}){
  this.i.authorize(scope);const v=projectsInput.parse(input),items=[];
  for(const p of this.i.config.projects.filter(p=>p.scope===scope&&(!v.projectId||v.projectId===p.projectId))){
   // A stale/revoked contact binding must not silently become a guessed identity.
   const routes=p.routes.filter(r=>{try{this.i.hub.access(scope,r.connectionId,r.conversationId);if(p.contactId&&this.i.hub.contactAgent?.book.byEndpoint(r)?.id!==p.contactId)return false;return true;}catch{return false;}});
   items.push({...p,scope:undefined,routes,status:routes.length===p.routes.length?'confirmed':'binding_unavailable',revision:hash(p)});
  }
  return {items,collectionEnabled:this.i.config.enabled,pushEnabled:this.i.config.push.enabled,authority:'read_only_mapping',unmapped:'unassigned',sharedConversation:'ambiguous'};
 }
 routing(scope,source){const candidates=this.projects(scope).items.filter(p=>p.status==='confirmed'&&p.routes.some(r=>r.connectionId===source.connectionId&&r.conversationId===source.conversationId&&(r.topicId===undefined||r.topicId===source.topicId))).map(p=>({projectId:p.projectId,clientId:p.clientId,contactId:p.contactId??null,bindingRevision:p.revision}));return {status:candidates.length===1?'candidate':candidates.length?'ambiguous':'unassigned',candidates,requiresContentTriage:true};}
 subscriptions(scope,consumerId){return this.i.getConsumer(scope,consumerId).spec.subscriptionIds.map(s=>key(scope,s));}
 cursor(scope,consumerId,spec){const cursor=randomUUID();this.db.prepare('INSERT OR IGNORE INTO inbox_read_cursors VALUES(?,?,?)').run(cursor,key(scope,consumerId),JSON.stringify(spec));return spec.kind==='push'?this.db.prepare("SELECT id FROM inbox_read_cursors WHERE consumer=? AND json_extract(body,'$.kind')='push' AND json_extract(body,'$.after')=?").get(key(scope,consumerId),spec.after).id:cursor;}
 readCursor(scope,consumerId,cursor,kind){const r=parse(this.db.prepare('SELECT body FROM inbox_read_cursors WHERE id=? AND consumer=?').get(cursor,key(scope,consumerId)));if(!r||r.kind!==kind)throw new HubError('inbox_cursor_invalid');return r;}
 headers(subs,after,upper,limit){return this.db.prepare(`SELECT sequence,id,subscription,available_at FROM inbox_events WHERE sequence>? AND sequence<=? AND subscription IN (${subs.map(()=>'?').join(',')}) ORDER BY sequence LIMIT ?`).all(after,upper,...subs,limit);}
 newest(subs){return this.db.prepare(`SELECT COALESCE(MAX(sequence),0) n FROM inbox_events WHERE subscription IN (${subs.map(()=>'?').join(',')})`).get(...subs).n;}
 /** Capture a high-water mark once; continuation cannot accidentally include a
  * moving backlog. Every immutable page persists before returning its cursor.
  * Raw ingest is explicit: settled leases, rather than replay, govern ack. */
 replay(scope,input){const v=replayInput.parse(input),subs=this.subscriptions(scope,v.consumerId);
  return this.i.transaction(()=>{
   let spec=v.cursor?this.readCursor(scope,v.consumerId,v.cursor,'replay'):{kind:'replay',snapshotId:randomUUID(),after:v.after,upper:this.newest(subs),options:{limit:v.limit,maxResponseChars:v.maxResponseChars,maxTextChars:v.maxTextChars}};
   if(spec.result)return spec.result;
   if(spec.after>spec.upper)throw new HubError('inbox_cursor_ahead');
   const o=spec.options,rows=this.headers(subs,spec.after,spec.upper,o.limit+1),r={snapshotId:spec.snapshotId,batchId:hash([spec.snapshotId,spec.after,o]),consumerId:v.consumerId,readiness:'raw_observed',from:spec.after,to:spec.after,upper:spec.upper,items:[],hasMore:false,nextCursor:null,acknowledges:false};
   for(const row of rows){if(r.items.length===o.limit){r.hasMore=true;break;}const e=parse(this.db.prepare('SELECT body FROM inbox_events WHERE id=?').get(row.id));const item={...this.i.brief(e,o.maxTextChars),routing:this.routing(scope,e.source)};r.items.push(item);r.to=row.sequence;
    // Both immutable page and continuation cursors are serialized later. Reserve
    // their bytes before accepting a row, or a full page can permanently stall replay.
    if(resultChars({...r,cursor:'0'.repeat(36),nextCursor:'0'.repeat(36)})>o.maxResponseChars){r.items.pop();r.to=r.items.at(-1)?.sequence??spec.after;if(!r.items.length){r.items.push({eventId:e.eventId,sequence:row.sequence,source:e.source,version:e.version,kind:e.kind,detailsOmitted:true});r.to=row.sequence;}r.hasMore=r.to<spec.upper;break;}
   }
   if(r.hasMore)r.nextCursor=this.cursor(scope,v.consumerId,{...spec,after:r.to,result:undefined});
   if(resultChars(r)>o.maxResponseChars)throw new HubError('inbox_response_budget_too_small');
   const pageCursor=v.cursor??this.cursor(scope,v.consumerId,spec);r.cursor=pageCursor;this.db.prepare('UPDATE inbox_read_cursors SET body=? WHERE id=?').run(JSON.stringify({...spec,result:r}),pageCursor);
   // Initial page cursor is also replayable; account for its bytes in the budget.
   if(resultChars(r)>o.maxResponseChars)throw new HubError('inbox_response_budget_too_small');return r;
  });
 }
 diagnostics(scope,input){const v=diagnosticsInput.parse(input),c=this.i.getConsumer(scope,v.consumerId),subs=this.subscriptions(scope,v.consumerId),newest=this.newest(subs),rows=this.headers(subs,c.offset,newest,1),lease=c.batchId?parse(this.db.prepare('SELECT body FROM inbox_batches WHERE id=?').get(c.batchId)):null;
  return {consumerId:v.consumerId,observedCursor:newest,ackedCursor:c.offset,pendingEvents:this.db.prepare(`SELECT COUNT(*) n FROM inbox_events WHERE sequence>? AND subscription IN (${subs.map(()=>'?').join(',')})`).get(c.offset,...subs).n,pendingCountExact:true,leasedEvents:lease?.items.length??0,failedBatches:'tracked_by_external_consumer_only',lagMs:rows.length?Math.max(0,this.i.now()-Date.parse(parse(this.db.prepare('SELECT body FROM inbox_events WHERE id=?').get(rows[0].id)).observedAt)):0,oldestPendingReceivedAt:rows.length?parse(this.db.prepare('SELECT body FROM inbox_events WHERE id=?').get(rows[0].id)).observedAt:null,lease:lease?{batchId:lease.batchId,to:lease.to,expiresAt:lease.expiresAt,status:lease.expiresAt>this.i.now()?'leased':'expired'}:null,subscriptions:c.spec.subscriptionIds.map(s=>this.i.publicSub(this.i.sub(scope,s))),workerEnabled:this.i.workerEnabled(scope),pushEnabled:this.i.config.push.enabled,semantics:'observed_and_external_save_ack_not_delivery_or_task_completion'};
 }
 context(scope,input){const v=contextInput.parse(input),e=this.i.event(scope,{consumerId:v.consumerId,eventId:v.eventId}),sub=key(scope,e.subscriptionId),rows=this.db.prepare('SELECT body FROM inbox_sources WHERE subscription=? ORDER BY json_extract(body,\'$.at\'),message').all(sub).map(parse),index=rows.findIndex(m=>m.id===e.message.id),items=index<0?[]:rows.slice(Math.max(0,index-v.before),index+v.after+1);let reply=e.message.replyTo;const chain=[],seen=new Set([e.message.id]);
  while(reply&&chain.length<v.replyDepth&&!seen.has(reply)){seen.add(reply);const m=parse(this.db.prepare('SELECT body FROM inbox_sources WHERE identity=?').get(key(sub,reply)));if(!m)break;chain.push(m);reply=m.replyTo;}
  const brief=m=>this.i.brief({...e,message:m,context:[]},v.maxTextChars).message;
  const r={eventId:e.eventId,anchor:e.source,anchorVersion:e.version,items:items.map(brief),replyChain:chain.map(brief),replyChainComplete:!reply,coverage:'observed_cache_only_latest_neighbors_immutable_anchor_via_event_get',omitted:[]};
  while(resultChars(r)>v.maxResponseChars&&(r.items.length||r.replyChain.length)){const m=r.items.length?r.items.pop():r.replyChain.pop();r.omitted.push(m.id);r.replyChainComplete=false;}if(resultChars(r)>v.maxResponseChars)throw new HubError('inbox_response_budget_too_small');return r;
 }
 /** SSE wakeups carry source identifiers only. Persisting the resume token
  * before socket write makes lost responses recoverable using the last ID the
  * client actually received. Ack/settling remain separate, explicit operations. */
 notifications(scope,consumerId,lastId,limit=100){this.i.authorize(scope);if(!this.i.config.push.enabled||!this.i.hub.config.scopes[scope]?.inbox?.push)throw new HubError('inbox_push_disabled');const subs=this.subscriptions(scope,consumerId),after=lastId?this.readCursor(scope,consumerId,lastId,'push').after:this.i.getConsumer(scope,consumerId).offset;
  return this.headers(subs,after,this.newest(subs),limit).map(row=>({id:this.cursor(scope,consumerId,{kind:'push',after:row.sequence}),event:'inbox_observed',data:{eventId:row.id,sequence:row.sequence,readiness:'raw_observed',consumerId,requiresClaim:true}}));
 }
}
