import {z} from 'zod';
import {checkedMentions} from './mentions.mjs';
import {randomUUID} from 'node:crypto';
import {route,id,ref,key,message,HubError} from './contracts.mjs';
import {presentPage} from './presentation.mjs';
import {resultChars} from './tool-result.mjs';
import {hash} from './store.mjs';
export const cacheConfig=z.object({defaultRead:z.enum(['cached','refresh']).default('cached'),staleAfterMs:z.number().int().min(1000).default(60000)}).strict();
export const catalogInput=z.object({connectionId:id,query:z.string().max(200).default(''),cursor:z.string().nullable().default(null),limit:z.number().int().min(1).max(100).default(50),readMode:z.enum(['cached','refresh']).optional()}).strict();
export const topicsInput=route.extend({query:z.string().max(200).default(''),cursor:z.string().nullable().default(null),limit:z.number().int().min(1).max(100).default(50),readMode:z.enum(['cached','refresh']).optional()}).strict();
export const contextReadInput=route.extend({messageId:ref,before:z.number().int().min(0).max(20).default(5),after:z.number().int().min(0).max(20).default(5),maxResponseChars:z.number().int().min(2000).max(200000).default(16000)}).strict();
const parse=r=>r?JSON.parse(r.body):null;

/** Cached bodies share the inbox FULL/WAL database. Native ingestion and journal
 * publication can commit together. Cache misses NEVER imply a provider call.
 * No retention deletion exists: journal/unacked and full evidence stay durable. */
