import {test} from 'node:test';
import assert from 'node:assert/strict';
import telegram,{parseHistory} from '../src/plugins/telegram.mjs';
import {Hub} from '../src/hub.mjs';
import {Store} from '../src/store.mjs';
import {diagnostic} from '../src/errors.mjs';

const line=(id,sender='Member [id=8]',text='synthetic')=>`ID: ${id} | ${sender} | Date: 2026-10-21T00:00:00Z | Message: ${text}`;

test('Unknown sender rows are retained without borrowing identity or reply metadata from body',()=>{
 // Deleted/anonymous sender is valid; untrusted body cannot turn it into owner.
 const m=parseHistory(line(830,'Unknown','text [id=4] | reply to 9'),'-100123','4')[0];
 assert.equal(m.senderId,null);assert.equal(m.isSelf,null);assert.equal(m.authorLabel,undefined);assert.equal(m.replyTo,null);assert.equal(m.id,'830');
 assert.equal(parseHistory(line(829,'Sender: Owner [id=4]'),'-100123','4')[0].isSelf,true);
});

test('malformed records expose safe field/type/index diagnostics without leaking raw data',()=>{
 // Reject actual malformed data rather than skipping a row or copying secrets
 // into public error text. Structured wrong types also retain their real type.
 const secret='private-placeholder';
 for(const [raw,field,type] of [[{},'response','object'],[null,'response','null'],[line(2,'User [id=oops]',secret),'senderId','invalid_token'],[line(2,'Unknown',secret).replace('2026-10-21T00:00:00Z','invalid-date'),'date','invalid_or_missing']]){
  assert.throws(()=>parseHistory(raw,'-100123','4'),e=>{const d=diagnostic(e,'history');assert.equal(d.code,'telegram_history_shape');assert.equal(d.field,field);assert.equal(d.actualType,type);assert.ok(!JSON.stringify(d).includes(secret));return true;});
 }
});

test('full history pagination retains Unknown records across bounded response cursors with no omissions',async()=>{
 // Synthetic201-row provider: page2 includes the same25 unknown-author pattern.
 // Small response budget exercises both provider and frozen-response cursors.
 const rows=Array.from({length:201},(_,i)=>line(201-i,i>=100&&i<125?'Unknown':'Member [id=8]','text'.repeat(60)));
 const upstream={call:async(name,args)=>{assert.equal(name,'get_messages');return rows.slice((args.page-1)*100,args.page*100).join('\n')||'No messages found for this page.';},close:async()=>{}};
 const hub=new Hub({version:1,store:':memory:',plugins:{telegram:'/unused'},connections:{tg:{plugin:'telegram',label:'TG',settings:{selfId:'4',upstreamClient:upstream}}},scopes:{reader:{token:'x'.repeat(40),connections:{tg:{read:true,send:false,conversations:['-100123']}}}}},{telegram},new Store(':memory:'));
 try{let cursor=null,ids=[],unknown=0,complete=false,calls=0;
 do{const page=await hub.call('reader','history',{connectionId:'tg',conversationId:'-100123',readMode:'refresh',cursor,limit:100,mode:'full',maxResponseChars:5000,transcribeAudio:false});ids.push(...page.items.map(m=>m.id));unknown+=page.items.filter(m=>m.senderId===null).length;cursor=page.next;complete=page.complete;assert.ok(++calls<100);}while(cursor);
 assert.equal(complete,true);assert.equal(unknown,25);assert.equal(ids.length,201);assert.equal(new Set(ids).size,201);assert.deepEqual(ids,Array.from({length:201},(_,i)=>String(201-i)));
 }finally{await hub.close();}
});
