import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {CodexLBASR,codexlbConfig} from '../src/codexlb-asr.mjs';
async function setup(t,request,timeoutMs=120000){const root=await mkdtemp(path.join(tmpdir(),'asr-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const keyFile=path.join(root,'key'),audio=path.join(root,'voice.ogg');await writeFile(keyFile,'synthetic-key',{mode:0o600});await writeFile(audio,'synthetic-audio');return {asr:new CodexLBASR({keyFile,url:'https://asr.example.invalid/backend-api/transcribe',timeoutMs},1000,request),audio};}
test('subscription multipart preserves MIME/filename and only supported fields',async t=>{
 // Fake request inspects the exact contract, never uploads client audio.
 const f=await setup(t,async(url,o)=>{assert.equal(url,'https://asr.example.invalid/backend-api/transcribe');assert.equal(o.redirect,'error');assert.equal(o.headers['User-Agent'],'codex_cli_rs/0.155.0 (Linux; x86_64)');assert.deepEqual([...o.body.keys()],['file']);const file=o.body.get('file');assert.equal(file.name,'voice.ogg');assert.equal(file.type,'audio/ogg');return Response.json({text:' Full text '});});assert.equal((await f.asr.transcribeResult(f.audio,'audio/ogg')).text,'Full text');
});
test('only transient failures retry once with fresh forms; auth/429/invalid never retry',async t=>{
 // Bounded retries cannot turn key rejection or invalid speech into repeated uploads.
 for(const status of [502,503,504,401,403,429,302,200]){let forms=[];const f=await setup(t,async(u,o)=>{forms.push(o.body);return status===200?Response.json({}):new Response('',{status});});await assert.rejects(f.asr.transcribe(f.audio),e=>!e.message.includes('synthetic-key'));assert.equal(forms.length,[502,503,504].includes(status)?2:1);if(forms.length===2)assert.notEqual(forms[0],forms[1]);}
 let calls=0;const f=await setup(t,async()=>{if(++calls===1)throw Object.assign(new Error('secret'),{cause:{code:'ECONNRESET'}});return Response.json({text:'Recovered'});});assert.equal(await f.asr.transcribe(f.audio),'Recovered');assert.equal(calls,2);
});
test('deadline cancels both stalled connection and body, capped at two attempts',async t=>{
 // Body stalls must be bounded too, not just the fetch headers promise.
 for(const body of [false,true]){let calls=0;const f=await setup(t,(u,o)=>{calls++;if(body)return Promise.resolve(new Response(new ReadableStream({start(c){o.signal.addEventListener('abort',()=>c.error(new Error('private')),{once:true});}})));return new Promise((r,j)=>o.signal.addEventListener('abort',()=>j(new Error('private')),{once:true}));},10);await assert.rejects(f.asr.transcribe(f.audio),e=>e.code==='codexlb_timeout');assert.equal(calls,2);}
});

test('valid empty text is terminal no transcript, malformed provider envelopes remain failures',async t=>{
 // An empty recognition says nothing about physical speech presence. Missing/null
 // text, invalid JSON and empty transport bodies cannot become a completed result.
 for(const text of ['', '  \n ']){let calls=0;const f=await setup(t,async()=>{calls++;return Response.json({text,asset_pointer:'private'});});
 assert.deepEqual(await f.asr.transcribeResult(f.audio),{text:null,outcome:'no_transcript',evidence:'provider_empty_text',speechPresence:'unknown',speakerAttribution:'unavailable'});assert.equal(calls,1);}
 for(const body of ['{}','null','[]','{"text":null}','{"text":3}','', '<html>error</html>']){let calls=0;const f=await setup(t,async()=>{calls++;return new Response(body);});await assert.rejects(f.asr.transcribeResult(f.audio),e=>e.code==='asr_invalid_response');assert.equal(calls,1);}
});


test('ASR endpoint is explicit operator configuration and cannot contain URL credentials',()=>{
 // No private service is contacted by default; transport remains HTTPS-only,
 // with redirects disabled in the real upload path above.
 for(const url of [undefined,'http://asr.example.invalid','https://user:password@asr.example.invalid','https://asr.example.invalid/#secret']){
  assert.equal(codexlbConfig.safeParse({keyFile:'/private/key',...(url?{url}:{})}).success,false);
 }
 assert.equal(codexlbConfig.parse({keyFile:'/private/key',url:'https://another-asr.example.invalid/transcribe'}).url,'https://another-asr.example.invalid/transcribe');
});