export class ReadCache {
 constructor(hub,db){this.hub=hub;this.db=db;this.config=cacheConfig.parse(hub.config.cache??{});db.exec(`
 CREATE TABLE IF NOT EXISTS read_messages(identity TEXT PRIMARY KEY,connection TEXT NOT NULL,chat TEXT NOT NULL,message TEXT NOT NULL,body TEXT NOT NULL,observed INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS read_versions(seq INTEGER PRIMARY KEY AUTOINCREMENT,identity TEXT NOT NULL,digest TEXT NOT NULL,connection TEXT NOT NULL,chat TEXT NOT NULL,message TEXT NOT NULL,at TEXT NOT NULL,topic TEXT,body TEXT NOT NULL,UNIQUE(identity,digest));
 CREATE TABLE IF NOT EXISTS read_latest(identity TEXT PRIMARY KEY,version INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS read_latest_version ON read_latest(version);
 CREATE INDEX IF NOT EXISTS read_versions_order ON read_versions(connection,chat,at,message);
 CREATE INDEX IF NOT EXISTS read_messages_route ON read_messages(connection,chat);
 CREATE TABLE IF NOT EXISTS read_coverage(identity TEXT PRIMARY KEY,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS read_catalog(identity TEXT PRIMARY KEY,connection TEXT NOT NULL,chat TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS read_catalog_coverage(identity TEXT PRIMARY KEY,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS read_cache_pages(id TEXT PRIMARY KEY,scope TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL);`);
 }
 mode(v){return v.readMode??this.config.defaultRead;}
 observe(connectionId,m){if(m.mentionEvidence)m={...m,mentionEvidence:checkedMentions(m.text,m.mentionEvidence)};m=message.parse(m);const identity=key(connectionId,m.conversationId,m.id),body=JSON.stringify(m),digest=hash(m);this.db.prepare('INSERT OR IGNORE INTO read_versions(identity,digest,connection,chat,message,at,topic,body) VALUES(?,?,?,?,?,?,?,?)').run(identity,digest,connectionId,m.conversationId,m.id,m.at,m.topicId??null,body);const version=this.db.prepare('SELECT seq FROM read_versions WHERE identity=? AND digest=?').get(identity,digest).seq;this.db.prepare('INSERT OR REPLACE INTO read_latest VALUES(?,?)').run(identity,version);this.db.prepare('INSERT INTO read_messages VALUES(?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET body=excluded.body,observed=excluded.observed').run(key(connectionId,m.conversationId,m.id),connectionId,m.conversationId,m.id,JSON.stringify(m),Date.now());}
 /** Coverage is route-specific: a complete General page is not complete chat history. */
 page(connectionId,chat,p,{cursor=null,topicId=null,transport='provider_refresh'}={}){for(const m of p.items)this.observe(connectionId,m);const prior=parse(this.db.prepare('SELECT body FROM read_coverage WHERE identity=?').get(key(connectionId,chat,topicId)));const coverage={...prior,lastObservedAt:new Date().toISOString(),lastRefreshAt:new Date().toISOString(),lastTransport:transport,providerComplete:cursor===null&&p.complete||prior?.providerComplete===true,completeRefreshAt:cursor===null&&p.complete?new Date().toISOString():prior?.completeRefreshAt??null,providerNext:p.next,coverage:'observed_subset',gap:prior?.gap??false};this.db.prepare('INSERT OR REPLACE INTO read_coverage VALUES(?,?)').run(key(connectionId,chat,topicId),JSON.stringify(coverage));}
 freshness(connectionId,chat,scope,topicId=null){const r=parse(this.db.prepare('SELECT body FROM read_coverage WHERE identity=?').get(key(connectionId,chat,topicId)));const newest=this.db.prepare("SELECT MAX(observed) n,COUNT(*) count FROM read_messages WHERE connection=? AND chat=? AND (? IS NULL OR json_extract(body,'$.topicId')=?)").get(connectionId,chat,topicId,topicId);const observed=newest.n??null;const subs=scope?this.db.prepare('SELECT body FROM inbox_subs WHERE scope=?').all(scope).map(parse).filter(s=>s.connectionId===connectionId&&s.conversationId===chat):[];return {...r,source:'cache',cachedMessages:newest.count,lastObservedAt:observed?new Date(observed).toISOString():null,ageMs:observed?Math.max(0,Date.now()-observed):null,stale:!observed||Date.now()-observed>this.config.staleAfterMs,coverage:r?.providerComplete?'provider_reported_complete_at_refresh':'observed_subset',transportModes:[...new Set(subs.map(s=>s.transportMode??'history_poll'))],gap:subs.some(s=>s.coverage?.gap)||r?.gap||false,providerContacted:false,retention:'no_automatic_eviction'};}
 hydrate(scope,connectionId,m){if(!this.hub.media)return m;return {...m,attachments:m.attachments.map(a=>{const file=this.hub.media.register(connectionId,m,a);return this.hub.media.metadata(file);})};}
 /** Freeze a cached history window before pagination. Concurrent edits/arrivals
  * never reorder pages; next belongs to exact scope/route/presentation options. */
 history(scope,v){this.hub.access(scope,v.connectionId,v.conversationId);const {cursor,...options}=v,digest=hash(options);let state;
  if(cursor){if(!cursor.startsWith('cc:'))throw new HubError('cache_cursor_invalid');const row=this.db.prepare('SELECT * FROM read_cache_pages WHERE id=? AND scope=?').get(cursor.slice(3),scope);if(!row||row.digest!==digest)throw new HubError('cache_cursor_invalid');state=parse(row);}
  else state={rows:this.db.prepare('SELECT v.seq FROM read_versions v JOIN read_latest l ON l.version=v.seq WHERE v.connection=? AND v.chat=? AND (? IS NULL OR v.topic=?) ORDER BY v.at DESC,v.message DESC').all(v.connectionId,v.conversationId,v.topicId??null,v.topicId??null).map(r=>r.seq),offset:0,cache:this.freshness(v.connectionId,v.conversationId,scope,v.topicId??null)};
  const items=state.rows.slice(state.offset,state.offset+v.limit).map(seq=>this.hydrate(scope,v.connectionId,parse(this.db.prepare('SELECT body FROM read_versions WHERE seq=?').get(seq))));state.offset+=items.length;let next=null;
  if(state.offset<state.rows.length){const uuid=randomUUID();this.db.prepare('INSERT INTO read_cache_pages VALUES(?,?,?,?)').run(uuid,scope,digest,JSON.stringify(state));next='cc:'+uuid;}
  return {items,next,complete:!next&&state.cache.coverage==='provider_reported_complete_at_refresh',cache:state.cache};
 }
 /** Search only observed cached text; freeze matching revisions before paging.
  * No provider, model, media download or paid transcription can run here. */
 search(scope,v){this.hub.access(scope,v.connectionId,v.conversationId);const {cursor,...options}=v,digest=hash(['search',options]);let state;
  if(cursor){const row=this.db.prepare('SELECT * FROM read_cache_pages WHERE id=? AND scope=?').get(cursor.replace(/^cc:/,''),scope);if(!cursor.startsWith('cc:')||!row||row.digest!==digest)throw new HubError('cache_cursor_invalid');state=parse(row);}
  else{const query=v.query.toLocaleLowerCase();state={rows:this.db.prepare('SELECT v.seq,v.body FROM read_versions v JOIN read_latest l ON l.version=v.seq WHERE v.connection=? AND v.chat=? AND (? IS NULL OR v.topic=?) ORDER BY v.at DESC,v.message DESC').all(v.connectionId,v.conversationId,v.topicId??null,v.topicId??null).filter(r=>(parse(r).text??'').toLocaleLowerCase().includes(query)).map(r=>r.seq),offset:0};}
  const items=state.rows.slice(state.offset,state.offset+v.limit).map(seq=>this.hydrate(scope,v.connectionId,parse(this.db.prepare('SELECT body FROM read_versions WHERE seq=?').get(seq))));state.offset+=items.length;let next=null;if(state.offset<state.rows.length){const uuid=randomUUID();this.db.prepare('INSERT INTO read_cache_pages VALUES(?,?,?,?)').run(uuid,scope,digest,JSON.stringify(state));next='cc:'+uuid;}
  return {...presentPage({items,next,complete:next===null},{mode:'compact',maxTextChars:1200,maxTranscriptChars:1200}),cache:this.freshness(v.connectionId,v.conversationId,scope,v.topicId??null),coverage:'observed_cached_text_only',cachedAudioMatches:this.hub.media?.cachedSearch(scope,v,v.query,v.limit)??[]};
 }
 get(scope,v){this.hub.access(scope,v.connectionId,v.conversationId);const m=parse(this.db.prepare('SELECT body FROM read_messages WHERE identity=?').get(key(v.connectionId,v.conversationId,v.messageId)));if(!m||v.topicId!==undefined&&m.topicId!==v.topicId)throw new HubError('message_not_cached',{nextAction:'Use message_get with readMode:refresh explicitly; no provider was contacted.'});return {message:this.hydrate(scope,v.connectionId,m),complete:m.contentComplete!==false,cache:this.freshness(v.connectionId,v.conversationId,scope,v.topicId??null)};}
 context(scope,v){this.hub.access(scope,v.connectionId,v.conversationId);const anchor=this.get(scope,v),m=anchor.message;
  const query=(side,n)=>this.db.prepare(`SELECT body FROM read_messages WHERE connection=? AND chat=? AND (? IS NULL OR json_extract(body,'$.topicId')=?) AND (json_extract(body,'$.at'),message) ${side==='before'?'<':'>'} (?,?) ORDER BY json_extract(body,'$.at') ${side==='before'?'DESC':'ASC'},message ${side==='before'?'DESC':'ASC'} LIMIT ?`).all(v.connectionId,v.conversationId,v.topicId??null,v.topicId??null,m.at,m.id,n).map(parse);
  const rows=[...query('before',v.before).reverse(),m,...query('after',v.after)],brief=x=>presentPage({items:[x]},{mode:'compact',maxTextChars:1200,maxTranscriptChars:1200}).items[0];
  const r={anchor:brief(m),items:rows.map(brief),cache:anchor.cache,coverage:'observed_cache_only',omitted:[],fullMessageTool:'messenger_message_get'};
  while(resultChars(r)>v.maxResponseChars&&r.items.length){const x=r.items.pop();r.omitted.push(x.id);}if(resultChars(r)>v.maxResponseChars){r.anchor={id:m.id,detailsOmitted:true};}if(resultChars(r)>v.maxResponseChars)throw new HubError('response_budget_too_small');return r;
 }

