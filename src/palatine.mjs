import {z} from 'zod';
import {readFile,stat} from 'node:fs/promises';
import {HubError} from './contracts.mjs';

/** Palatine is an explicit subscription-ASR purpose, with no CodexLB fallback.
 * Endpoint and model belong to settings; requests never retry a lost billable
 * response automatically. Keys stay in owner-only files, outside the contract. */
export const palatineConfig=z.object({keyFile:z.string(),url:z.literal('https://api.palatine.ru/api/v1/audio/transcriptions').default('https://api.palatine.ru/api/v1/audio/transcriptions'),model:z.string().min(1).max(200).default('palatine_large_highspeed'),responseFormat:z.enum(['json','verbose_json']).default('verbose_json'),language:z.string().min(2).max(20).optional(),timeoutMs:z.number().int().min(1000).max(300000).default(180000)}).strict();
export class PalatineASR {
 constructor(config,maxAudioBytes,request=fetch){this.config=palatineConfig.parse(config);this.maxAudioBytes=maxAudioBytes;this.request=request;}
 async transcribeResult(filename,mimeType='audio/mpeg'){
  const c=this.config;if((await stat(c.keyFile)).mode&0o077)throw new HubError('asr_key_permissions');
  const size=(await stat(filename)).size;if(size<1||size>this.maxAudioBytes)throw new HubError('audio_size_limit');
  const token=(await readFile(c.keyFile,'utf8')).trim();if(!token)throw new HubError('palatine_key_empty');
  const form=new FormData();form.append('file',new Blob([await readFile(filename)],{type:mimeType}),'audio.mp3');form.append('model',c.model);form.append('response_format',c.responseFormat);if(c.language)form.append('language',c.language);
  try{const r=await this.request(c.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(c.timeoutMs),headers:{Authorization:`Bearer ${token}`},body:form});
   if(!r.ok){
    // Only classify a documented, narrowly recognised billing failure. Never
    // expose provider response bodies, request IDs, tokens or client speech.
    let balance=false;
    if(r.status===400&&r.body){const reader=r.body.getReader();let body='',bytes=0;try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>4096)break;body+=new TextDecoder().decode(value);}if(bytes<=4096){try{balance=/^Not enough balance(?:\.|$)/.test(JSON.parse(body).detail??'');}catch{}}}finally{await reader.cancel().catch(()=>{});}}
    throw new HubError(balance?'palatine_balance_insufficient':'palatine_http_'+r.status);
   }const raw=await r.text();if(raw.length>1000000)throw new HubError('asr_response_too_large');const data=JSON.parse(raw);if(typeof data.text!=='string'||!data.text.trim())throw new HubError('asr_empty_response');const segments=Array.isArray(data.segments)?data.segments.map(s=>({speaker:String(s.speaker??s.speaker_id??'unknown').slice(0,200),speakerUncertain:true,start:Number(s.start),end:Number(s.end),text:String(s.text??'')})):undefined;
   if(segments?.some(s=>!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<s.start))throw new HubError('asr_segments_invalid');
   return {text:data.text.trim(),...(segments?{segments}:{}),speakerAttribution:segments?.some(s=>s.speaker!=='unknown')?'provider_unverified':'unavailable'};
  }catch(e){throw e instanceof HubError?e:new HubError('palatine_unavailable');}
 }
 /** String compatibility for direct callers; the Hub stores the full result. */
 async transcribe(filename,mimeType='audio/mpeg'){return (await this.transcribeResult(filename,mimeType)).text;}
}
