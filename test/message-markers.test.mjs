import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {MessageMarkers} from '../src/message-markers.mjs';import {Store} from '../src/store.mjs';import {HubError} from '../src/contracts.mjs';import telegram from '../src/plugins/telegram.mjs';import whatsapp from '../src/plugins/whatsapp.mjs';
const input={connectionId:'tg',conversationId:'1',messageId:'7',status:'viewed',requestId:'request-1'};
function fake(store,instance){return new MessageMarkers({store,access(scope,c,chat,write){if(scope==='denied'||write&&scope==='reader'||c!=='tg'||chat!=='1')throw new HubError('not_authorized');return {instance};}});}
test('durable repeated request, state transitions and conflict never repeat writes',async()=>{
 // One identity per transition; old repeated requests cannot clobber later status.
 const store=new Store(':memory:');let writes=0;const s=fake(store,{markMessage:async(v,{submitting})=>{submitting();writes++;return {state:'applied',confirmation:'provider_accepted'};}});
 await s.mark('owner',input);await s.mark('owner',input);assert.equal(writes,1);await assert.rejects(s.mark('owner',{...input,status:'completed'}),e=>e.code==='idempotency_conflict');
 await s.mark('owner',{...input,status:'completed',requestId:'next'});await s.mark('owner',input);assert.equal(writes,2);await assert.rejects(s.mark('reader',input),e=>e.code==='not_authorized');store.close();
});
test('concurrent conflicting scopes blocked, lost response reconciles after restart without resend',async t=>{
 // A crash after network submission retains unknown; another caller cannot bypass it.
 const root=await mkdtemp(path.join(tmpdir(),'marker-'));t.after(()=>rm(root,{recursive:true,force:true}));const filename=path.join(root,'store');let store=new Store(filename),release;const pending=new Promise(r=>release=r);let writes=0;
 let s=fake(store,{markMessage:async(v,{submitting})=>{submitting();writes++;await pending;throw new HubError('upstream_unavailable');}});const first=s.mark('owner',input);await assert.rejects(s.mark('other',{...input,requestId:'other'}),e=>e.code==='marker_in_flight');release();const lost=await first;assert.equal(lost.state,'unknown');assert.match(lost.diagnostic.nextAction,/Never repeat/);store.close();store=new Store(filename);s=fake(store,{markMessage:()=>assert.fail('resend'),reconcileMarker:async()=>({state:'applied',confirmation:'native_own_reaction_snapshot'})});assert.equal((await s.mark('owner',input)).state,'applied');assert.equal(writes,1);store.close();
});
test('preflight failure is failed, missing readback remains unknown; unsupported permission isolated',async()=>{
 // No successful receipt can be fabricated from a provider error or missing snapshot.
 const store=new Store(':memory:');let s=fake(store,{markMessage:async()=>{throw new HubError('marker_message_not_in_window');}});assert.equal((await s.mark('owner',input)).state,'failed');
 s=fake(store,{markMessage:async(v,{submitting})=>{submitting();throw new HubError('upstream_unavailable');}});assert.equal((await s.mark('owner',{...input,requestId:'next'})).state,'unknown');assert.equal((await s.result('owner',{connectionId:'tg',requestId:'next'})).state,'unknown');await assert.rejects(s.result('denied',{connectionId:'tg',requestId:'next'}),e=>e.code==='marker_request_not_found');store.close();
});
test('platform adapters use native exact account/route/status and WhatsApp replaces one reaction',async()=>{
 // Fake transports assert no chat/session switching, supported GOWA payloads and CAS.
 const calls=[];const tg=telegram.create({account:'session',upstreamClient:{call:async(n,a)=>{calls.push([n,a]);return a.apply?{state:'applied'}:{state:'unknown',reactions:['❤️']};}}});let phase=0;await tg.markMessage({...input,status:'question'},{submitting:()=>phase++});assert.equal(calls[1][1].account,'session');assert.deepEqual(calls[1][1].expected_reactions,['❤️']);assert.equal(calls[1][1].status,'question');assert.equal(phase,1);
 const waCalls=[];const wa=whatsapp.create({deviceId:'device',upstreamClient:{call:async(n,a)=>{waCalls.push([n,a]);return a.action==='get_messages'?{data:[{id:'X',chat_jid:'123@s.whatsapp.net',timestamp:'2026-10-04T00:00:00Z',content:'synthetic',is_from_me:false}]}:{message_id:'reaction-id'};}}});const r=await wa.markMessage({...input,conversationId:'123@s.whatsapp.net',messageId:'X',status:'completed'},{submitting:()=>{}});assert.equal(r.state,'applied');assert.equal(r.confirmation,'provider_accepted');assert.deepEqual(waCalls[1][1],{action:'react',phone:'123@s.whatsapp.net',message_id:'X',emoji:'✅',device_id:'device'});
});
