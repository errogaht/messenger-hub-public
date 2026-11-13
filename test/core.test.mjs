import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hub} from '../src/hub.mjs';
import {Store} from '../src/store.mjs';
import {createHttp} from '../src/server.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function fixture(send=async()=>({status:'sent',messageId:'9'})){
 let calls=0;
 const plugin={create:()=>({capabilities:{history:true,send:true,attachments:false,changes:false,kinds:['message']},conversations:async()=>({items:['one','two'].map(id=>({id,title:id,kind:'group',canSend:true})),next:null}),history:async({conversationId})=>{calls++;return {items:[{id:'1',conversationId,direction:'inbound',senderId:'person',at:'2026-09-27T00:00:00Z',text:'private'}],next:null,complete:true};},send})};
 const config={version:1,cache:{defaultRead:'refresh'},store:':memory:',plugins:{fake:'/fake'},connections:{a:{plugin:'fake',label:'Portal A',settings:{}},b:{plugin:'fake',label:'Portal B',settings:{}}},scopes:{project:{token:'a'.repeat(40),connections:{a:{read:true,send:true,conversations:['one'],profiles:false}}},reader:{token:'b'.repeat(40),connections:{a:{read:true,send:false,conversations:'*',profiles:false}}}}};
 const store=new Store(':memory:');const hub=new Hub(config,{fake:plugin},store);return {hub,store,calls:()=>calls};
}
const payload={connectionId:'a',conversationId:'one',requestId:'request-123',text:'hello',replyTo:null};

