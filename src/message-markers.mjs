import {z} from 'zod';
import {id,ref,HubError,key} from './contracts.mjs';
import {hash} from './store.mjs';
import {diagnostic} from './errors.mjs';
export const markerStatus=z.enum(['viewed','in_progress','completed','question']);
export const markerInput=z.object({connectionId:id,conversationId:ref,messageId:ref,status:markerStatus,requestId:id}).strict();
export const markerResultInput=z.object({connectionId:id,requestId:id}).strict();
export const markerEmoji={viewed:'👀',in_progress:'👨‍💻',completed:'✅',question:'🤔'};
/** Reaction intents are external effects, separate from task state and inbox ack.
 * Persist before provider I/O. Unknown writes cannot be retried or overwritten;
 * another scope cannot bypass the per-account/message guard. No speech/text here. */
export class MessageMarkers {
 constructor(hub){this.hub=hub;this.db=hub.store.db;this.active=new Set();this.db.exec('CREATE TABLE IF NOT EXISTS marker_intents(identity TEXT PRIMARY KEY,scope TEXT,route TEXT,digest TEXT,body TEXT); CREATE INDEX IF NOT EXISTS marker_route ON marker_intents(route);');}
 get(identity){const r=this.db.prepare('SELECT body FROM marker_intents WHERE identity=?').get(identity);return r?JSON.parse(r.body):null;}
 save(identity,r){this.db.prepare('UPDATE marker_intents SET body=? WHERE identity=?').run(JSON.stringify(r),identity);return r;}
 async result(scope,input){const v=markerResultInput.parse(input),identity=key(scope,v.connectionId,v.requestId),r=this.get(identity);if(!r)throw new HubError('marker_request_not_found');const {instance}=this.hub.access(scope,r.connectionId,r.conversationId);if(!this.active.has(identity)&&r.state==='unknown'&&instance.reconcileMarker){try{const proof=await instance.reconcileMarker(r);if(proof?.state==='applied')return this.save(identity,{...r,...proof});}catch{/* Read failure does not turn an ambiguous write into a new send. */}}return r;}
 async mark(scope,input){const v=markerInput.parse(input),{instance}=this.hub.access(scope,v.connectionId,v.conversationId,true);if(!instance.markMessage)throw new HubError('message_markers_unsupported');const identity=key(scope,v.connectionId,v.requestId),route=key(v.connectionId,v.conversationId,v.messageId),digest=hash(v);
  this.db.exec('BEGIN IMMEDIATE');let existing;
  try{existing=this.get(identity);if(existing&&this.db.prepare('SELECT digest FROM marker_intents WHERE identity=?').get(identity).digest!==digest)throw new HubError('idempotency_conflict');
   if(!existing){const busy=this.db.prepare("SELECT 1 FROM marker_intents WHERE route=? AND json_extract(body,'$.state')='unknown'").get(route);if(busy)throw new HubError('marker_in_flight',{nextAction:'Inspect the original marker request; do not overwrite an unresolved reaction.'});const r={...v,state:'unknown',phase:'prepare',emoji:markerEmoji[v.status],confirmation:'unconfirmed',createdAt:new Date().toISOString()};this.db.prepare('INSERT INTO marker_intents VALUES(?,?,?,?,?)').run(identity,scope,route,digest,JSON.stringify(r));}
   this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
  if(existing)return this.result(scope,{connectionId:v.connectionId,requestId:v.requestId});
  this.active.add(identity);let submitted=false;
  try{const proof=await instance.markMessage(v,{submitting:()=>{submitted=true;this.save(identity,{...this.get(identity),phase:'write'});}});return this.save(identity,{...this.get(identity),...proof,phase:'finished'});}
  catch(e){const r=this.get(identity),detail=diagnostic(e,submitted?'marker_write':'marker_prepare',v.requestId);if(submitted)detail.nextAction='Read messenger_message_mark_result with the original connectionId/requestId. Never repeat an unknown write under a new requestId.';return this.save(identity,{...r,state:submitted?'unknown':'failed',diagnostic:detail,confirmation:'unconfirmed'});}
  finally{this.active.delete(identity);}
 }
}
