import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as flush} from 'node:timers/promises';
import {ReadTools,waitInput} from '../src/read-tools.mjs';

const subscriptions=[{connectionId:'fake',conversationId:'one',afterMessageId:'old'}];
const msg=id=>({id,conversationId:'one',direction:'inbound',text:id,attachments:[]});

/** Drive the actual timer/deadline loop without holding a real ten-minute call. */
async function fixture(t){
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
 const tools=new ReadTools({access:()=>({}),readHistory:async()=>({items:[msg('new'),msg('old')],next:null,complete:true})},':memory:',{pollMs:1000});
 t.after(()=>tools.close());
 const advance=async ms=>{for(let elapsed=0;elapsed<ms;elapsed+=1000){t.mock.timers.tick(1000);await flush();}};
 return {tools,advance};
}

test('settled wait accepts ten minutes for both budgets and preserves old defaults',()=>{
 // Only the explicit maximum changes: existing consumers keep the same cadence.
 assert.equal(waitInput.parse({subscriptions}).maxWaitMs,50000);
 assert.equal(waitInput.parse({subscriptions}).settleMs,6000);
 assert.equal(waitInput.parse({subscriptions,maxWaitMs:600000,settleMs:600000}).maxWaitMs,600000);
 for(const field of ['maxWaitMs','settleMs']){
  assert.equal(waitInput.safeParse({subscriptions,[field]:600001}).success,false);
  assert.equal(waitInput.safeParse({subscriptions,[field]:0}).success,false);
 }
});

test('settled wait returns a burst after silence beyond the old call limit',async t=>{
 // The message exists after our anchor; two minutes of silence must survive the
 // former 30s silence / 50s total caps and return before the ten-minute deadline.
 const {tools,advance}=await fixture(t);let result;
 const pending=tools.wait('scope',{subscriptions,maxWaitMs:600000,settleMs:120000}).then(r=>{result=r;});
 await flush();await advance(60000);assert.equal(result,undefined);
 await advance(60000);await pending;
 assert.equal(result.event,true);assert.deepEqual(result.events[0].items.map(m=>m.id),['new']);
});

test('ten-minute timeout preserves pending burst for cursor continuation and replay',async t=>{
 // Silence starts at the initial observation. A longer silence interval spans
 // calls: timeout must retain that evidence rather than dropping the message.
 const {tools,advance}=await fixture(t);let result;
 const args={subscriptions,maxWaitMs:600000,settleMs:600000};
 const pending=tools.wait('scope',args).then(r=>{result=r;});
 await flush();await advance(599000);assert.equal(result,undefined);
 await advance(1000);await pending;assert.equal(result.reason,'timeout');
 const resumed=await tools.wait('scope',{...args,cursor:result.cursor});
 assert.equal(resumed.event,true);assert.equal(resumed.events[0].items[0].id,'new');
 assert.deepEqual(await tools.wait('scope',{...args,cursor:result.cursor}),resumed);
});
