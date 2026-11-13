import {z} from 'zod';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {HubError} from './contracts.mjs';
/** Subscription transcription only. No generic OpenAI endpoint/model/subtitle
 * parameters or redirects. Endpoint is operator configuration, never tool input. Purpose settings and private key remain outside DTOs. */
export const codexlbConfig=z.object({keyFile:z.string(),url:z.string().url().refine(v=>{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash;},'private HTTPS ASR endpoint required'),timeoutMs:z.number().int().min(1).max(120000).default(120000),prompt:z.string().max(10000).optional()}).strict();
export class CodexLBASR {
 constructor(config,maxAudioBytes,request=fetch){this.config=codexlbConfig.parse(config);this.maxAudioBytes=maxAudioBytes;this.request=request;}
 async transcribeResult(filename,mimeType='audio/mpeg'){
  const c=this.config;if((await stat(c.keyFile)).mode&0o077)throw new HubError('asr_key_permissions');
  const size=(await stat(filename)).size;if(size<1||size>this.maxAudioBytes)throw new HubError('audio_size_limit');
  const token=(await readFile(c.keyFile,'utf8')).trim();if(!token)throw new HubError('codexlb_key_empty');const bytes=await readFile(filename);
  // Rebuild multipart after each transient failure. Abort covers headers AND body
  // consumption, including DNS/TLS stalls. Never leak fetch causes or response bodies.
  for(let attempt=0;attempt<2;attempt++){
   const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),c.timeoutMs);
   try{
    const form=new FormData();form.append('file',new Blob([bytes],{type:mimeType}),path.basename(filename));if(c.prompt)form.append('prompt',c.prompt);
    const r=await this.request(c.url,{method:'POST',redirect:'error',signal:controller.signal,headers:{Authorization:`Bearer ${token}`,'User-Agent':'codex_cli_rs/0.155.0 (Linux; x86_64)'},body:form});
    if(!r.ok){await r.body?.cancel().catch(()=>{});if(attempt===0&&[502,503,504].includes(r.status))continue;throw new HubError('codexlb_http_'+r.status);}
    // Bound response bytes without silently truncating long transcripts.
    const reader=r.body.getReader();let chunks=[],size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4000000)throw new HubError('asr_response_too_large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HubError('asr_invalid_response');}
    // A valid empty string is a completed recognition with no transcript. It does
    // not prove acoustic silence or absence of speech; malformed envelopes fail closed.
    if(!data||Array.isArray(data)||typeof data.text!=='string')throw new HubError('asr_invalid_response');
    if(!data.text.trim())return {text:null,outcome:'no_transcript',evidence:'provider_empty_text',speechPresence:'unknown',speakerAttribution:'unavailable'};
    return {text:data.text.trim(),speakerAttribution:'unavailable'};
   }catch(e){if(e instanceof HubError)throw e;const code=e.cause?.code??e.code;const transient=controller.signal.aborted||['ECONNRESET','EAI_AGAIN','EPIPE','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(code);if(attempt===0&&transient)continue;throw new HubError(controller.signal.aborted?'codexlb_timeout':'codexlb_unavailable');}
   finally{clearTimeout(deadline);}
  }
 }
 async transcribe(filename,mimeType){const result=await this.transcribeResult(filename,mimeType);if(result.outcome==='no_transcript')throw new HubError('asr_no_transcript');return result.text;}
}