 async catalog(scope,input,topics=false){const v=(topics?topicsInput:catalogInput).parse(input),{instance,scope:grant}=this.hub.access(scope,v.connectionId,topics?v.conversationId:undefined),bucket=key(v.connectionId,topics?v.conversationId:'');
  if(this.mode(v)==='refresh'){if(topics&&!instance.topics)throw new HubError('topics_unsupported');const result=await (topics?instance.topics(v):instance.conversations(v));for(const x of result.items){const body=topics?x:{...x};this.db.prepare('INSERT OR REPLACE INTO read_catalog VALUES(?,?,?,?)').run(key(bucket,x.id),v.connectionId,topics?v.conversationId:'',JSON.stringify(body));}this.db.prepare('INSERT OR REPLACE INTO read_catalog_coverage VALUES(?,?)').run(bucket,JSON.stringify({lastRefreshAt:new Date().toISOString(),providerComplete:v.query===''&&result.next===null&&result.complete!==false,next:result.next,query:v.query}));return {...result,items:result.items.filter(x=>topics||grant.conversations==='*'||grant.conversations.includes(x.id)).map(x=>({...x,canSend:!!grant.send&&instance.capabilities.send&&(x.canSend??true)})),source:'provider_refresh',providerContacted:true};}
  const {cursor,...options}=v,digest=hash(['catalog',topics,options]);let state;
  if(cursor){const row=this.db.prepare('SELECT * FROM read_cache_pages WHERE id=? AND scope=?').get(cursor.replace(/^cc:/,''),scope);if(!row||row.digest!==digest)throw new HubError('cache_cursor_invalid');state=parse(row);}
  else state={rows:this.db.prepare('SELECT body FROM read_catalog WHERE connection=? AND chat=?').all(v.connectionId,topics?v.conversationId:'').map(parse).filter(x=>(topics||grant.conversations==='*'||grant.conversations.includes(x.id))&&`${x.title} ${x.id} ${x.username??''}`.toLocaleLowerCase().includes(v.query.toLocaleLowerCase())),offset:0};
  const window=state.rows.slice(state.offset,state.offset+v.limit);const items=window.filter(x=>topics||grant.conversations==='*'||grant.conversations.includes(x.id)).map(x=>({...x,canSend:!!grant.send&&instance.capabilities.send&&(x.canSend??true)}));state.offset+=window.length;let next=null;if(state.offset<state.rows.length){const uuid=randomUUID();this.db.prepare('INSERT INTO read_cache_pages VALUES(?,?,?,?)').run(uuid,scope,digest,JSON.stringify(state));next='cc:'+uuid;}
  return {items,next,source:'cache',providerContacted:false,coverage:parse(this.db.prepare('SELECT body FROM read_catalog_coverage WHERE identity=?').get(bucket))??{providerComplete:false,lastRefreshAt:null},capabilities:{topics:!!instance.topics,send:!!grant.send&&instance.capabilities.send,sendAttachments:!!grant.send&&instance.capabilities.sendAttachments},complete:next===null};
 }
}
