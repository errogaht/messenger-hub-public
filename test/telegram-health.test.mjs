import {test} from 'node:test';
import assert from 'node:assert/strict';
import telegram from '../src/plugins/telegram.mjs';
import {HubError} from '../src/contracts.mjs';

const fixture=value=>telegram.create({selfId:'4',upstreamClient:{call:async()=>value,close:async()=>{}}});

test('Telegram health rejects malformed account identity instead of reporting available undefined',async()=>{
 // A provider error returned as text is not a live authenticated account. The
 // guard also rejects future malformed envelopes without leaking their body.
 for(const value of ['private-placeholder',null,{},[],{id:0},{id:'undefined'},{result:{id:4}}]){
  await assert.rejects(fixture(value).health(),e=>e.code==='telegram_identity_shape'&&!JSON.stringify(e.details).includes('private-placeholder'));
 }
});

test('account failures advertise owner recovery without launching login or replaying operations',async()=>{
 // A failed read should point at the installed owner UI, preserving the real
 // transport cause; it must never claim that credentials have expired.
 for(const method of ['health','identity']){
  let calls=0;
  const adapter=telegram.create({selfId:'4',upstreamClient:{call:async()=>{calls++;throw new HubError('upstream_unavailable',{phase:'request'});},close:async()=>{}}});
  await assert.rejects(adapter[method](),e=>e.code==='upstream_unavailable'&&e.details.phase==='request'&&e.details.ownerRecovery.command==='messenger-telegram-login'&&e.details.ownerRecovery.requiresOwner===true);
  assert.equal(calls,1);
 }
});

test('Telegram health reports only a validated numeric identity and actual configured match',async()=>{
 // A different valid self is surfaced as a mismatch, never silently substituted.
 for(const id of [4,'4'])assert.equal((await fixture({id}).health()).configuredSelfMatches,true);
 const result=await fixture({id:5}).health();assert.equal(result.self.id,'5');assert.equal(result.configuredSelfMatches,false);
});
