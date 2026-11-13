import {z} from 'zod';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {id,HubError,key} from './contracts.mjs';
import {hash} from './store.mjs';
import {diagnostic} from './errors.mjs';

const clientKey=z.string().min(1).max(300);
export const groupInput=z.object({connectionId:id,clientKey,title:z.string().min(1).max(128),botUsername:z.string().regex(/^@?[A-Za-z][A-Za-z0-9_]{4,31}$/),requestId:id}).strict();
export const groupResultInput=z.object({connectionId:id,clientKey}).strict();
export const groupGrant=z.object({ensure:z.boolean().default(false),read:z.boolean().default(false),clientKeys:z.union([z.literal('*'),z.array(clientKey)]).default([])}).strict();
/** Operator-owned per-connection policy; caller input can only match it, never
 * select another owner/bot. A changed policy cannot resume an old journal. */
export const groupConfig=z.object({enabled:z.boolean().default(false),connections:z.record(id,z.object({enabled:z.boolean().default(false),policyId:id,ownerId:z.string().regex(/^[1-9]\d*$/),botUsername:z.string().regex(/^[a-z][a-z0-9_]{4,31}$/),clientKeys:z.union([z.literal('*'),z.array(clientKey)]),titlePrefix:z.string().min(1).max(100).default('WorkZone · ')}).strict()).default({})}).strict();
const stages=['create','add_bot','promote_bot','general_unhide','general_open'];
/** `ready` is only a hint until the full provider evidence matches the owner/bot
 * policy. This guard prevents a malformed adapter response becoming a usable ID. */
function readyProof(r,owner){
 const v=r.verification,bot=r.botId;
 return /^-100[1-9]\d*$/.test(r.conversationId??'')&&/^\d+$/.test(bot??'')&&bot!==owner&&v?.ready===true&&v.private===true&&v.forum===true&&v.ownerIsCreator===true&&v.participantsComplete===true&&v.participantsExact===true&&Array.isArray(v.participantIds)&&v.participantIds.length===2&&[...v.participantIds].sort().join(',')===[owner,bot].sort().join(',')&&v.botIsAdmin===true&&v.botRightsExact===true&&Array.isArray(v.botRights)&&v.botRights.includes('manage_topics')&&v.botRights.every(x=>['manage_topics','other'].includes(x))&&v.general?.id==='1'&&v.general.exists===true&&v.general.hidden===false&&v.general.closed===false&&typeof v.checkedAt==='string'&&!Number.isNaN(Date.parse(v.checkedAt));
}
const includes=(values,value)=>values==='*'||values.includes(value);
/** Linux process identity prevents stealing a live operation on an elapsed lease.
 * PID reuse is distinguished by start ticks. No time-based takeover can duplicate
 * a still-running external create; only a proven dead process can be recovered. */
function processIdentity(pid=process.pid){return `${pid}:${readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[19]}`;}
/** Inaccessible /proc is uncertainty, not proof of death: retain the lock. */
export function processAlive(owner,read=processIdentity){
 if(!/^\d+:\d+$/.test(owner))return true;
 try{return read(Number(owner.split(':')[0]))===owner;}catch(e){return !['ENOENT','ESRCH'].includes(e.code);}
}

/** Independent group permissions never imply read/send rights in a resulting chat.
 * Journals bind the client key across authorized scopes, and request keys within
 * each scope. The bridge adds a second durable boundary around MTProto writes. */
