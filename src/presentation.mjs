import {z} from 'zod';
import {route,ref} from './contracts.mjs';
/** Presentation limits are applied after storage/ASR; cached full evidence is never truncated. */
export const presentationFields={mode:z.enum(['full','compact']).optional(),maxTotalChars:z.number().int().min(100).max(1000000).optional().describe('Text/transcript characters only, not JSON size. Use maxResponseChars for the serialized response budget.'),maxResponseChars:z.number().int().min(1000).max(1000000).optional().describe('Hard limit for serialized MCP tool result characters, including content, structuredContent, metadata and cursor. Compact defaults to 16000. Repeat all options with next cursor.'),maxTextChars:z.number().int().min(0).max(1000000).optional(),maxTranscriptChars:z.number().int().min(0).max(1000000).optional(),attachmentTypes:z.array(z.enum(['audio','image','video','document'])).max(4).optional()};
export const historyInput=route.extend({cursor:z.string().max(2000).nullable().default(null),limit:z.number().int().min(1).max(100).default(100),readMode:z.enum(['cached','refresh']).optional(),transcribeAudio:z.boolean().optional().describe('Set false for history inspection/backfill without starting automatic ASR. Cached transcripts remain readable; default preserves configured autoAudio.'),audioWaitMs:z.number().int().min(0).max(30000).optional(),...presentationFields}).strict();
export const messageInput=route.extend({messageId:ref,readMode:z.enum(['cached','refresh']).optional()}).strict();
export const mediaKind=a=>/^(audio|voice|ptt)$/i.test(a.kind)||a.mimeType?.startsWith('audio/')?'audio':/image|photo/i.test(a.kind)?'image':/video/i.test(a.kind)?'video':'document';
export function presentPage(page,options={}){
 if(options.mode!=='compact'&&options.maxTotalChars===undefined&&options.maxTextChars===undefined&&options.maxTranscriptChars===undefined&&!options.attachmentTypes?.length)return page;
 const compact=options.mode==='compact',textLimit=options.maxTextChars??(compact?2000:Infinity),transcriptLimit=options.maxTranscriptChars??(compact?1000:Infinity);
 let remaining=options.maxTotalChars??(compact?16000:Infinity);
 const clip=(text,limit)=>{if(typeof text!=='string')return text;const out=text.slice(0,Math.min(limit,remaining));remaining-=out.length;return out;};
 const selected=page.items.filter(m=>!options.attachmentTypes?.length||m.attachments?.some(a=>options.attachmentTypes.includes(mediaKind(a))));
 return {...page,items:selected.map(m=>{
  const originalText=compact&&m.sourceText!==undefined?m.sourceText:m.text;
  const text=clip(originalText,textLimit);
  return {...m,...(compact?{conversationId:undefined,sourceText:undefined,segments:undefined,richMessage:undefined,editedAt:undefined,deletedAt:undefined}:{}),text,...(m.mentionEvidence&&text!==m.text?{mentionEvidence:{...m.mentionEvidence,complete:false,errorCode:'text_truncated'}}:{}),...(!compact&&m.sourceText!==undefined?{sourceText:clip(m.sourceText,textLimit)}:{}),textTruncated:(originalText?.length??0)>(text?.length??0),textLength:originalText?.length??0,

   attachments:(m.attachments??[]).map(a=>{const brief=compact?{...a,id:undefined,providerVersion:undefined,downloadUrl:undefined,downloadRequires:undefined}:a;if(!a.transcription)return brief;const text=clip(a.transcription.text,transcriptLimit);return {...brief,transcription:{...a.transcription,...(compact?{transitions:undefined,segments:undefined,completedAt:undefined,source:undefined}:{}),text,textTruncated:(a.transcription.text?.length??0)>(text?.length??0),textLength:a.transcription.text?.length??0}};}),
   ...(compact?{}:{fullMessageTool:'messenger_message_get'})};
 }),...(options.attachmentTypes?.length?{filterCoverage:'current_provider_page',filteredOut:page.items.length-selected.length}:{})};
}
