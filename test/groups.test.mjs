import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Hub} from '../src/hub.mjs';
import {Store} from '../src/store.mjs';
import {HubError,key} from '../src/contracts.mjs';
import {createMcp} from '../src/mcp.mjs';

const input={connectionId:'tg',clientKey:'workzone:client-1',title:'WorkZone · Клиент',botUsername:'@example_forum_bot',requestId:'group-first'};
/** Provider evidence outlives a Hub instance; no Telegram runtime or writes occur.
 * Faults occur AFTER a provider effect so crash/reconciliation tests cannot pass
 * merely by retrying the original create. */
function fixture(t,options={}){
 const root=mkdtempSync(path.join(tmpdir(),'hub-groups-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const state={created:false,steps:[],writes:[],lost:false};
 const observe=()=>({status:'ok',conversationId:state.created?'-100321':null,botId:'777',completedStages:[...state.steps],verification:{ready:state.steps.length===5,private:true,forum:true,participantsExact:state.steps.includes('add_bot'),botRightsExact:state.steps.includes('promote_bot'),ownerIsCreator:true,participantsComplete:true,participantIds:[(options.ownerId??'100000001'),'777'],botIsAdmin:state.steps.includes('promote_bot'),botRights:['manage_topics','other'],general:{id:'1',exists:true,hidden:false,closed:false},checkedAt:new Date().toISOString()},openUrl:'https://t.me/c/321/1'});
 const plugin={id:'telegram',contractVersion:1,create:()=>({capabilities:{history:true,send:false,attachments:false,changes:false,kinds:['message']},conversations:async()=>({items:[],next:null}),history:async()=>({items:[],next:null,complete:true}),groupIdentity:async()=>({id:options.wrongSelf?'123':(options.ownerId??'100000001'),isSelf:true,isBot:false}),groupStep:async v=>{
  if(v.action==='inspect')return options.unreconciled&&state.lost?{status:'unknown',stage:'create',diagnostic:{code:'group_creation_unconfirmed'}}:observe();
  if(options.deny===v.action)return {status:'blocked',diagnostic:{code:v.action==='add_bot'?'group_bot_invite_denied':'group_admin_required'}};
  state.writes.push(v.action);assert.ok(!state.steps.includes(v.action),'a confirmed write was duplicated');
  if(v.action==='create')state.created=true;state.steps.push(v.action);
  if(options.lost===v.action&&!state.lost){state.lost=true;throw new HubError('upstream_unavailable');}
  if(options.pause&&v.action==='create')await options.pause();
  return observe();
 }})};
 const grant={read:false,send:false,profiles:false,conversations:[],groups:{ensure:true,read:true,clientKeys:'*'}};
 const config={version:1,cache:{defaultRead:'refresh'},store:root+'/journal.sqlite',plugins:{telegram:'/fake'},connections:{tg:{plugin:'telegram',label:'test',settings:{}}},groupProvisioning:{enabled:options.enabled!==false,connections:{tg:{enabled:true,policyId:'owner-forums-v1',ownerId:(options.ownerId??'100000001'),botUsername:'example_forum_bot',clientKeys:'*'}}},scopes:{owner:{token:'a'.repeat(40),connections:{tg:grant}},reader:{token:'b'.repeat(40),connections:{tg:{...grant,groups:{read:true,ensure:false,clientKeys:[input.clientKey]}}}},denied:{token:'c'.repeat(40),connections:{tg:{...grant,groups:undefined}}}}};
 let hub=new Hub(config,{telegram:plugin},new Store(config.store));
 t.after(()=>hub.close());
 return {state,config,plugin,get hub(){return hub;},restart:async()=>{await hub.close();hub=new Hub(config,{telegram:plugin},new Store(config.store));}};
}

test('forum creation is independently scoped, audited, durable and idempotent by client, not title',async t=>{
 // Message read/send are both denied while the narrow provisioning grant succeeds.
 const f=fixture(t);const ready=await f.hub.call('owner','group_ensure',input);assert.equal(ready.status,'ready');assert.equal(ready.chatId,'-100321');assert.equal(JSON.stringify(ready).includes('WZ-Hub:'),false);
 assert.equal((await f.hub.call('owner','group_ensure',input)).chatId,ready.chatId);
 assert.equal((await f.hub.call('owner','group_ensure',{...input,requestId:'new-request',title:'WorkZone · Переименованный'})).chatId,ready.chatId);assert.equal(f.state.writes.length,5);
 assert.equal((await f.hub.call('reader','group_result',{connectionId:'tg',clientKey:input.clientKey})).status,'ready');
 await assert.rejects(f.hub.call('owner','send',{connectionId:'tg',conversationId:'-100321',text:'hello',requestId:'not-authorized'}),/not_authorized/);
 assert.ok(f.hub.store.db.prepare('SELECT COUNT(*) n FROM hub_group_audit').get().n>5);
 await assert.rejects(f.hub.call('owner','group_ensure',{...input,title:'different'}),/group_policy_violation/);
 await assert.rejects(f.hub.call('owner','group_ensure',{...input,title:'WorkZone · Изменённый'}),/idempotency_conflict/);
});

test('concurrent scopes and processes cannot create a duplicate client group',async t=>{
 // A second Hub instance shares the SQLite journal and observes a live owner.
 let release;const gate=new Promise(r=>release=r);const f=fixture(t,{pause:()=>gate});
 const first=f.hub.call('owner','group_ensure',input);
 while(!f.state.created)await new Promise(r=>setTimeout(r,1));
 const other=new Hub(f.config,{telegram:f.plugin},new Store(f.config.store));
 const running=await other.call('owner','group_ensure',{...input,requestId:'concurrent'});assert.equal(running.status,'in_progress');
 const same=f.hub.call('owner','group_ensure',{...input,requestId:'same-process'});release();
 assert.equal((await first).status,'ready');assert.equal((await same).status,'ready');assert.equal(f.state.writes.filter(x=>x==='create').length,1);await other.close();
});

test('lost create response reconciles without another create, including after restart',async t=>{
 // The provider created the group before throwing; a restarted Hub reads proof first.
 const f=fixture(t,{lost:'create'});assert.equal((await f.hub.call('owner','group_ensure',input)).status,'unknown');await f.restart();
 const result=await f.hub.call('owner','group_ensure',input);assert.equal(result.status,'ready');assert.equal(f.state.writes.filter(x=>x==='create').length,1);
});

test('unresolved creation stays unknown under new request IDs and after restart',async t=>{
 // No candidate/marker proof is available; no title-search fallback can authorize a second group.
 const f=fixture(t,{lost:'create',unreconciled:true});await f.hub.call('owner','group_ensure',input);await f.restart();
 assert.equal((await f.hub.call('owner','group_ensure',{...input,requestId:'fresh-but-same-client'})).status,'unknown');assert.deepEqual(f.state.writes,['create']);
});

test('restart between stages observes a completed invite before resuming promotion',async t=>{
 // The bot invitation committed, but its response was lost. The next write is promotion.
 const f=fixture(t,{lost:'add_bot'});await f.hub.call('owner','group_ensure',input);await f.restart();
 assert.equal((await f.hub.call('owner','group_ensure',input)).status,'ready');assert.equal(f.state.writes.filter(x=>x==='add_bot').length,1);assert.equal(f.state.writes.length,5);
});

test('bot invitation and admin refusal retain the already-created group with a safe reason',async t=>{
 for(const deny of ['add_bot','promote_bot']){const f=fixture(t,{deny});const r=await f.hub.call('owner','group_ensure',input);assert.equal(r.status,'partial');assert.equal(r.chatId,'-100321');assert.ok(r.diagnostic.code);assert.equal(f.state.writes.filter(x=>x==='create').length,1);}
});

test('default-off capability, wrong self, unauthorized scope/key and bot fail before any write',async t=>{
 const off=fixture(t,{enabled:false});await assert.rejects(off.hub.call('owner','group_ensure',input),/disabled/);createMcp(off.hub,'owner');assert.ok(!off.hub.schemaInfo.get('owner').tools.some(x=>x.name==='messenger_group_ensure'));
 const wrong=fixture(t,{wrongSelf:true});assert.equal((await wrong.hub.call('owner','group_ensure',input)).diagnostic.code,'group_owner_mismatch');assert.equal(wrong.state.writes.length,0);
 const f=fixture(t);for(const method of ['group_ensure','group_result'])await assert.rejects(f.hub.call('denied',method,method==='group_ensure'?input:{connectionId:'tg',clientKey:input.clientKey}),/not_authorized/);
 await assert.rejects(f.hub.call('reader','group_result',{connectionId:'tg',clientKey:'other'}),/not_authorized/);await assert.rejects(f.hub.call('owner','group_ensure',{...input,botUsername:'other_bot'}),/policy/);assert.equal(f.state.writes.length,0);
});

test('a dead process lock is recoverable, a live process lock is never stolen on time',async t=>{
 // Simulate durable intent left by a killed worker before it contacted the bridge.
 const f=fixture(t);await f.hub.call('owner','group_ensure',input);
 const identity=key('tg',input.clientKey);f.hub.store.db.prepare('UPDATE hub_groups SET lock_owner=? WHERE identity=?').run('999999999:123',identity);
 assert.equal((await f.hub.call('owner','group_ensure',input)).status,'ready');assert.equal(f.state.writes.filter(x=>x==='create').length,1);
});

test('two client keys with the same title create separate groups, without title reuse',async t=>{
 // Each bridge key gets independent evidence; a title collision is intentionally harmless.
 const f=fixture(t);const records=new Map();let creates=0;
 f.hub.instances.get('tg').groupStep=async v=>{let r=records.get(v.bridgeKey);if(!r){r={steps:[],id:null};records.set(v.bridgeKey,r);}if(v.action!=='inspect'){if(v.action==='create'){r.id='-100'+(++creates);r.steps.push('create');}else r.steps.push(v.action);}
 return {status:'ok',conversationId:r.id,botId:'777',completedStages:r.steps,verification:{ready:r.steps.length===5,private:true,forum:true,ownerIsCreator:true,participantsComplete:true,participantsExact:true,participantIds:['100000001','777'],botIsAdmin:true,botRightsExact:true,botRights:['manage_topics'],general:{id:'1',exists:true,hidden:false,closed:false},checkedAt:new Date().toISOString()}};};
 const a=await f.hub.call('owner','group_ensure',input),b=await f.hub.call('owner','group_ensure',{...input,clientKey:'workzone:client-2',requestId:'client-two'});assert.equal(a.status,'ready');assert.equal(b.status,'ready');assert.notEqual(a.chatId,b.chatId);assert.equal(creates,2);
});

test('a provider ready flag with extra users or admin powers cannot pass verification',async t=>{
 // The Hub checks evidence independently rather than trusting a single provider boolean.
 const f=fixture(t);const original=f.hub.instances.get('tg').groupStep;
 f.hub.instances.get('tg').groupStep=async v=>{const r=await original(v);if(r.verification?.ready)r.verification.botRights.push('invite_users');return r;};
 const r=await f.hub.call('owner','group_ensure',input);assert.equal(r.status,'unknown');assert.equal(r.diagnostic.code,'group_verification_invalid');assert.equal(f.state.writes.filter(x=>x==='create').length,1);
});


test('an inaccessible process identity never authorizes taking over an external write',async()=>{
 // A permissions error cannot prove death; missing PID and reused PID can.
 const {processAlive}=await import('../src/groups.mjs');
 const error=code=>()=>{throw Object.assign(new Error('synthetic'),{code});};
 assert.equal(processAlive('123:456',error('EACCES')),true);
 assert.equal(processAlive('123:456',error('ENOENT')),false);
 assert.equal(processAlive('123:456',()=> '123:789'),false);
 assert.equal(processAlive('corrupt',()=> null),true);
});


test('reconciliation keeps a known group ID even when verification is blocked',async t=>{
 // The create reply was lost. The bridge later knows the ID, but external
 // membership changed, so the Hub must expose partial instead of losing the group.
 const f=fixture(t,{lost:'create'});await f.hub.call('owner','group_ensure',input);
 f.hub.instances.get('tg').groupStep=async()=>({status:'blocked',stage:'verify',conversationId:'-100321',botId:'777',diagnostic:{code:'group_privacy_forum_or_membership_mismatch'}});
 const r=await f.hub.call('owner','group_ensure',input);assert.equal(r.status,'partial');assert.equal(r.chatId,'-100321');assert.equal(f.state.writes.filter(x=>x==='create').length,1);
});


test('another installation uses its own owner while caller policy substitution stays denied',async t=>{
 // The same engine must work for another configured owner without accepting
 // a caller-selected bot or weakening independent provider identity evidence.
 const f=fixture(t,{ownerId:'100000099'});
 assert.equal((await f.hub.call('owner','group_ensure',input)).status,'ready');
 assert.deepEqual(f.hub.groups.get(key('tg',input.clientKey)).ownerId,'100000099');
 await assert.rejects(f.hub.call('owner','group_ensure',{...input,requestId:'bad-bot',botUsername:'unapproved_bot'}),/policy/);
});
