import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StyleModel} from '../src/llm.mjs';

test('rewrite requests strict structured output while profile remains free form',async t=>{
 // A schema constrains only syntax; its caller still owns validation and send gates.
 const dir=mkdtempSync(join(tmpdir(),'hub-llm-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const keyFile=join(dir,'key');writeFileSync(keyFile,'synthetic',{mode:0o600});const bodies=[];
 const model=new StyleModel({enabled:true,keyFile,baseUrl:'https://example.invalid/v1',timeoutMs:1000,model:'configured',effort:'medium'},async(url,init)=>{
  bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'sample'}]}]}),{headers:{'content-type':'application/json'}});
 });
 const schema={type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false};
 await model.generate('profile',{});await model.generate('rewrite',{}, {jsonSchema:schema});
 assert.equal(bodies[0].text,undefined);assert.deepEqual(bodies[1].text.format,{type:'json_schema',name:'message_rewrite',strict:true,schema});
 assert.equal(bodies[1].model,'configured');assert.equal(bodies[1].store,false);
});

test('unsupported structured output remains a provider failure without a second unconstrained request',async t=>{
 // A compatible gateway refusal must never silently bypass constrained output.
 const dir=mkdtempSync(join(tmpdir(),'hub-llm-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const keyFile=join(dir,'key');writeFileSync(keyFile,'synthetic',{mode:0o600});let calls=0;
 const model=new StyleModel({enabled:true,keyFile,baseUrl:'https://example.invalid',timeoutMs:1000},async()=>{calls++;return new Response('',{status:400});});
 await assert.rejects(model.generate('rewrite',{}, {jsonSchema:{type:'object'}}),e=>e.code==='llm_http_400');assert.equal(calls,1);
});
