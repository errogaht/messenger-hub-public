import {HubError} from '../contracts.mjs';

/** Read the existing archive service only: never start a new sync, download or paid transcription. */
export default {id:'mts',contractVersion:1,create(settings){
 const get=async(route,params={})=>{
  const url=new URL(route,settings.url);url.search=new URLSearchParams(params).toString();
  const r=await fetch(url,{signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new HubError('archive_unavailable');return r;
 };
 const rows=async(phone,offset)=>{const r=await (await get('/api/recordings',{contact:phone,offset:String(offset)})).json();if(!Array.isArray(r.items))throw new HubError('archive_shape');if(r.items.some(x=>String(x.phone)!==phone))throw new HubError('provider_route_mismatch');return r;};
 const identify=id=>{let parts;try{parts=JSON.parse(id);}catch{throw new HubError('call_identity_invalid');}if(!Array.isArray(parts)||parts.length!==2||parts.some(x=>typeof x!=='string'))throw new HubError('call_identity_invalid');return parts;};
 return {capabilities:{history:true,send:false,attachments:true,changes:false,kinds:['call']},
 transcriptionOwner:'mts_mcp',
 /** Local HTTP availability and upstream discovery freshness are distinct.
  * Expose only bounded diagnostics; never leak auth material or CSRF tokens. */
 async health(){const v=await (await get('/api/status')).json(),s=v.settings??{},f=v.freshness??{};return {available:true,checked:'local_archive',sourceSync:{lastIndexedAt:f.last_indexed_at??null,indexAgeSeconds:f.index_age_seconds??null,nextCheckAt:f.next_check_at??s.next_sync??null,inflight:!!(f.inflight??s.sync_job),errorCode:typeof(f.last_error??s.last_error)==='string'?(f.last_error??s.last_error).split(':')[0].slice(0,100):null,lastSyncOk:s.last_sync_ok??null}};},
 async conversations({query,cursor,limit}){
  const offset=cursor?Number(cursor):0;if(!Number.isSafeInteger(offset)||offset<0)throw new HubError('cursor_invalid');
  const list=await (await get('/api/contacts')).json();
  const selected=list.filter(x=>x.phone&&`${x.name} ${x.phone}`.toLowerCase().includes(query.toLowerCase()));
  return {items:selected.slice(offset,offset+limit).map(x=>({id:String(x.phone),title:x.name||String(x.phone),kind:'calls',canSend:false})),next:offset+limit<selected.length?String(offset+limit):null};
 },
 async history({conversationId,cursor,limit}){
  if(!/^\+?\d{5,18}$/.test(conversationId))throw new HubError('phone_invalid');
  const offset=cursor?Number(cursor):0;if(!Number.isSafeInteger(offset)||offset<0)throw new HubError('cursor_invalid');
  const result=await rows(conversationId,offset),items=[];
  for(const x of result.items.slice(0,limit)){
   // Only the scoped local archive can supply speech. Never infer provenance
   // from the abbreviated browse text or submit audio to another ASR service.
   let transcription={status:'not_started',text:null,source:'palatine',owner:'mts_mcp'};
   if(x.text_characters>0||x.state==='ready'){
    let offset=0,text='',characters=0,total=null;
    for(let page=0;page<34;page++){
     const v=await (await get('/api/text',{call:String(x.call_id),record:String(x.record_id),offset:String(offset)})).json();
     if(v.provider!=='palatine'||typeof v.text!=='string'||!Number.isSafeInteger(v.total_characters)||v.total_characters>1000000||v.total_characters<0||total!==null&&total!==v.total_characters)throw new HubError('archive_transcript_unverified');
     // Archive offsets count Python Unicode code points, not JS UTF-16 units.
     total=v.total_characters;text+=v.text;characters+=[...v.text].length;
     if(v.next_offset===null){if(characters!==total)throw new HubError('archive_transcript_incomplete');break;}
     if(v.next_offset!==characters||v.next_offset<=offset)throw new HubError('archive_transcript_pagination');offset=v.next_offset;
    }
    if(characters!==total)throw new HubError('archive_transcript_incomplete');
    transcription={status:'ready',text,source:'palatine',owner:'mts_mcp',speakerAttribution:'provider_unverified'};
   }else if(typeof x.error==='string'&&/^(palatine_balance_insufficient|palatine_http_(401|403|429)|palatine_not_configured)(:|$)/.test(x.error))transcription={...transcription,status:'failed',error:x.error.split(':')[0]};
   else if(['failed','uncertain','unavailable'].includes(x.state))transcription={...transcription,status:'failed',error:'mts_transcription_'+x.state};
   const messageId=JSON.stringify([String(x.call_id),String(x.record_id??'')]);
   const direction=['in','incoming','inbound'].includes(String(x.call?.direction))?'inbound':['out','outgoing','outbound'].includes(String(x.call?.direction))?'outbound':'system';
   // Lifecycle is mutable delivery metadata, separate from native source content.
   const ready=x.readiness??{};
   const callState={recording:ready.recording==='ready'?'published':ready.recording??(x.state==='recording_pending'?'pending':'published'),audio:ready.audio??(x.audio?'ready':'pending'),transcription:transcription.status,durationSeconds:typeof x.duration_seconds==='number'?x.duration_seconds:null};
   items.push({id:messageId,conversationId,kind:'call',callState,direction,senderId:conversationId,at:new Date(typeof x.date==='number'?x.date*1000:x.date).toISOString(),text:null,replyTo:null,replyToKnown:true,attachments:[{id:messageId,kind:'audio',filename:'call.m4a',mimeType:'audio/mp4',size:x.audio?.bytes??null,transcription}]});
  }
  const next=offset+items.length<result.total?String(offset+items.length):null;
  return {items,next,complete:next===null};
 },
 /** An explicit owner/MCP action may prepare old speech. History never calls
  * this lane; MTS owns durable job identity, billing and ambiguous receipts. */
 async requestTranscription(v){
  const [call,record]=identify(v.messageId);let offset=0,found=false,resolvedRecord=record;
  for(let page=0;page<100;page++){const r=await rows(v.conversationId,offset);const match=r.items.find(x=>String(x.call_id)===call&&(!record||String(x.record_id)===record));if(match){found=true;resolvedRecord=String(match.record_id??'');break;}if(r.next_offset===null)break;offset=r.next_offset;}
  if(!found)throw new HubError('attachment_not_in_conversation');
  if(!resolvedRecord)throw new HubError('recording_pending');
  const status=await (await get('/api/status')).json();
  const r=await fetch(new URL('/api/prepare',settings.url),{method:'POST',headers:{'Content-Type':'application/json','X-Archive-CSRF':status.csrf},body:JSON.stringify({call_id:call,record_id:resolvedRecord}),signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new HubError('mts_prepare_failed');const job=await r.json();if(typeof job.job_id!=='string')throw new HubError('archive_shape');return job.job_id;
 },
 async attachment(v){
  if(v.messageId!==v.attachmentId)throw new HubError('attachment_mismatch');
  const [call,record]=identify(v.messageId);let offset=0,found=false,resolvedRecord=record;
  // A caller cannot borrow a recording ID from another contact. Walk only this selected phone.
  for(let page=0;page<100;page++){
   const r=await rows(v.conversationId,offset);const match=r.items.find(x=>String(x.call_id)===call&&(!record||String(x.record_id)===record));if(match){found=true;resolvedRecord=String(match.record_id??'');break;}
   if(r.next_offset===null)break;offset=r.next_offset;
  }
  if(!found)throw new HubError('attachment_not_in_conversation');
  if(!resolvedRecord)throw new HubError('recording_pending');
  const r=await get('/audio',{call,record:resolvedRecord});
  const maxBytes=Math.min(v.maxBytes??256*1024*1024,256*1024*1024);
  if(Number(r.headers.get('content-length'))>maxBytes)throw new HubError('attachment_too_large');
  const reader=r.body.getReader(),chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)throw new HubError('attachment_too_large');chunks.push(value);}}finally{await reader.cancel();}
  return {base64:Buffer.concat(chunks).toString('base64'),mimeType:r.headers.get('content-type')??'audio/mp4',filename:'call.m4a'};
 }
 };
}};