test('project cannot enumerate or read another portal, even with colliding chat IDs',async()=>{
 // Both portals use identical provider IDs; authorization must happen before upstream reads.
 const {hub,calls}=fixture();
 assert.deepEqual((await hub.call('project','connections')).items.map(x=>x.id),['a']);
 await assert.rejects(hub.call('project','history',{connectionId:'b',conversationId:'one'}),/not_authorized/);
 await assert.rejects(hub.call('project','history',{connectionId:'a',conversationId:'two'}),/not_authorized/);
 assert.equal(calls(),0);
 assert.deepEqual((await hub.call('project','conversations',{connectionId:'a'})).items.map(x=>x.id),['one']);await hub.close();
});
test('history replays and edits emit bounded ID-only events with independent cursors',async()=>{
 const {hub,store}=fixture();
 await hub.call('project','history',{connectionId:'a',conversationId:'one'});
 await hub.call('project','history',{connectionId:'a',conversationId:'one'});
 store.observe('b',[{id:'1',conversationId:'one',text:'other portal'}]);
 const first=await hub.call('project','events',{});assert.equal(first.items.length,1);assert.ok(!JSON.stringify(first).includes('private'));
 assert.deepEqual(await hub.call('project','events',{}),first);
 assert.equal((await hub.call('project','events',{after:first.next})).items.length,0);await hub.close();
});
test('send is once per exact request; payload collision and read-only grants fail',async()=>{
 let sends=0;const {hub}=fixture(async()=>{sends++;return {status:'sent',messageId:'9'};});
 await assert.rejects(hub.call('reader','send',payload),/not_authorized/);
 const results=await Promise.all([hub.call('project','send',payload),hub.call('project','send',payload)]);
 assert.equal(sends,1);assert.equal(results[0].status,'sent');
 assert.equal((await hub.call('project','send',payload)).messageId,'9');
 await assert.rejects(hub.call('project','send',{...payload,text:'different'}),/idempotency_conflict/);await hub.close();
});
test('ambiguous provider failure remains unknown and is never retried',async()=>{
 let sends=0;const {hub}=fixture(async()=>{sends++;throw new Error('lost response');});
 assert.equal((await hub.call('project','send',payload)).status,'unknown');
 assert.equal((await hub.call('project','send',payload)).status,'unknown');assert.equal(sends,1);await hub.close();
});
test('HTTP MCP requires a scoped bearer and rejects browser origins; reader has no send tool',async()=>{
 const {hub}=fixture();const server=createHttp(hub);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}/mcp`;
 try{
 assert.equal((await fetch(url,{method:'POST'})).status,401);
 assert.equal((await fetch(url,{method:'POST',headers:{Origin:'https://evil.example',Authorization:'Bearer '+'b'.repeat(40)}})).status,403);
 const client=new Client({name:'test',version:'1'});
 await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:'Bearer '+'b'.repeat(40)}}}));
 const tools=await client.listTools();
 const schema=(await client.callTool({name:'messenger_schema',arguments:{}})).structuredContent;
 // This compares the real published schema, not just the in-memory Zod definition.
 assert.deepEqual(schema.tools,tools.tools.map(({name,inputSchema,description})=>({name,inputSchema,description})));
 assert.ok(!tools.tools.some(x=>x.name==='messenger_send'));
 const r=await client.callTool({name:'messenger_connections',arguments:{}});assert.equal(r.structuredContent.items[0].id,'a');await client.close();
 }finally{await new Promise(r=>server.close(r));await hub.close();}
});

test('incomplete external plugins fail before a connection is advertised',()=>{
 const {hub,store}=fixture();const config=hub.config;
 assert.throws(()=>new Hub(config,{fake:{create:()=>({capabilities:{history:true,send:true,attachments:false,changes:false,kinds:['message']}})}},store),/plugin_contract_incomplete/);
 store.close();
});

test('proven portal refusal is failed; the same key never repeats a write',async()=>{
 // No real portal: a pre-write permission failure can be distinguished from a lost response.
 const {HubError}=await import('../src/contracts.mjs');let sends=0;
 const {hub}=fixture(async()=>{sends++;throw new HubError('chat_access_denied',{messageCreated:false});});
 const first=await hub.call('project','send',payload);assert.equal(first.status,'failed');assert.equal(first.diagnostic.messageCreated,false);
 const again=await hub.call('project','send',payload);assert.equal(again.status,'failed');assert.equal(again.diagnostic.code,'chat_access_denied');assert.equal(sends,1);await hub.close();
});

test('missing raw quote sends once without quote and reconciles the persisted effective route',async()=>{
 // Effective quote differs from caller payload; repeat/reconcile must not hash
 // the changed payload or accidentally look for a quoted copy of an unquoted send.
 let sends=0;const {hub,store}=fixture(async v=>{sends++;assert.equal(v.replyTo,null);return {status:'unknown',messageId:null};});
 const v={...payload,replyTo:'old'};hub.instances.get('a').reconcile=async actual=>{assert.equal(actual.replyTo,null);return {status:'sent',messageId:'10'};};
 try{const r=await hub.call('project','send',v);assert.equal(r.status,'unknown');assert.equal(r.replyFallback.reason,'reply_target_unavailable');const done=await hub.call('project','delivery',v);assert.equal(done.status,'sent');assert.equal(done.messageId,'10');await hub.call('project','send',v);assert.equal(sends,1);assert.ok(store.evidence(JSON.stringify(['project','a',v.requestId])).replyFallback);}finally{await hub.close();}
});

test('cached older reply survives bounded history and wrong-route/deleted evidence stays distinct',async()=>{
 // Quoting a cached source needs no extra provider lookup. Deleted evidence
 // omits only the quote; a grant refusal still prevents any write.
 const seen=[];const {hub,calls}=fixture(async v=>{seen.push(v);return {status:'sent',messageId:'11'};});
 try{hub.cache.observe('a',{id:'old',conversationId:'one',direction:'inbound',senderId:'p',at:'2026-01-01T00:00:00Z',text:'edited source',attachments:[]});
 await hub.call('project','send',{...payload,replyTo:'old'});assert.equal(seen[0].replyTo,'old');assert.equal(calls(),0);
 await assert.rejects(hub.call('project','send',{...payload,requestId:'forbidden',conversationId:'two',replyTo:'old'}),/not_authorized/);assert.equal(seen.length,1);
 }finally{await hub.close();}
});

test('legacy local quote guard unknown becomes not_created without replaying a send',async()=>{
 // Historical reply_not_in_context was thrown before I/O in pinned TG/WA
 // adapters. Fix its receipt only; arbitrary ambiguous writes remain unknown.
 const {hub,store}=fixture();hub.config.connections.a.plugin='telegram';
 try{const identity=store.beginSend('project',payload);store.saveEvidence(identity,{diagnostic:{code:'reply_not_in_context'}});
 const r=await hub.call('project','delivery',payload);assert.equal(r.status,'failed');assert.equal(r.confirmation,'not_created');
 }finally{await hub.close();}
});
