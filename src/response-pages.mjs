import {resultChars} from './tool-result.mjs';
import {randomUUID} from 'node:crypto';
import {HubError} from './contracts.mjs';
import {hash} from './store.mjs';
import {presentPage,mediaKind} from './presentation.mjs';

/** Bounds describe the returned messages only, never an unscanned day or the
 * whole provider archive. Even a minimal budgeted row retains these timestamps;
 * next/complete separately describe whether history traversal can continue. */
function returnedCoverage(rows){
 const dates=rows.map(m=>m.at).filter(Boolean).sort((a,b)=>Date.parse(a)-Date.parse(b));
 return {basis:'returned_messages',oldestAt:dates[0]??null,newestAt:dates.at(-1)??null};
}

/** Split frozen provider pages, never advance an offset past unreturned messages.
 * Cursors are opaque, scope/route/options bound and durable for 24 hours. Expiry
 * is explicit; it never silently restarts history or changes the selected chat. */
export class ResponsePages {
 constructor(hub,db){this.hub=hub;this.db=db;db.exec('CREATE TABLE IF NOT EXISTS history_pages(id TEXT PRIMARY KEY,scope TEXT NOT NULL,digest TEXT NOT NULL,expires INTEGER NOT NULL,body TEXT NOT NULL)');}
 async history(scope,v){
  this.hub.access(scope,v.connectionId,v.conversationId);
  const {cursor,...options}=v,digest=hash(options),budget=v.maxResponseChars??(v.mode==='compact'?16000:null);
  let page,providerCursor=cursor;
  if(cursor?.startsWith('hp:')){
   const row=this.db.prepare('SELECT * FROM history_pages WHERE id=? AND scope=?').get(cursor.slice(3),scope);
   if(!row||row.digest!==digest)throw new HubError('cursor_invalid',{nextAction:'Repeat the same route, limit, filter and presentation options with this cursor.'});
   if(row.expires<Date.now())throw new HubError('cursor_expired',{nextAction:'Start a new history request without cursor; the old snapshot expired after 24 hours.'});
   const state=JSON.parse(row.body);page=state.page;providerCursor=state.providerCursor;
  }
  if(!page){
   const cached=this.hub.cache.mode(v)==='cached';
   page=cached?this.hub.cache.history(scope,{...v,cursor:providerCursor}):await this.hub.readHistory(scope,{...v,cursor:providerCursor});
   if(!cached&&this.hub.media)page=await this.hub.media.enrich(scope,v.connectionId,page,{automatic:v.transcribeAudio!==false,waitMs:v.transcribeAudio===false?0:v.audioWaitMs??this.hub.media.config.historyWaitMs});
  }
  if(!budget){const result=presentPage(page,v);return {...result,conversationId:v.conversationId,coverage:returnedCoverage(result.items)};}
  const selected=page.items.filter(m=>!v.attachmentTypes?.length||m.attachments?.some(a=>v.attachmentTypes.includes(mediaKind(a))));
  const id=randomUUID(),next='hp:'+id;
  const envelope=(items,hasMore,window=items)=>({conversationId:v.conversationId,coverage:returnedCoverage(window),...(page.cache?{cache:page.cache}:{}),items,next:hasMore?next:null,complete:!hasMore&&page.complete,fullMessageTool:'messenger_message_get',...(v.attachmentTypes?.length?{filterCoverage:'current_provider_page'}:{}),responseBudget:{maxChars:budget,unit:'serialized_mcp_result_chars'}});
  const render=rows=>presentPage({...page,items:rows},{...v,attachmentTypes:undefined}).items;
  let count=0,result=envelope([],!!page.next);
  for(let n=1;n<=selected.length;n++){
   const candidate=envelope(render(selected.slice(0,n)),n<selected.length||!!page.next);
   if(resultChars(candidate)>budget)break;
   count=n;result=candidate;
  }
  if(!count&&selected.length){
   // One pathological message cannot starve a page forever. Keep its stable ID
   // and a bounded excerpt; the complete evidence remains in message_get.
   const m=selected[0],text=m.sourceText??m.text??'';
   const minimal=n=>envelope([{id:m.id,at:m.at,text:text.slice(0,n),textLength:text.length,textTruncated:n<text.length,detailsOmitted:true,attachmentCount:m.attachments?.length??0}],selected.length>1||!!page.next,[m]);
   if(resultChars(minimal(0))>budget)throw new HubError('response_budget_too_small',{minimumChars:resultChars(minimal(0))});
   let low=0,high=Math.min(text.length,v.maxTextChars??2000,v.maxTotalChars??Infinity);
   while(low<high){const mid=Math.ceil((low+high)/2);if(resultChars(minimal(mid))<=budget)low=mid;else high=mid-1;}
   result=minimal(low);count=1;
  }
  if(result.next){
   this.db.prepare('DELETE FROM history_pages WHERE expires<?').run(Date.now());
   // Bound storage as well as response size; refuse new cursors instead of
   // evicting still-valid snapshots behind another caller's back.
   if(this.db.prepare('SELECT COUNT(*) n FROM history_pages').get().n>=10000)throw new HubError('history_snapshot_limit');
   const state=count<selected.length?{page:{...page,items:selected.slice(count)},providerCursor:null}:{page:null,providerCursor:page.next};
   this.db.prepare('INSERT INTO history_pages VALUES(?,?,?,?,?)').run(id,scope,digest,Date.now()+86400000,JSON.stringify(state));
  }
  return result;
 }
}
