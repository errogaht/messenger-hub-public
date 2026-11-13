import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Upstream} from '../src/upstream.mjs';

async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'hub-upstream-')),ledger=path.join(root,'calls.jsonl');
 const upstream=new Upstream({command:process.execPath,args:[fileURLToPath(new URL('./fixtures/upstream-bridge.mjs',import.meta.url)),ledger]});
 t.after(async()=>{await upstream.close();await rm(root,{recursive:true,force:true});});
 // appendFile can expose the new file before its JSON row is complete. Only
 // newline-terminated rows are committed fixture events; malformed complete
 // rows still fail rather than being hidden by a blanket parse retry.
 const calls=async()=>{const raw=await readFile(ledger,'utf8');return raw.slice(0,raw.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(line=>JSON.parse(line));};
 // The ledger is a test-only started-call barrier, not polling a provider. Keep
 // the write held until the test explicitly releases it through the same client.
 const waitForCall=async name=>{const deadline=Date.now()+2000;while(Date.now()<deadline){try{if((await calls()).some(row=>row.name===name))return;}catch(e){if(e.code!=='ENOENT')throw e;}await delay(5);}assert.fail('synthetic call did not start');};
 return {upstream,calls,waitForCall};
}

test('closed upstream reconnects on the next call and a late old close cannot invalidate it',async t=>{
 // Use the real SDK lifecycle over fake local stdio, so the close callback and
 // pending identity are exercised without a provider, HTTP service or account.
 const {upstream}=await fixture(t),first=await upstream.client();
 const oldResult=await upstream.call('identity');await first.close();assert.equal(upstream.pending,null);
 const freshResult=await upstream.call('identity'),fresh=await upstream.client(),pending=upstream.pending;
 assert.notEqual(fresh,first);assert.notEqual(freshResult.pid,oldResult.pid);
 first.onclose();assert.equal(upstream.pending,pending);assert.equal(await upstream.client(),fresh);
});

test('failed reads and writes are never automatically resubmitted after transport loss',async t=>{
 // Each lost request appears once in the external fake ledger. Only a later
 // independent operation reconnects; it does not resubmit the uncertain effect.
 const {upstream,calls}=await fixture(t);
 for(const name of ['read_and_disconnect','write_and_disconnect']){
  await assert.rejects(upstream.call(name),e=>e.code==='upstream_unavailable');assert.equal(upstream.pending,null);
  assert.equal((await calls()).filter(row=>row.name===name).length,1);
  await upstream.call('identity');assert.equal((await calls()).filter(row=>row.name===name).length,1);
 }
});

test('a generic transport error does not retire an active client or interrupt its concurrent write',async t=>{
 // onerror is diagnostic, not proof of close. Reconnecting on every error could
 // strand an in-flight write and create duplicate effects in a newer transport.
 const {upstream,calls,waitForCall}=await fixture(t),client=await upstream.client(),pending=upstream.pending;
 const write=upstream.call('held_write');await waitForCall('held_write');client.transport.onerror(new Error('synthetic diagnostic only'));
 assert.equal(upstream.pending,pending);assert.equal(await upstream.client(),client);
 await upstream.call('release_write');assert.equal((await write).name,'held_write');assert.equal((await calls()).filter(row=>row.name==='held_write').length,1);
});

test('only exact quote RPC rejection carries no-create evidence; generic errors stay ambiguous',async()=>{
 // Fake MCP results cover both bridge error shapes; private bodies never escape.
 for(const shape of ['isError','text'])for(const known of [true,false]){
  const upstream=new Upstream({});const text=known?'Error: REPLY_MESSAGE_ID_INVALID':'Error: connection interrupted';
  upstream.pending=Promise.resolve({callTool:async()=>({...(shape==='isError'?{isError:true}:{}),content:[{type:'text',text}]})});
  await assert.rejects(upstream.call('reply_to_message'),e=>e.code===(known?'reply_target_invalid':'upstream_rejected')&&(!known||e.details.messageCreated===false));
 }
});

test('Telegram native read rejections separate format/not-found/access/provider without altering sends',async()=>{
 // Both bridge error encodings must preserve categories without exposing the
 // private RPC body. Identical write errors keep the previous unknown contract.
 for(const shape of ['isError','text','structured'])for(const [native,code] of [['CHANNEL_PRIVATE','conversation_access_denied'],['USERNAME_INVALID','conversation_format_invalid'],['USERNAME_NOT_OCCUPIED','conversation_not_found'],['connection interrupted','telegram_read_provider_failed']]){
  const upstream=new Upstream({});upstream.pending=Promise.resolve({callTool:async()=>({...(shape==='isError'?{isError:true}:{}),...(shape==='structured'?{structuredContent:{result:'Error: '+native+' private-placeholder'}}:{}),content:[{type:'text',text:'Error: '+native+' private-placeholder'}]})});
  await assert.rejects(upstream.call('get_messages'),e=>e.code===code&&!JSON.stringify(e.details).includes('private-placeholder'));
  await assert.rejects(upstream.call('send_message'),{code:'upstream_rejected'});
 }
});

test('transport timeout keeps safe operation evidence without replaying a write or exposing exception text',async()=>{
 // SDK -32001 is the same 60s request-timeout family observed in production.
 // A synthetic short timeout tests classification, not a slow wall-clock sleep.
 for(const name of ['hub_native_history','send_message']){
  let calls=0;const upstream=new Upstream({url:'http://127.0.0.1:1/mcp'});
  upstream.pending=Promise.resolve({callTool:async()=>{calls++;throw Object.assign(new Error('private-placeholder'),{code:-32001});}});
  await assert.rejects(upstream.call(name,{}, {timeoutMs:123}),e=>e.code==='upstream_timeout'&&e.details.providerOperation===name&&e.details.timeoutMs===123&&!JSON.stringify(e.details).includes('private-placeholder'));
  assert.equal(calls,1);
 }
});

test('Telegram coded error prose is a rejection in both MCP encodings and never a successful body',async()=>{
 // The bridge deliberately hides RPC details behind this exact public frame.
 // It must not become health self="undefined" or an invalid peer/history page.
 for(const structured of [true,false])for(const name of ['get_me','get_messages','send_message']){
  let calls=0;const upstream=new Upstream({});
  const text='An error occurred (code: GEN-ERR-123). Check mcp_errors.log for details.';
  upstream.pending=Promise.resolve({callTool:async()=>{calls++;return {...(structured?{structuredContent:{result:text}}:{}),content:[{type:'text',text}]};}});
  await assert.rejects(upstream.call(name),e=>e.code===(name==='get_messages'?'telegram_read_provider_failed':'upstream_rejected')&&e.details.providerErrorCode==='GEN-ERR-123'&&e.details.providerOperation===name&&e.details.messageCreated===undefined);
  assert.equal(calls,1,'An error frame never authorizes replaying a read or uncertain write.');
 }
 // Matching prose inside an actual history message is untrusted body data.
 const upstream=new Upstream({}),body='ID: 1 | Owner [id=4] | Date: 2026-11-09T00:00:00Z | Message: An error occurred (code: GEN-ERR-123). Check mcp_errors.log for details.';
 upstream.pending=Promise.resolve({callTool:async()=>({content:[{type:'text',text:body}]})});
 assert.equal(await upstream.call('get_messages'),body);
});
