import {readdir,realpath,stat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {HubError} from '../contracts.mjs';
const execute=promisify(execFile),reader=fileURLToPath(new URL('./email-reader.py',import.meta.url));
/** Explicit read-only RFC822 export adapter, not IMAP/SMTP or native mail push.
 * Mailbox IDs and folders are operator-controlled; no auth/session is created.
 * Every file/part is rebound to this mailbox before parsing or downloading. */
export default {id:'email',contractVersion:1,create(settings){
 const mailbox=async id=>{const m=settings.mailboxes?.[id];if(!m)throw new HubError('mailbox_unknown');return {label:m.label??id,root:await realpath(m.root)};};
 const files=async id=>{const m=await mailbox(id),found=[];for(const name of await readdir(m.root)){if(!/\.eml$/i.test(name))continue;const file=await realpath(path.join(m.root,name));if(!file.startsWith(m.root+path.sep))throw new HubError('email_path_denied');const s=await stat(file);if(s.size>25*1024*1024)throw new HubError('email_size_limit');found.push({id:createHash('sha256').update(name).digest('hex'),path:file,mtime:s.mtimeMs});}return found.sort((a,b)=>b.mtime-a.mtime||a.id.localeCompare(b.id));};
 const read=async f=>{try{return JSON.parse((await execute('python3',[reader,f.path],{timeout:15000,maxBuffer:5000000})).stdout);}catch{throw new HubError('email_parse_failed');}};
 const find=async v=>{const f=(await files(v.conversationId)).find(f=>f.id===v.messageId);if(!f)throw new HubError('email_not_found');return f;};
 return {capabilities:{history:true,send:false,attachments:true,changes:false,kinds:['message']},
 async health(){return {available:true,checked:'local_rfc822_export',transportMode:'explicit_refresh_import'};},
 async conversations({query='',cursor=null,limit=50}){const offset=Number(cursor??0);if(!Number.isSafeInteger(offset)||offset<0)throw new HubError('cursor_invalid');const rows=Object.entries(settings.mailboxes??{}).map(([id,m])=>({id,title:m.label??id,kind:'email',canSend:false})).filter(x=>`${x.title} ${x.id}`.toLowerCase().includes(query.toLowerCase()));return {items:rows.slice(offset,offset+limit),next:offset+limit<rows.length?String(offset+limit):null};},
 async message(v){const f=await find(v),r=await read(f);return {id:f.id,conversationId:v.conversationId,direction:'inbound',senderId:r.email.from||null,at:r.at,text:r.text,email:r.email,attachments:r.attachments,replyTo:null};},
 async history(v){const rows=await files(v.conversationId),offset=Number(v.cursor??0);if(!Number.isSafeInteger(offset)||offset<0)throw new HubError('cursor_invalid');const items=[];for(const f of rows.slice(offset,offset+v.limit))items.push({id:f.id,conversationId:v.conversationId,direction:'inbound',senderId:null,...await read(f),replyTo:null});return {items,next:offset+items.length<rows.length?String(offset+items.length):null,complete:offset+items.length>=rows.length};},
 async attachment(v){const f=await find(v);if(!/^part:\d+:[a-f0-9]{64}$/.test(v.attachmentId))throw new HubError('attachment_mismatch');const [,part,digest]=v.attachmentId.split(':');if(createHash('sha256').update(await readFile(f.path)).digest('hex')!==digest)throw new HubError('attachment_changed');try{return JSON.parse((await execute('python3',[reader,f.path,part],{timeout:15000,maxBuffer:35000000})).stdout);}catch{throw new HubError('email_attachment_unavailable');}}
 };
}};
