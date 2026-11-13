import {HubError,conversation,key} from './contracts.mjs';

/** Parse addresses as data. Publication links select the peer, never an HTTP
 * fetch, invite acceptance or an implicit change of message/topic selection. */
export function telegramAddress(value){
 const text=value.trim();
 if(!text||/[\u0000-\u001f]/.test(text))throw new HubError('conversation_format_invalid');
 if(/^-?\d+$/.test(text)){const id=BigInt(text);if(id===0n)throw new HubError('conversation_format_invalid');return {kind:'id',value:String(id)};}
 const username=s=>{if(!/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(s))throw new HubError('conversation_format_invalid');return {kind:'username',value:s.toLowerCase()};};
 if(text.startsWith('@'))return username(text.slice(1));
 if(/^(?:https?:\/\/)?(?:www\.)?t\.me\//i.test(text)){
  let url;try{url=new URL(/^https?:/i.test(text)?text:'https://'+text);}catch{throw new HubError('conversation_format_invalid');}
  const parts=url.pathname.split('/').filter(Boolean);
  if(parts[0]==='s')parts.shift();
  if(parts[0]==='c'&&parts.length>=3&&parts.length<=4&&parts.slice(1).every(x=>/^[1-9]\d*$/.test(x)))return {kind:'id',value:'-100'+parts[1]};
  if(![1,2,3].includes(parts.length)||parts.slice(1).some(x=>!/^\d+$/.test(x))||['joinchat','share','addlist','c','s'].includes(parts[0]?.toLowerCase()))throw new HubError('conversation_format_invalid');
  return username(parts[0]);
 }
 if(/:\/\/|^t\.me\b/i.test(text))throw new HubError('conversation_format_invalid');
 // Bare username-shaped titles try exact Telegram resolution first. A native
 // not-found permits title lookup; denial/provider failure never permits fallback.
 if(/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(text))return {...username(text),bare:true};
 return {kind:'title',value:text.toLocaleLowerCase()};
}

/** Shared parser for the pinned bridge's safe read protocol. */
export function telegramReadResult(raw){
 if(raw?.error){const allowed=['conversation_format_invalid','conversation_not_found','conversation_access_denied','telegram_read_provider_failed','cursor_invalid'];throw new HubError(allowed.includes(raw.error)?raw.error:'telegram_read_provider_failed');}
 return raw;
}
export function telegramPeer(raw){const r=conversation.safeParse(raw);if(!r.success||!/^-?[1-9]\d*$/.test(r.data.id))throw new HubError('telegram_read_provider_failed');return r.data;}

/** Resolve before cache/media registration, then enforce the canonical route
 * grant. Candidates are scope-filtered BEFORE ambiguity details can escape. */
export async function resolveReadRoute(hub,scope,v){
 const {instance,scope:grant}=hub.access(scope,v.connectionId);
 if(!instance.resolveConversation)return v;
 const address=telegramAddress(v.conversationId);
 let peer;
 if(address.kind==='id')peer={id:address.value};
 else if(hub.cache.mode(v)==='cached'){
  const rows=hub.cache.db.prepare("SELECT body FROM read_catalog WHERE connection=? AND chat='' ").all(v.connectionId).map(r=>JSON.parse(r.body)).filter(x=>grant.conversations==='*'||grant.conversations.includes(x.id));
  let found=rows.filter(x=>address.kind==='username'?x.username?.toLowerCase()===address.value:x.title.toLocaleLowerCase().includes(address.value));
  const exactUsername=address.kind==='username'&&found.length>0;
  if(!found.length&&address.bare)found=rows.filter(x=>x.title.toLocaleLowerCase().includes(address.value));
  if(found.length>1)throw new HubError('conversation_ambiguous',{candidates:found});
  if(!found.length)throw new HubError('conversation_not_cached',{nextAction:'Use readMode:refresh to resolve through the existing Telegram session; no provider was contacted.'});
  // A cached catalog is only an observed subset. One title match cannot prove
  // uniqueness; an exact cached username has Telegram's unique-name semantics.
  if(!exactUsername)throw new HubError('conversation_search_incomplete',{candidates:found,coverage:{source:'cache',complete:false},nextAction:'Use readMode:refresh to establish title-search coverage, or choose a confirmed candidate ID.'});
  peer=found[0];
 }else peer=await instance.resolveConversation({address,allowed:grant.conversations});
 hub.access(scope,v.connectionId,peer.id);
 if(peer.title)hub.cache.db.prepare('INSERT OR REPLACE INTO read_catalog VALUES(?,?,?,?)').run(key(key(v.connectionId,''),peer.id),v.connectionId,'',JSON.stringify(peer));
 return {...v,conversationId:peer.id};
}