export class Groups {
 constructor(hub,dependencies={}){
  this.hub=hub;this.db=hub.store.db;this.jobs=new Map();
  try{this.owner=processIdentity();}catch{throw new HubError('group_lock_platform_unsupported');}
  this.alive=dependencies.alive??processAlive;
  this.db.exec(`CREATE TABLE IF NOT EXISTS hub_groups(identity TEXT PRIMARY KEY,body TEXT NOT NULL,lock_owner TEXT);
   CREATE TABLE IF NOT EXISTS hub_group_requests(identity TEXT PRIMARY KEY,digest TEXT NOT NULL,group_identity TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS hub_group_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,scope TEXT NOT NULL,connection TEXT NOT NULL,client_hash TEXT NOT NULL,policy TEXT,action TEXT NOT NULL,decision TEXT NOT NULL,request TEXT);`);
  if(!this.db.prepare('PRAGMA table_info(hub_group_audit)').all().some(x=>x.name==='request'))this.db.exec('ALTER TABLE hub_group_audit ADD COLUMN request TEXT');
 }
 configured(connectionId){const p=this.hub.config.groupProvisioning?.connections[connectionId];return !!(this.hub.config.groupProvisioning?.enabled&&p?.enabled&&this.hub.config.connections[connectionId]?.plugin==='telegram'&&this.hub.instances.get(connectionId)?.groupStep&&this.hub.instances.get(connectionId)?.groupIdentity);}
 visible(scope,connectionId,write=false){const g=this.hub.config.scopes[scope]?.connections[connectionId]?.groups;return !!(g&&(write?g.ensure:g.read||g.ensure));}
 audit(scope,v,action,decision){this.db.prepare('INSERT INTO hub_group_audit(at,scope,connection,client_hash,policy,action,decision,request) VALUES(?,?,?,?,?,?,?,?)').run(new Date().toISOString(),scope,v.connectionId,hash(v.clientKey),this.hub.config.groupProvisioning?.connections[v.connectionId]?.policyId??null,action,decision,v.requestId??null);}
 authorize(scope,v,write){
  const g=this.hub.config.scopes[scope]?.connections[v.connectionId]?.groups;
  const p=this.hub.config.groupProvisioning?.connections[v.connectionId];
  if(!this.visible(scope,v.connectionId,write)||!includes(g.clientKeys,v.clientKey)){this.audit(scope,v,write?'ensure':'result','denied');throw new HubError('group_not_authorized');}
  if(write&&(!this.configured(v.connectionId)||!includes(p.clientKeys,v.clientKey))){this.audit(scope,v,'ensure','disabled_or_key_denied');throw new HubError('group_provisioning_disabled');}
  if(write&&(!v.title.startsWith(p.titlePrefix)||v.botUsername.replace(/^@/,'').toLowerCase()!==p.botUsername)){this.audit(scope,v,'ensure','policy_denied');throw new HubError('group_policy_violation');}
  return p;
 }
 get(identity){const row=this.db.prepare('SELECT * FROM hub_groups WHERE identity=?').get(identity);return row?{...JSON.parse(row.body),lockOwner:row.lock_owner}:null;}
 save(identity,op){const {lockOwner,...body}=op;body.updatedAt=new Date().toISOString();this.db.prepare('UPDATE hub_groups SET body=? WHERE identity=?').run(JSON.stringify(body),identity);return {...body,lockOwner};}
 result(op){if(!op)return {status:'not_found'};const {marker,bridgeKey,lockOwner,input,...safe}=op;return {...safe,chatId:op.conversationId??null,conversationId:op.conversationId??null,nextAction:op.status==='ready'?'Use the existing chat ID; this operation grants no message-send or agent-run authority.':op.status==='unknown'?'Repeat group_ensure with the same client key to reconcile. Do not create a replacement.':op.status==='in_progress'?'Poll group_result; the current operation owns this client key.':'Resolve the indicated issue and repeat group_ensure for this client key; the existing group is retained.'};}
 async ensure(scope,input){
  const v=groupInput.parse(input);v.botUsername=v.botUsername.replace(/^@/,'').toLowerCase();const p=this.authorize(scope,v,true);
  const identity=key(v.connectionId,v.clientKey),request=key(scope,v.connectionId,v.requestId);
  // Reserve both identities atomically before network I/O. Titles never identify groups.
  this.db.exec('BEGIN IMMEDIATE');try{
   const prior=this.db.prepare('SELECT * FROM hub_group_requests WHERE identity=?').get(request);
   if(prior&&prior.digest!==hash(v))throw new HubError('idempotency_conflict');
   this.db.prepare('INSERT OR IGNORE INTO hub_group_requests VALUES(?,?,?)').run(request,hash(v),identity);
   const op={status:'in_progress',connectionId:v.connectionId,clientKey:v.clientKey,requestId:v.requestId,policyId:p.policyId,ownerId:p.ownerId,botUsername:p.botUsername,title:v.title,input:v,bridgeKey:randomUUID(),marker:'WZ-Hub:'+randomBytes(24).toString('hex'),stage:'identity',completedStages:[],conversationId:null,verification:null,createdAt:new Date().toISOString()};
   this.db.prepare('INSERT OR IGNORE INTO hub_groups VALUES(?,?,NULL)').run(identity,JSON.stringify(op));this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
  this.audit(scope,v,'ensure','allowed');
  if(this.jobs.has(identity))return this.jobs.get(identity);
  let op=this.get(identity);
  if(op.policyId!==p.policyId||op.ownerId!==p.ownerId||op.botUsername!==p.botUsername)throw new HubError('group_policy_changed');
  this.db.exec('BEGIN IMMEDIATE');try{
   op=this.get(identity);
   if(op.lockOwner&&this.alive(op.lockOwner)){this.db.exec('COMMIT');return this.result({...op,status:'in_progress'});}
   this.db.prepare('UPDATE hub_groups SET lock_owner=? WHERE identity=?').run(this.owner,identity);this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
  const job=this.run(scope,identity,op,p).finally(()=>{this.db.prepare('UPDATE hub_groups SET lock_owner=NULL WHERE identity=? AND lock_owner=?').run(identity,this.owner);this.jobs.delete(identity);});
  this.jobs.set(identity,job);return job;
 }
 async run(scope,identity,op,p){
  const provider=this.hub.instances.get(op.connectionId);
  const persist=patch=>{op=this.save(identity,{...op,...patch});};
  const step=action=>provider.groupStep({...op.input,bridgeKey:op.bridgeKey,marker:op.marker,ownerId:p.ownerId,createUncertain:op.createAttempted===true,action});
  try{
   const self=await provider.groupIdentity();
   if(self.id!==p.ownerId||self.isSelf!==true||self.isBot!==false)throw new HubError('group_owner_mismatch',{expectedOwnerId:p.ownerId,actualSelfId:self.id,isSelf:self.isSelf});
   // Reconciliation reads the bridge journal and exact random description marker.
   // Missing evidence of a prior create NEVER authorizes a replacement create.
   let observed=await step('inspect');
   // A known creation ID survives a blocked or failed readback as well.
   if(observed.conversationId)persist({conversationId:observed.conversationId,verification:observed.verification,openUrl:observed.openUrl,botId:observed.botId});
   if(observed.status==='unknown'){persist({status:'unknown',stage:observed.stage??'create',diagnostic:observed.diagnostic});return this.result(op);}
   if(observed.status==='blocked'){persist({status:op.conversationId?'partial':'blocked',diagnostic:observed.diagnostic,stage:observed.stage??op.stage});return this.result(op);}
   for(const action of stages){
    // Every repeated write first observes provider state, including a recovered
    // in-flight step. Only the deterministic setters/invite may continue safely.
    if(observed.completedStages?.includes(action)){persist({completedStages:observed.completedStages});continue;}
    persist({status:'in_progress',stage:action,diagnostic:null,...(action==='create'?{createAttempted:true}:{})});this.audit(scope,op,action,'started');
    observed=await step(action);
    if(observed.conversationId)persist({conversationId:observed.conversationId,verification:observed.verification,openUrl:observed.openUrl,botId:observed.botId});
    if(observed.status!=='ok'){this.audit(scope,op,action,observed.status);persist({status:observed.status==='unknown'?'unknown':op.conversationId?'partial':'blocked',stage:action,diagnostic:observed.diagnostic});return this.result(op);}
    persist({completedStages:observed.completedStages});this.audit(scope,op,action,'confirmed');
   }
   persist({stage:'verify'});observed=await step('inspect');
   if(observed.status==='ok'&&observed.verification?.ready===true&&!readyProof(observed,p.ownerId))throw new HubError('group_verification_invalid');
   if(observed.status==='ok'&&readyProof(observed,p.ownerId)){persist({status:'ready',verification:observed.verification,openUrl:observed.openUrl,completedStages:observed.completedStages,diagnostic:null});}
   else persist({status:observed.status==='unknown'?'unknown':'partial',verification:observed.verification,diagnostic:observed.diagnostic??diagnostic(new HubError('group_verification_incomplete'),'verify')});
  }catch(e){this.audit(scope,op,op.stage,'failed_or_unknown');persist({status:op.stage==='identity'?'blocked':'unknown',diagnostic:diagnostic(e,op.stage)});}
  return this.result(op);
 }
 async call(scope,method,input){if(method==='group_ensure')return this.ensure(scope,input);const v=groupResultInput.parse(input);this.authorize(scope,v,false);this.audit(scope,v,'result','allowed');const op=this.get(key(v.connectionId,v.clientKey));return this.result(op);}
 async close(){await Promise.allSettled(this.jobs.values());}
}
