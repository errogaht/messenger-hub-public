import {createHash} from 'node:crypto';
import {HubError} from './contracts.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
const folded=value=>value.normalize('NFC').toLocaleLowerCase('ru');

/** GOWA SQLite LOWER only folds ASCII, and its native search ignores offset.
 * Search bounded pages of this exact authorized chat instead. The cursor points
 * at the first unexamined row, not at a number of matches; sparse/no-match pages
 * remain resumable. No account-wide scan or background indexing is performed. */
export function historySearch(history,{scanLimit=500}={}){
 return async v=>{
  const binding=digest(JSON.stringify([v.conversationId,v.query]));let offset=0;
  if(v.cursor){
   let state;try{if(!v.cursor.startsWith('ws:'))throw new Error();state=JSON.parse(Buffer.from(v.cursor.slice(3),'base64url').toString());}catch{throw new HubError('cursor_invalid');}
   if(state.binding!==binding||!Number.isSafeInteger(state.offset)||state.offset<0)throw new HubError('cursor_invalid');offset=state.offset;
  }
  const needle=folded(v.query),items=[];let scanned=0,complete=false;
  while(scanned<scanLimit&&items.length<v.limit){
   const page=await history({...v,query:undefined,cursor:String(offset),limit:Math.min(100,scanLimit-scanned)});
   if(!page.items.length){complete=!page.next;break;}
   let consumed=0;
   for(const m of page.items){
    consumed++;scanned++;offset++;
    if(folded(m.text??'').includes(needle))items.push(m);
    if(items.length===v.limit)break;
   }
   if(consumed===page.items.length&&!page.next){complete=true;break;}
  }
  return {items,next:complete?null:'ws:'+Buffer.from(JSON.stringify({binding,offset})).toString('base64url'),complete,order:'opaque'};
 };
}
