import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {id,ref,route,page,conversation,HubError,key} from './contracts.mjs';
import {hash} from './store.mjs';
export const searchMessagesInput=route.extend({query:z.string().min(1).max(500),readMode:z.enum(['cached','refresh']).optional(),cursor:z.string().max(2000).nullable().default(null),limit:z.number().int().min(1).max(100).default(50)}).strict();
export const contactsInput=z.object({connectionId:id,query:z.string().max(200).default(''),limit:z.number().int().min(1).max(100).default(50),cursor:z.string().max(2000).nullable().default(null)}).strict();
// Both the burst silence and total call budget may span ten minutes; defaults
// stay short so existing callers keep their polling/cursor cadence.
export const waitInput=z.object({subscriptions:z.array(route.extend({afterMessageId:ref.optional()}).strict()).min(1).max(20),cursor:z.string().uuid().nullable().default(null),settleMs:z.number().int().min(250).max(600000).default(6000),maxWaitMs:z.number().int().min(1).max(600000).default(50000),direction:z.enum(['inbound','all']).default('inbound')}).strict();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/** Uniform read tools. Wait cursors are scope-bound snapshots, never a shared consuming event queue. */
export class ReadTools {
 constructor(hub,filename,{pollMs=2000}={}){
  this.hub=hub;this.pollMs=pollMs;this.jobs=new Map();this.snapshots=new Map();this.closed=false;
  if(filename!==':memory:')mkdirSync(dirname(filename),{recursive:true,mode:0o700});
  this.db=new DatabaseSync(filename);if(filename!==':memory:')chmodSync(filename,0o600);
  this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS waits(id TEXT PRIMARY KEY,scope TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT);');
 }
 async contacts(scope,input){
  const v=contactsInput.parse(input),{instance,scope:grant}=this.hub.access(scope,v.connectionId);
  if(!instance.contacts)return this.hub.call(scope,'conversations',v);
  const r=await instance.contacts(v);
  const items=z.array(conversation).max(1000).parse(r.items).filter(x=>grant.conversations==='*'||grant.conversations.includes(x.id)).map(x=>({...x,canSend:x.canSend&&grant.send}));
  return {items,next:r.next??null,complete:r.complete??r.next===null,coverage:{source:'provider_contacts',complete:r.complete??r.next===null,query:v.query,scopeFiltered:grant.conversations!=='*'}};
 }
 async search(scope,input){
  const v=searchMessagesInput.parse(input),{instance}=this.hub.access(scope,v.connectionId,v.conversationId);
  if(this.hub.cache.mode(v)==='cached')return this.hub.cache.search(scope,v);
  // Providers with native search retain their own cursors. Others scan one explicit history page.
  const native=!!instance.search;
  let result=page.parse(await (native?instance.search(v):instance.history({...v,query:undefined})));
  if(result.items.some(m=>m.conversationId!==v.conversationId))throw new HubError('provider_route_mismatch');
  this.hub.store.observe(v.connectionId,result.items);for(const m of result.items)this.hub.cache.observe(v.connectionId,m);
  if(!native)result={...result,items:result.items.filter(m=>m.text?.toLocaleLowerCase().includes(v.query.toLocaleLowerCase()))};
  const cached=this.hub.media?.cachedSearch(scope,v,v.query,v.limit)??[];
  const combined=new Map(result.items.map(m=>[m.id,m]));for(const m of cached)combined.set(m.id,m);
  // Cached matches are returned separately so they cannot consume a native page's slots/cursor.
  const providerIds=new Set(result.items.map(m=>m.id));
  result={...result,items:result.items.map(m=>combined.get(m.id))};
  if(this.hub.media)result=await this.hub.media.enrich(scope,v.connectionId,result);
  return {...result,cachedAudioMatches:cached.filter(m=>!providerIds.has(m.id)),coverage:native?(instance.searchCoverage??'provider_search_plus_observed_audio'):'one_history_page_plus_observed_audio'};
 }
 save(scope,digest,state){const id=randomUUID();this.db.prepare('INSERT INTO waits VALUES(?,?,?,?,NULL)').run(id,scope,digest,JSON.stringify(state));return id;}
 async wait(scope,input){
  const v=waitInput.parse(input);
  for(const r of v.subscriptions)this.hub.access(scope,r.connectionId,r.conversationId);
  if(new Set(v.subscriptions.map(r=>key(r.connectionId,r.conversationId))).size!==v.subscriptions.length)throw new HubError('duplicate_subscription');
  const digest=hash({subscriptions:v.subscriptions,direction:v.direction,settleMs:v.settleMs});
  let cursor=v.cursor,row;
  if(cursor){row=this.db.prepare('SELECT * FROM waits WHERE id=? AND scope=?').get(cursor,scope);if(!row)throw new HubError('wait_cursor_not_found');if(row.digest!==digest)throw new HubError('wait_cursor_mismatch');if(row.result)return JSON.parse(row.result);}
  else {const routes={};for(const r of v.subscriptions)if(r.afterMessageId)routes[key(r.connectionId,r.conversationId)]={seen:[r.afterMessageId],pending:[],lastActivity:0};cursor=this.save(scope,digest,{routes});row=this.db.prepare('SELECT * FROM waits WHERE id=?').get(cursor);}
  if(this.jobs.has(cursor))return this.jobs.get(cursor);
  if(this.jobs.size>=20)throw new HubError('too_many_waiters');
  const promise=this.poll(scope,v,JSON.parse(row.state)).then(result=>{
   const {state,...value}=result;const nextCursor=this.save(scope,digest,state),output={...value,cursor:nextCursor};
   this.db.prepare('UPDATE waits SET result=? WHERE id=?').run(JSON.stringify(output),cursor);return output;
  });
  this.jobs.set(cursor,promise);try{return await promise;}finally{this.jobs.delete(cursor);}
 }
 /** Coalesce provider polls across consumers without sharing or consuming their cursor state. */
 snapshot(scope,route,cursor=null){
  this.hub.access(scope,route.connectionId,route.conversationId);
  const k=key(route.connectionId,route.conversationId,cursor),existing=this.snapshots.get(k);
  if(existing&&(existing.pending||Date.now()-existing.at<this.pollMs))return existing.promise;
  for(const [key,entry] of this.snapshots)if(!entry.pending&&Date.now()-entry.at>this.pollMs)this.snapshots.delete(key);
  if(this.snapshots.size>=200)throw new HubError('too_many_history_requests');
  const entry={pending:true,at:Date.now()};entry.promise=this.hub.readHistory(scope,{...route,cursor,limit:100,includeMetadata:false}).finally(()=>{entry.pending=false;entry.at=Date.now();});
  this.snapshots.set(k,entry);return entry.promise;
 }
 async poll(scope,v,state){
  const deadline=Date.now()+v.maxWaitMs;let initialized=false;
  while(!this.closed&&Date.now()<deadline){
   // Snapshot reads are concurrent across independent portals but never trigger media downloads here.
   let pages;
   try{pages=await deadlineCall(Promise.all(v.subscriptions.map(r=>this.snapshot(scope,r))),deadline-Date.now());}
   catch(e){if(e instanceof HubError&&e.code==='wait_deadline')break;return {event:false,reason:'provider_unavailable',state};}
   for(let i=0;i<pages.length;i++){
    const r=v.subscriptions[i],p=pages[i],k=key(r.connectionId,r.conversationId),s=state.routes[k];
    if(!s){state.routes[k]={seen:p.items.map(m=>m.id),pending:[],lastActivity:0};initialized=true;continue;}
    const known=new Set(s.seen),newMessages=[];let current=p,found=known.size===0;
    for(let depth=0;depth<5;depth++){
     for(const m of current.items){if(known.has(m.id)){found=true;break;}newMessages.push(m);}
     if(found||current.complete||!current.next)break;
     try{current=await deadlineCall(this.snapshot(scope,r,current.next),deadline-Date.now());}catch{return {event:false,reason:'history_gap',route:r,state};}
    }
    if(!found&&s.seen.length&&newMessages.length)return {event:false,reason:'history_gap',route:r,state};
    const incoming=newMessages.filter(m=>!m.deletedAt&&(v.direction==='all'||m.direction==='inbound'));
    if(incoming.length){const existing=new Map(s.pending.map(m=>[m.id,m]));for(const m of incoming)existing.set(m.id,m);if(existing.size>500)return {event:false,reason:'burst_limit',route:r,state};s.pending=[...existing.values()];s.lastActivity=Date.now();}
    s.seen=p.items.map(m=>m.id);
   }
   const events=[];
   for(const r of v.subscriptions){const s=state.routes[key(r.connectionId,r.conversationId)];if(s?.pending.length&&Date.now()-s.lastActivity>=v.settleMs){
    let p={items:s.pending,next:null,complete:true,order:'opaque'};
    // Waiting returns a burst summary. Full history performs metadata/ASR work outside this deadline.
    events.push({...r,items:p.items,readHistoryRequired:true});s.pending=[];
   }}
   if(events.length)return {event:true,events,state};
   await sleep(Math.max(0,Math.min(this.pollMs,deadline-Date.now())));
  }
  return {event:false,reason:'timeout',initialized,state};
 }
 async close(){this.closed=true;await Promise.allSettled(this.jobs.values());this.db.close();}
}
async function deadlineCall(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new HubError('wait_deadline')),Math.max(1,ms));})]);}finally{clearTimeout(timer);}}
