import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkedMentions} from '../src/mentions.mjs';
import {presentPage} from '../src/presentation.mjs';
import telegram from '../src/plugins/telegram.mjs';
const dto=entities=>({version:1,source:'telegram_native_entities',complete:true,textField:'text',coordinateSystem:'utf16',entities});
const name=(offset=0,length=4,id='100000001')=>({nativeType:'MessageEntityMentionName',offset,length,recipientUserId:id,username:null});
test('native evidence validates UTF16 offsets without plain-text or reply inference',()=>{
 // Astral emoji is two UTF16 units. Wrong boundaries must close the group filter.
 const text='🙂 Owner';assert.equal(checkedMentions(text,dto([name(3,5)])).complete,true);assert.equal(checkedMentions(text,dto([name(1,5)])).complete,false);assert.equal(checkedMentions(text,dto([name(3,99)])).complete,false);
 assert.equal(checkedMentions('@owner',undefined).complete,false);assert.deepEqual(checkedMentions('@owner',dto([])).entities,[]);assert.equal(checkedMentions('Owner',dto([name(0,5,'111')])).entities[0].recipientUserId,'111');
 const username={nativeType:'MessageEntityMention',offset:3,length:6,recipientUserId:null,username:'owner'};assert.equal(checkedMentions('🙂 @owner',dto([username])).complete,true);assert.equal(checkedMentions('🙂 @other',dto([username])).complete,false);assert.equal(checkedMentions('Owner',{...dto([name()]),coordinateSystem:'bytes'}).complete,false);const brief=presentPage({items:[{text:'Owner',mentionEvidence:dto([name(0,5)]),attachments:[]}]},{mode:'compact',maxTextChars:3});assert.equal(brief.items[0].mentionEvidence.complete,false);assert.equal(brief.items[0].mentionEvidence.errorCode,'text_truncated');
});
test('selected raw bridge preserves mentions and identity; unselected routes retain legacy transport',async()=>{
 // Native selected history is one batch RPC, not a sender/contact fetch per row.
 const calls=[],sample={id:'2',conversationId:'123',direction:'inbound',senderId:'person',at:'2026-10-02T10:00:00Z',text:'Owner',attachments:[],mentionEvidence:dto([name(0,5)])};
 const adapter=telegram.create({selfId:'100000001',nativeHistoryConversations:['123'],upstreamClient:{call:async(m,args)=>{calls.push(m);if(m==='hub_native_history')return {items:[sample],next:null,complete:true};if(m==='hub_native_message')return {message:sample};if(m==='hub_native_identity')return {self:{id:'100000001',isSelf:true,verified:true,username:'self_test',evidence:'telegram_get_me',verifiedAt:'2026-10-02T10:00:00Z'}};if(m==='get_messages')return 'No messages found';throw new Error('unexpected');}}});
 assert.equal((await adapter.history({conversationId:'123',cursor:null,limit:100})).items[0].mentionEvidence.complete,true);assert.equal((await adapter.message({conversationId:'123',messageId:'2'})).mentionEvidence.entities[0].recipientUserId,'100000001');assert.equal((await adapter.identity()).self.verified,true);await adapter.history({conversationId:'456',cursor:null,limit:100});assert.deepEqual(calls,['hub_native_history','hub_native_message','hub_native_identity','get_messages']);
});
