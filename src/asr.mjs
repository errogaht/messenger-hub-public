import {readFile,stat} from 'node:fs/promises';
import {HubError} from './contracts.mjs';

/** Subscription ASR, matching Voice Input. No chat-model field or paid-model endpoint fallback. */
export class SubscriptionASR {
 constructor(config,request=fetch){this.config=config;this.request=request;}
 async transcribe(filename,mimeType='audio/mpeg'){
  const c=this.config;if((await stat(c.keyFile)).mode&0o077)throw new HubError('asr_key_permissions');
  const size=(await stat(filename)).size;if(size<1||size>c.maxAudioBytes)throw new HubError('audio_size_limit');
  const token=(await readFile(c.keyFile,'utf8')).trim(),bytes=await readFile(filename);
  const form=new FormData();form.append('file',new Blob([bytes],{type:mimeType}),filename.split('/').at(-1));
  try{
   const r=await this.request(c.asrUrl,{method:'POST',redirect:'error',signal:AbortSignal.timeout(c.asrTimeoutMs),headers:{Authorization:`Bearer ${token}`,'User-Agent':'codex_cli_rs/0.155.0 (Linux; x86_64)'},body:form});
   if(!r.ok)throw new HubError('asr_http_'+r.status);
   const raw=await r.text();if(raw.length>1000000)throw new HubError('asr_response_too_large');
   const data=JSON.parse(raw);if(typeof data.text!=='string'||!data.text.trim())throw new HubError('asr_empty_response');
   return data.text.trim();
  }catch(e){throw e instanceof HubError?e:new HubError('asr_unavailable');}
 }
}
