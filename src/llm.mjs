import {readFile,stat} from 'node:fs/promises';
import {HubError} from './contracts.mjs';

/** Bounded, stateless Responses client. Never log requests, raw errors, profiles or credentials. */
export class StyleModel {
 constructor(config,fetcher=fetch){this.config=config;this.fetcher=fetcher;}
 async generate(instructions,data,options={}){
  const c=this.config;
  if(!c.enabled)throw new HubError('assistant_disabled');
  if((await stat(c.keyFile)).mode&0o077)throw new HubError('llm_key_permissions');
  const token=(await readFile(c.keyFile,'utf8')).trim();
  try{
   const response=await this.fetcher(c.baseUrl.replace(/\/$/,'')+'/responses',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(c.timeoutMs),
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:c.model,reasoning:{effort:c.effort},store:false,stream:false,
     // Only callers with a machine-readable contract request constrained output.
     // Profile generation remains free-form; unsupported gateways fail closed.
     ...(options.jsonSchema?{text:{format:{type:"json_schema",name:"message_rewrite",strict:true,schema:options.jsonSchema}}}:{}),
     instructions,input:[{role:'user',content:JSON.stringify(data)}]})
   });
   if(!response.ok)throw new HubError('llm_http_'+response.status);
   // Some compatible gateways always stream. Only a completed event is accepted, never partial output.
   let result;
   const reader=response.body.getReader();let raw='',size=0;const decoder=new TextDecoder();
   for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>2000000){await reader.cancel();throw new HubError('llm_response_too_large');}raw+=decoder.decode(value,{stream:true});}
   raw+=decoder.decode();
   if(response.headers.get('content-type')?.includes('text/event-stream')){
    for(const block of raw.split(/\r?\n\r?\n/)){const line=block.split(/\r?\n/).find(l=>l.startsWith('data: '));if(!line||line==='data: [DONE]')continue;const event=JSON.parse(line.slice(6));if(event.type==='response.completed')result=event.response;}
   }else result=JSON.parse(raw);
   if(!result||result.status!=='completed')throw new HubError('llm_incomplete');
   const text=(result.output??[]).filter(x=>x.type==='message').flatMap(x=>x.content??[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');
   if(!text.trim()||text.length>100000)throw new HubError('llm_output_invalid');
   return text;
  }catch(e){throw e instanceof HubError?e:new HubError('llm_unavailable');}
 }
}
