import {z} from 'zod';
/** Only native entity offsets are evidence. Text substring/reply/labels cannot
 * become mentions. UTF16 coordinates deliberately match Telegram and Rust UI. */
export const mentionEvidence=z.object({version:z.literal(1),source:z.literal('telegram_native_entities'),complete:z.boolean(),textField:z.literal('text'),coordinateSystem:z.literal('utf16'),entities:z.array(z.object({nativeType:z.enum(['MessageEntityMention','MessageEntityMentionName']),offset:z.number().int().nonnegative(),length:z.number().int().positive(),recipientUserId:z.string().regex(/^\d+$/).nullable(),username:z.string().regex(/^[a-zA-Z0-9_]{1,32}$/).nullable()}).strict()).max(100),errorCode:z.string().max(100).optional()}).strict();
/** Provider claims of completeness are validated against full source text.
 * Malformed mentions fail closed but do not discard the message or journal. */
export function checkedMentions(text,evidence){const parsed=mentionEvidence.safeParse(evidence);const absent={version:1,source:'telegram_native_entities',complete:false,textField:'text',coordinateSystem:'utf16',entities:[],errorCode:evidence?'mention_evidence_invalid':'native_entities_unavailable'};if(!parsed.success)return absent;const v=parsed.data;
 for(const e of v.entities){const end=e.offset+e.length,span=text?.slice(e.offset,end);const boundary=n=>n>0&&n<text?.length&&/[\uD800-\uDBFF]/.test(text[n-1])&&/[\uDC00-\uDFFF]/.test(text[n]);if(typeof text!=='string'||end>text.length||boundary(e.offset)||boundary(end)||e.nativeType==='MessageEntityMentionName'&&(!e.recipientUserId||e.username!==null)||e.nativeType==='MessageEntityMention'&&(e.recipientUserId!==null||!e.username||span!==`@${e.username}`))return {...absent,errorCode:'mention_range_or_target_invalid'};}
 return v;
}
