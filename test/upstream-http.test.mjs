import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';
import {Upstream} from '../src/upstream.mjs';

async function fixture(t,connections){
 // This RPC-only loopback peer holds bursts long enough to reproduce the
 // old unbounded socket fan-out. It has no provider/session/config access.
 let peak=0,writes=0;const sockets=new Set();
 const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405);res.end();return;}
  const chunks=[];for await(const c of req)chunks.push(c);const m=JSON.parse(Buffer.concat(chunks));
  if(!Object.hasOwn(m,'id')){res.writeHead(202);res.end();return;}
  let result;
  if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'isolated-http-pool',version:'1'}};
  else if(m.method==='tools/call'){
   if(m.params.name==='write_and_disconnect'){writes++;res.destroy();return;}
   await delay(10);result={content:[{type:'text',text:'{"ok":true}'}]};
  }else result={};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
 });
 server.on('connection',s=>{sockets.add(s);peak=Math.max(peak,sockets.size);s.once('close',()=>sockets.delete(s));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const upstream=new Upstream({url:`http://127.0.0.1:${server.address().port}/mcp`,httpConnections:connections});
 t.after(async()=>{await upstream.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 return {upstream,sockets,peak:()=>peak,writes:()=>writes};
}

test('a burst larger than the exhausted provider limit stays bounded and closes all owned sockets',async t=>{
 // More than1024 logical calls must use a bounded number of TCP descriptors.
 // Queueing must preserve every result, and explicit close must release them.
 const f=await fixture(t,8);
 const rows=await Promise.all(Array.from({length:1100},()=>f.upstream.call('identity')));
 assert.equal(rows.length,1100);assert.ok(rows.every(x=>x.ok));assert.ok(f.peak()<=8,`peak=${f.peak()}`);
 await f.upstream.close();for(let n=0;n<100&&f.sockets.size;n++)await delay(5);
 assert.equal(f.sockets.size,0);
});

test('bounded HTTP transport never replays an uncertain provider write',async t=>{
 // A provider drop after observing the write must remain exactly one attempt,
 // even though the new pool supports reuse and later independent reads.
 const f=await fixture(t,4);
 await assert.rejects(f.upstream.call('write_and_disconnect'),{code:'upstream_unavailable'});
 assert.equal(f.writes(),1);assert.deepEqual(await f.upstream.call('identity'),{ok:true});assert.equal(f.writes(),1);
});
