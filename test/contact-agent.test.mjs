import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Hub} from '../src/hub.mjs';
import {Store} from '../src/store.mjs';
import {HubError} from '../src/contracts.mjs';
import {StyleModel} from '../src/llm.mjs';
import {ContactBook} from '../src/contact-book.mjs';
import {importProfiles} from '../scripts/import-profiles.mjs';

function fixture(t,{model,send,history,message,resumeSend,reconcile}={}){
 const root=mkdtempSync(path.join(tmpdir(),'hub-agent-'));let generations=0,sends=0,reads=0;const seen=[];
 const endpoint={connectionId:'a',conversationId:'101',kind:'direct',label:'Александр'};
 const plugin={create:()=>({capabilities:{history:true,send:true,attachments:false,changes:false,kinds:['message'],maxText:4096},
  conversations:async()=>({items:[{id:'101',title:'Александр',kind:'direct',canSend:true}],next:null}),
  ...(message?{message}:{}),...(resumeSend?{resumeSend}:{}),...(reconcile?{reconcile}:{}),
  history:async(v)=>{const {conversationId}=v;reads++;if(history)return history(v);return {items:[{id:'1',conversationId,direction:'outbound',senderId:'owner',at:'2026-09-27T00:00:00Z',text:'Привет, Саша!'}],complete:true,next:null};},
  send:async v=>{sends++;seen.push(v);return send?send(v):{status:'sent',messageId:'sent-1'};}})};
 const grant={read:true,send:true,profiles:true,conversations:'*'};
 const config={version:1,cache:{defaultRead:'refresh'},store:':memory:',plugins:{fake:'/fake'},connections:{a:{plugin:'fake',label:'A',settings:{}},b:{plugin:'fake',label:'B',settings:{}}},
  scopes:{owner:{token:'a'.repeat(40),assistant:true,contactAdmin:true,connections:{a:grant,b:grant}},limited:{token:'b'.repeat(40),assistant:true,connections:{a:grant}},reader:{token:'c'.repeat(40),assistant:true,connections:{a:{...grant,send:false}}}},
  assistant:{root,enabled:true,keyFile:path.join(root,'key'),baseUrl:'https://synthetic.invalid/v1',model:'gpt-6-luna',effort:'medium',timeoutMs:2000}};
 const hub=new Hub(config,{fake:plugin},new Store(':memory:'),{model:{generate:async(p,data,options)=>{generations++;return model?model(p,data,options):p.includes('Create a concise')?'# Профиль\nОбращение: ты.':JSON.stringify({text:data.source,warnings:[]});}}});
 hub.contactAgent.book.put({id:'sasha',name:'Александр',aliases:['Саша'],endpoints:[endpoint]});
 t.after(async()=>{await hub.close();rmSync(root,{recursive:true,force:true});});
 return {hub,root,endpoint,seen,stats:()=>({generations,sends,reads})};
}
const input={recipient:'sasha',requestId:'r1',text:'Готово. Стоимость 100, ссылка https://example.com/report',replyTo:null};

test('smart send creates profile, rewrites and sends once; changed payload cannot reuse request ID',async t=>{
 // A fresh contact needs two LLM calls. Retries must not reread history, regenerate, or resend.
 const f=fixture(t);const first=await f.hub.call('owner','contact_send',input);
 assert.equal(first.status,'sent');assert.equal(first.text,input.text);assert.equal(f.stats().generations,2);
 assert.equal((await f.hub.call('owner','contact_send',input)).messageId,'sent-1');assert.equal(f.stats().sends,1);
 await assert.rejects(f.hub.call('owner','contact_send',{...input,text:'changed'}),/idempotency_conflict/);
 assert.ok(f.hub.contactAgent.book.profile('person:sasha'));
});

test('preview is send-free and later send reuses its exact prepared text',async t=>{
 // Explicit preview and send share an operation; persona changes must not silently change reviewed text.
 const f=fixture(t);assert.equal((await f.hub.call('owner','contact_prepare',input)).status,'prepared');
 const before=f.stats();f.hub.contactAgent.book.setPersonality('A completely different style');
 assert.equal((await f.hub.call('owner','contact_send',input)).status,'sent');
 assert.equal(f.stats().generations,before.generations);assert.equal(f.seen[0].text,input.text);
});

test('concurrent retry and ambiguous transport do not duplicate a send',async t=>{
 // A response lost after transport may have delivered. The durable state remains unknown.
 const f=fixture(t,{send:async()=>{throw new Error('lost');}});
 await Promise.all([f.hub.call('owner','contact_send',input),f.hub.call('owner','contact_send',input)]);
 assert.equal((await f.hub.call('owner','contact_send',input)).status,'unknown');assert.equal(f.stats().sends,1);
 assert.equal((await f.hub.call('owner','contact_delivery',{requestId:'r1'})).status,'unknown');
});

test('raw and legacy paths preserve exact text and never invoke the model, even when disabled',async t=>{
 // WorkZone has already approved this exact text; the assistant switch must not affect transport.
 const f=fixture(t);f.hub.contactAgent.config.enabled=false;
 const v={connectionId:'a',conversationId:'101',requestId:'raw',text:'  **Exact**\n100 ₽  '};
 await f.hub.call('owner','send_raw',v);await f.hub.call('owner','send',{...v,requestId:'legacy'});
 assert.deepEqual(f.seen.map(v=>v.text),[v.text,v.text]);assert.equal(f.stats().generations,0);
 await assert.rejects(f.hub.call('owner','contact_send',input),/assistant_disabled/);
});

test('same names and multiple endpoints require selection before any model or send',async t=>{
 // Names are not identity proofs, and a contact with two addresses has no implicit preferred route.
 const f=fixture(t);const book=f.hub.contactAgent.book;
 book.put({id:'another',name:'Александр',endpoints:[{...f.endpoint,conversationId:'202'}]});
 assert.equal((await f.hub.call('owner','contact_send',{...input,recipient:'Александр'})).status,'needs_recipient');
 const c=book.get('sasha');book.put({...c,endpoints:[...c.endpoints,{...f.endpoint,connectionId:'b'}]});
 assert.equal((await f.hub.call('owner','contact_send',input)).status,'needs_route');assert.equal(f.stats().generations,0);
});

test('profile sources and hidden endpoints cannot cross project scopes',async t=>{
 // A global profile can contain facts from another portal, so route visibility alone is insufficient.
 const f=fixture(t),book=f.hub.contactAgent.book;
 const c=book.get('sasha');book.put({...c,endpoints:[...c.endpoints,{...f.endpoint,connectionId:'b'}]});
 book.setProfile('person:sasha','Private B-derived knowledge',[{connectionId:'b',conversationId:'101'}]);
 const search=await f.hub.call('limited','contact_search',{query:'Саша'});assert.equal(search.items[0].endpoints.length,1);
 const result=await f.hub.call('limited','contact_send',{...input,connectionId:'a'});assert.equal(result.error,'profile_sources_not_authorized');
 assert.equal(f.stats().generations,0);assert.equal(f.stats().sends,0);
 await assert.rejects(f.hub.call('reader','contact_send',{...input,requestId:'reader'}),/not_authorized/);
 await assert.rejects(f.hub.call('limited','contact_profile_set',{contactId:'sasha',markdown:'overwrite'}),/not_authorized/);
});

test('changed numbers are discarded and unchanged source is sent once',async t=>{
 // Reject the model-altered price, then persist and send only the trusted original.
 const f=fixture(t,{model:async(p,d)=>p.includes('Create a concise')?'# Profile':JSON.stringify({text:d.source.replace('100','200'),warnings:[]})});
 const r=await f.hub.call('owner','contact_send',input);assert.equal(r.status,'sent');assert.equal(r.stylePreparation.reason,'rewrite_changed_numbers_or_links');assert.equal(f.seen[0].text,input.text);
 assert.equal((await f.hub.call('owner','contact_send',input)).messageId,r.messageId);assert.equal(f.stats().generations,3);assert.equal(f.stats().sends,1);
});

test('group profile generation uses that audience only; override and personality reach rewrite',async t=>{
 // Public group style must not become the generic person's profile or absorb another channel.
 const captured=[];const f=fixture(t,{model:async(p,d)=>{captured.push(d);return p.includes('Create a concise')?'# Уважительное обращение':JSON.stringify({text:d.source,warnings:[]});}});
 const book=f.hub.contactAgent.book;book.put({id:'group',name:'Коллеги',endpoints:[{...f.endpoint,conversationId:'-123',kind:'group'}]});
 book.setPersonality('Кратко и по делу');
 assert.equal((await f.hub.call('owner','contact_prepare',{...input,recipient:'group'})).status,'prepared');
 assert.equal(book.profile('person:group'),null);assert.equal(captured[0].histories.length,1);
 assert.match(captured[1].conversationOverride,/Уважительное/);assert.equal(captured[1].personality,'Кратко и по делу');
});

test('import is repeatable, preserves profiles and keeps namesakes separate',async t=>{
 // Exact legacy identifiers are authoritative. Import must not overwrite later owner profile edits.
 const root=mkdtempSync(path.join(tmpdir(),'hub-import-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(path.join(root,'111-sasha.md'),'# Александр\nTelegram profile');
 writeFileSync(path.join(root,'222-sasha.md'),'# Александр\nDifferent person');
 writeFileSync(path.join(root,'README.md'),'# Not a profile');
 const book=new ContactBook(path.join(root,'book'));t.after(()=>book.close());
 const config={connections:{tg:{plugin:'telegram',settings:{profileRoot:root}}}};
 assert.equal((await importProfiles(config,book)).imported,2);assert.equal(book.all().length,2);
 const first=book.all()[0];book.setProfile('person:'+first.id,'Owner correction',first.endpoints);
 assert.equal((await importProfiles(config,book)).imported,0);assert.equal(book.profile('person:'+first.id).markdown,'Owner correction');
});

test('Responses client uses requested model, medium effort and store=false without exposing errors',async t=>{
 // Gateway auth stays in the header; partial responses must never become sendable messages.
 const root=mkdtempSync(path.join(tmpdir(),'hub-model-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const keyFile=path.join(root,'key');writeFileSync(keyFile,'synthetic-secret',{mode:0o600});let body;
 const config={enabled:true,keyFile,baseUrl:'https://synthetic.invalid/v1',model:'gpt-6-luna',effort:'medium',timeoutMs:1000};
 const model=new StyleModel(config,async(url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'ok'}]}]}));});
 assert.equal(await model.generate('instructions',{source:'hello'}),'ok');assert.equal(body.store,false);assert.equal(body.reasoning.effort,'medium');assert.equal(body.model,'gpt-6-luna');
 const failing=new StyleModel(config,async()=>{throw new Error('synthetic-secret');});await assert.rejects(failing.generate('a',{}),e=>e.message==='llm_unavailable');
});

test('prepared and unknown operations survive reopening the private database',async t=>{
 // Process restart cannot discard the actual rewritten text or turn an unknown send into a new attempt.
 const f=fixture(t,{send:async()=>{throw new Error('lost response');}});
 const preview=await f.hub.call('owner','contact_prepare',input);assert.equal(preview.status,'prepared');
 f.hub.contactAgent.book.close();f.hub.contactAgent.book=new ContactBook(f.root);
 assert.equal((await f.hub.call('owner','contact_send',input)).status,'unknown');
 f.hub.contactAgent.book.close();f.hub.contactAgent.book=new ContactBook(f.root);
 assert.equal((await f.hub.call('owner','contact_send',input)).status,'unknown');assert.equal(f.stats().sends,1);
});

test('explicit identity merge keeps shared profile and both endpoints; stale revision cannot overwrite',async t=>{
 // Only an owner-confirmed identity merge combines Telegram and WhatsApp-like endpoints.
 const f=fixture(t),book=f.hub.contactAgent.book;
 book.setProfile('person:sasha','# Telegram style',[f.endpoint]);
 const wa=book.put({id:'wa-sasha',name:'Саша WhatsApp',endpoints:[{...f.endpoint,connectionId:'b'}]});
 book.setProfile('person:wa-sasha','# WhatsApp style',wa.endpoints);
 const merged=await f.hub.call('owner','contact_merge',{targetId:'sasha',sourceId:wa.id,targetRevision:1,sourceRevision:1});
 assert.equal(merged.contact.endpoints.length,2);assert.equal(book.get(wa.id),null);
 assert.match(book.profile('person:sasha').markdown,/Telegram style/);assert.match(book.profile('person:sasha').markdown,/WhatsApp style/);
 await assert.rejects(f.hub.call('owner','contact_save',{...merged.contact,revision:1}),/contact_revision_conflict/);
 const preview=await f.hub.call('owner','contact_prepare',{...input,connectionId:'b'});assert.equal(preview.status,'prepared');
 assert.equal(f.stats().generations,1);
});

test('model warnings and owner outbound prohibition prevent smart dispatch',async t=>{
 // Profile restrictions and uncertain rewrites must surface for review instead of becoming silent sends.
 const f=fixture(t,{model:async(p,d)=>p.includes('Create a concise')?'# Profile':JSON.stringify({text:d.source,warnings:['Needs context']})});
 assert.equal((await f.hub.call('owner','contact_send',input)).status,'needs_review');assert.equal(f.stats().sends,0);
 const c=f.hub.contactAgent.book.get('sasha');f.hub.contactAgent.book.put({...c,allowSend:false});
 await assert.rejects(f.hub.call('owner','contact_send',{...input,requestId:'blocked'}),/contact_outbound_blocked/);
});

test('fresh unknown recipient is discovered and profiled without caller-side files',async t=>{
 // With a supplied channel and one exact provider result, one call completes the new-contact workflow.
 const f=fixture(t);
 const c=f.hub.contactAgent.book.get('sasha');
 // The existing contact belongs to another exact identity; provider discovery is authoritative for 101.
 f.hub.contactAgent.book.put({...c,name:'Другой',aliases:[],endpoints:[{...f.endpoint,conversationId:'202'}]});
 const result=await f.hub.call('owner','contact_prepare',{...input,recipient:'Александр',connectionId:'a'});
 assert.equal(result.status,'prepared');assert.equal(result.endpoint.conversationId,'101');assert.equal(f.hub.contactAgent.book.all().length,2);
 assert.equal(f.stats().sends,0);
});

test('delivery reconciles a crash between transport receipt and smart ledger update without sending',async t=>{
 // A persisted provider receipt is usable evidence; absence of a receipt is never non-delivery proof.
 const f=fixture(t);await f.hub.call('owner','contact_send',input);
 const identity=JSON.stringify(['owner','r1']),book=f.hub.contactAgent.book;
 book.saveOperation(identity,{...book.operation(identity),status:'sending',messageId:null});
 const r=await f.hub.call('owner','contact_delivery',{requestId:'r1'});
 assert.equal(r.status,'sent');assert.equal(r.messageId,'sent-1');assert.equal(f.stats().sends,1);
});

test('preview cannot follow an endpoint reassigned to a different address-book identity',async t=>{
 // Editing contacts between preview and send must not silently change who the reviewed message targets.
 const f=fixture(t),book=f.hub.contactAgent.book;await f.hub.call('owner','contact_prepare',input);
 const old=book.get('sasha');book.put({...old,endpoints:[{...f.endpoint,conversationId:'other'}]});
 book.put({id:'different-person',name:'Другой человек',endpoints:[f.endpoint]});
 await assert.rejects(f.hub.call('owner','contact_send',input),/recipient_changed/);assert.equal(f.stats().sends,0);
});

test('rich preview freezes format and markup, accepts rendered links, and uses a separate long-text limit',async t=>{
 // A Telegram-like provider supports rich reports above the plain 4096 limit; retries keep the reviewed format.
 const f=fixture(t,{model:async(p,d)=>p.includes('Create a concise')?'# Profile':JSON.stringify({text:`<h2>Результат</h2><p>Стоимость 100, <a href="https://example.com/report">отчёт</a></p><details><summary>Подробности</summary><p>${'а'.repeat(4500)}</p></details>`,format:'rich_html',warnings:[]})});
 Object.assign(f.hub.instances.get('a').capabilities,{formats:['plain','rich_markdown','rich_html'],maxRichText:30000});
 const result=await f.hub.call('owner','contact_prepare',input);
 assert.equal(result.status,'prepared');assert.equal(result.format,'rich_html');assert.ok(result.text.length>4096);
 await f.hub.call('owner','contact_send',input);await f.hub.call('owner','contact_send',input);
 assert.equal(f.seen[0].format,'rich_html');assert.equal(f.seen[0].text,result.text);assert.equal(f.stats().sends,1);
 await assert.rejects(f.hub.call('owner','contact_send',{...input,format:'plain'}),/idempotency_conflict/);
 const identity=JSON.stringify(['owner','r1']),book=f.hub.contactAgent.book;
 book.saveOperation(identity,{...book.operation(identity),status:'sending'});
 assert.equal((await f.hub.call('owner','contact_delivery',{requestId:'r1'})).status,'sent');
});

test('explicit plain and unsupported channel cannot be silently upgraded to Rich Messages',async t=>{
 // Format capability checks happen before dispatch, and an LLM cannot override a caller's explicit plain mode.
 const f=fixture(t,{model:async(p,d)=>p.includes('Create a concise')?'# Profile':JSON.stringify({text:d.source,format:'rich_markdown',warnings:[]})});
 assert.equal((await f.hub.call('owner','contact_prepare',{...input,format:'rich_html'})).error,'format_unsupported');
 Object.assign(f.hub.instances.get('a').capabilities,{formats:['plain','rich_markdown'],maxRichText:30000});
 const r=await f.hub.call('owner','contact_send',{...input,requestId:'plain',format:'plain'});assert.equal(r.stylePreparation.reason,'rewrite_format_invalid');
 assert.equal(f.stats().sends,1);assert.equal(f.seen[0].format,'plain');assert.equal(f.seen[0].text,input.text);
 await assert.rejects(f.hub.call('owner','send_raw',{connectionId:'b',conversationId:'101',requestId:'raw-rich',text:'## Report',format:'rich_html'}),/format_unsupported/);
});

test('rich literal guard preserves prices and URL query strings through markup',async t=>{
 // Markup h2 and HTML escaping are not new facts, but modified amounts and links are.
 const {hub}=fixture(t);const guard=(a,b)=>hub.contactAgent.validateText(a,b,'rich_html');
 guard('Цена 100 https://example.com/?a=1&b=2','<h2>Цена 100</h2><a href="https://example.com/?a=1&amp;b=2">Открыть</a>');
 guard('Цена 100 https://example.com/report','## Цена 100\n[Открыть](https://example.com/report)');
 assert.throws(()=>guard('Цена 100','<h2>Цена 200</h2>'),/rewrite_changed/);
 assert.throws(()=>guard('https://example.com/?a=1','<a href="https://example.com/?a=2">Ссылка</a>'),/rewrite_changed/);
});

test('explicit endpoint and self bypass ambiguous names; lookup and conflict expose only authorized identity',async t=>{
 // A namesake must never outrank an already linked exact route, including the account's Saved Messages.
 const f=fixture(t);f.hub.config.connections.a.plugin='telegram';f.hub.config.connections.a.settings.selfId='101';
 const c=await f.hub.call('owner','contact_resolve',{recipient:'Избранное',connectionId:'a'});assert.equal(c.contact.id,'sasha');
 assert.equal((await f.hub.call('owner','contact_resolve',{recipient:'Another label',connectionId:'a',conversationId:'101'})).contact.id,'sasha');
 const search=await f.hub.call('owner','contact_search',{connectionId:'a',conversationId:'101'});assert.equal(search.items[0].id,'sasha');
 await assert.rejects(f.hub.call('owner','contact_save',{id:'duplicate',name:'Name',endpoints:[f.endpoint]}),e=>e.code==='endpoint_already_linked'&&e.details.contactId==='sasha');
 await assert.rejects(f.hub.call('limited','contact_resolve',{recipient:'self',connectionId:'b',conversationId:'101'}),/not_authorized/);
});

test('failed preparation exposes safe stage and can retry the same payload without sending twice',async t=>{
 // Malformed history must not collapse into an opaque failure or leak values from the provider.
 const f=fixture(t),instance=f.hub.instances.get('a'),original=instance.history;
 instance.history=async()=>({items:[{secret:'do-not-leak'}],next:null,complete:true});
 const failed=await f.hub.call('owner','contact_send',input);
 assert.equal(failed.diagnostic.stage,'history');assert.equal(failed.error,'validation_failed');assert.ok(failed.diagnostic.correlationId);
 assert.equal(JSON.stringify(failed).includes('do-not-leak'),false);assert.equal(f.stats().sends,0);
 instance.history=original;
 const done=await f.hub.call('owner','contact_send',{...input,retryPreparation:true});assert.equal(done.status,'sent');
 await f.hub.call('owner','contact_send',{...input,retryPreparation:true});assert.equal(f.stats().sends,1);
});

test('unsupported format rejects before history/profile/model and gives consistent retry identity policy',async t=>{
 // Formatting is a caller-input error, not a profile failure or an invitation to retry unchanged HTML.
 const f=fixture(t),v={...input,format:'rich_html'};
 const r=await f.hub.call('owner','contact_prepare',v);
 assert.equal(r.status,'failed');assert.equal(r.error,'format_unsupported');assert.equal(r.diagnostic.stage,'format_validation');assert.equal(r.diagnostic.retryable,false);assert.equal(r.canRetryPreparation,false);assert.deepEqual(r.diagnostic.allowedFormats,['plain']);assert.match(r.diagnostic.nextAction,/NEW requestId/);assert.deepEqual(f.stats(),{reads:0,generations:0,sends:0});
 await assert.rejects(f.hub.call('owner','contact_prepare',{...v,format:'plain'}),/idempotency_conflict/);
 assert.equal((await f.hub.call('owner','contact_prepare',{...v,format:'plain',requestId:'corrected'})).status,'prepared');
 // A persisted pre-upgrade failure gets the same public correction without extra model/provider calls.
 const op=f.hub.contactAgent.book.operation(JSON.stringify(['owner','r1']));op.diagnostic.stage='profile';op.canRetryPreparation=true;f.hub.contactAgent.book.saveOperation(JSON.stringify(['owner','r1']),op);
 const legacy=await f.hub.call('owner','contact_delivery',{requestId:'r1'});assert.equal(legacy.diagnostic.stage,'format_validation');assert.equal(legacy.canRetryPreparation,false);
});

test('rich preparation repairs a duplicated amount once and still freezes the accepted preview',async t=>{
 // The first draft repeats a protected amount in a heading and table. The second
 // may fix formatting only; its exact text remains the one reviewed and reused.
 const f=fixture(t,{model:async(p,d)=>p.includes('Create a concise')?'# Profile':JSON.stringify({text:`<h2>Готово${d.correction?'':' 100'}</h2><table><tr><td>Стоимость</td><td>100</td></tr></table><a href="https://example.com/report">https://example.com/report</a>`,format:'rich_html',warnings:[]})});
 Object.assign(f.hub.instances.get('a').capabilities,{formats:['plain','rich_html'],maxRichText:30000});
 const r=await f.hub.call('owner','contact_prepare',{...input,format:'rich_html'});assert.equal(r.status,'prepared');assert.equal(r.rewriteAttempts,2);assert.equal(f.stats().generations,3);assert.equal(f.stats().sends,0);
 const again=await f.hub.call('owner','contact_prepare',{...input,format:'rich_html'});assert.equal(again.text,r.text);assert.equal(f.stats().generations,3);
});
test('failed corrective rich draft is discarded after two attempts in favor of unchanged source',async t=>{
 // Discard the permanently altered price; an explicit format is preserved for the original.
 const f=fixture(t,{model:async(p,d)=>p.includes('Create a concise')?'# Profile':JSON.stringify({text:'<p>Стоимость 200 <a href="https://example.com/report">Отчёт</a></p>',format:'rich_html',warnings:[]})});
 Object.assign(f.hub.instances.get('a').capabilities,{formats:['plain','rich_html'],maxRichText:30000});
 const r=await f.hub.call('owner','contact_send',{...input,format:'rich_html'});assert.equal(r.status,'sent');assert.equal(r.stylePreparation.reason,'rewrite_changed_numbers_or_links');assert.equal(r.rewriteAttempts,2);assert.equal(f.stats().generations,3);assert.equal(f.stats().sends,1);assert.equal(f.seen[0].text,input.text);assert.equal(f.seen[0].format,'rich_html');
});

test('corrective rich generation cannot downgrade an auto-selected rich format to plain',async t=>{
 // Auto may initially choose plain, but a repair must retain the chosen rich transport.
 const f=fixture(t,{model:async(p,d)=>p.includes('Create a concise')?'# Profile':JSON.stringify(d.correction?{text:d.source,format:'plain',warnings:[]}:{text:'<p>200 <a href="https://example.com/report">Отчёт</a></p>',format:'rich_html',warnings:[]})});
 Object.assign(f.hub.instances.get('a').capabilities,{formats:['plain','rich_html'],maxRichText:30000});
 const r=await f.hub.call('owner','contact_prepare',input);assert.equal(r.status,'prepared');assert.equal(r.stylePreparation.reason,'rewrite_format_invalid');assert.equal(r.format,'plain');assert.equal(r.text,input.text);assert.equal(f.stats().sends,0);
});

test('invalid JSON gets one preparation repair; repeated malformed JSON never invokes send',async t=>{
 // Recover output-contract mistakes from the original source, without salvaging arbitrary prose.
 for(const repair of [true,false]){
  const f=fixture(t,{model:async(p,d)=>p.includes('Create a concise')?'# Profile':repair&&d.jsonRepair?JSON.stringify({text:d.source,warnings:[]}):'not JSON'});
  const r=await f.hub.call('owner','contact_prepare',{recipient:'Саша',text:'Привет',requestId:'json-repair'});
  assert.equal(r.status,'prepared');assert.equal(r.rewriteAttempts,2);assert.equal(f.stats().sends,0);
  if(!repair){assert.equal(r.stylePreparation.stage,'rewrite_parse');assert.equal(r.stylePreparation.reason,'rewrite_invalid_json');assert.equal(r.text,'Привет');}
 }
});

test('an unverified endpoint returns needs_recipient, not an internal preparation failure',async t=>{
 // The route in a discovery refusal is just a lookup hint, not an authorized contact snapshot.
 const f=fixture(t);const r=await f.hub.call('owner','contact_prepare',{recipient:'Unknown',connectionId:'a',conversationId:'999',requestId:'unknown-endpoint',text:'hello'});
 assert.equal(r.status,'needs_recipient');assert.equal(r.reason,'endpoint_not_verified');assert.equal(f.stats().sends,0);
});

test('plain preparation repairs changed protected literals once without sending',async t=>{
 // Plain report should have the same fact-preserving recovery as rich, without dropping guard.
 const f=fixture(t,{model:async(p,d)=>p.includes('Create a concise')?'# Profile':JSON.stringify({text:d.correction?d.source:d.source.replace('100','200'),format:'plain',warnings:[]})});
 const r=await f.hub.call('owner','contact_prepare',input);assert.equal(r.status,'prepared');assert.equal(r.text,input.text);assert.equal(r.rewriteAttempts,2);assert.equal(f.stats().sends,0);
});


test('reply outside recent history resolves exact cached source and preserves replyTo',async t=>{
 // Style-window absence is not deletion: the already cached reply target needs no provider lookup.
 const f=fixture(t,{model:async(p,d)=>{if(p.includes('Create a concise'))return '# Profile';assert.equal(d.recentHistory.replyTarget.id,'older');return JSON.stringify({text:d.source,warnings:[]});}});
 f.hub.cache.observe('a',{id:'older',conversationId:'101',direction:'inbound',senderId:'sasha',at:'2026-09-01T00:00:00Z',text:'old question',replyTo:null,attachments:[],kind:'message'});
 const r=await f.hub.call('owner','contact_send',{...input,replyTo:'older'});
 assert.equal(r.status,'sent');assert.equal(f.seen[0].replyTo,'older');assert.equal(f.stats().reads,1);
 await f.hub.call('owner','contact_send',{...input,replyTo:'older'});assert.equal(f.stats().sends,1);
});

test('reply cache miss uses exact provider lookup; preparation remains send-free',async t=>{
 // An explicit preparation can recover an old target without fetching unrelated conversations.
 let lookups=0;
 const f=fixture(t,{message:async v=>{lookups++;assert.equal(v.conversationId,'101');assert.equal(v.messageId,'older');return {id:'older',conversationId:'101',direction:'inbound',senderId:'sasha',at:'2026-09-01T00:00:00Z',text:'question',replyTo:null,attachments:[],kind:'message'};}});
 const r=await f.hub.call('owner','contact_prepare',{...input,replyTo:'older'});
 assert.equal(r.status,'prepared');assert.equal(r.replyTo,'older');assert.equal(lookups,1);assert.equal(f.stats().sends,0);
});

test('paged reply lookup finds target beyond the recent hundred messages',async t=>{
 // Provider adapters without an exact method retain the bounded paginated message_get fallback.
 const f=fixture(t,{history:async v=>({items:[{id:v.cursor?'older':'1',conversationId:v.conversationId,direction:'inbound',senderId:'sasha',at:'2026-09-01T00:00:00Z',text:'question'}],next:v.cursor?null:'page2',complete:!!v.cursor})});
 const r=await f.hub.call('owner','contact_prepare',{...input,replyTo:'older'});assert.equal(r.status,'prepared');assert.equal(f.stats().reads,3);assert.equal(f.stats().sends,0);
});

test('unavailable quote falls back once, while cross-route evidence still blocks',async t=>{
 // Owner policy: quote availability cannot hold up text to the confirmed peer.
 const absent=fixture(t);const v={...input,replyTo:'missing'};
 const r=await absent.hub.call('owner','contact_send',v);
 assert.equal(r.status,'sent');assert.equal(r.replyFallback.reason,'reply_target_unavailable');assert.equal(absent.seen[0].replyTo,null);
 await absent.hub.call('owner','contact_send',v);assert.equal(absent.stats().sends,1);
 const wrong=fixture(t,{message:async()=>({id:'older',conversationId:'other',attachments:[]})});
 const w=await wrong.hub.call('owner','contact_send',{...input,replyTo:'older'});assert.equal(w.error,'provider_route_mismatch');assert.equal(wrong.stats().sends,0);
});

test('reply omitted by style text budget remains available as a marked excerpt',async t=>{
 // A long source cannot vanish as a reply identity merely because style context is bounded.
 const f=fixture(t,{history:async v=>({items:[{id:'long',conversationId:v.conversationId,direction:'inbound',senderId:'sasha',at:'2026-09-01T00:00:00Z',text:'x'.repeat(61000)}],next:null,complete:true}),model:async(p,d)=>{if(p.includes('Create a concise'))return '# Profile';assert.equal(d.recentHistory.replyTarget.id,'long');assert.equal(d.recentHistory.replyTarget.textTruncated,true);assert.equal(d.recentHistory.replyTarget.text.length,30000);return JSON.stringify({text:d.source,warnings:[]});}});
 assert.equal((await f.hub.call('owner','contact_prepare',{...input,replyTo:'long'})).status,'prepared');assert.equal(f.stats().reads,1);assert.equal(f.stats().sends,0);
});

test('deleted exact reply prepares unchanged text without a quote or source substitution',async t=>{
 // A deletion is a presentation fallback, never permission to change recipient.
 const f=fixture(t);f.hub.cache.observe('a',{id:'older',conversationId:'101',direction:'inbound',senderId:'sasha',at:'2026-09-01T00:00:00Z',text:null,deletedAt:'2026-10-15T00:00:00Z',attachments:[]});
 const v={...input,replyTo:'older'};const preview=await f.hub.call('owner','contact_prepare',v);
 assert.equal(preview.status,'prepared');assert.equal(preview.replyTo,null);assert.equal(preview.replyFallback.reason,'reply_target_deleted');assert.equal(f.stats().sends,0);
 assert.equal((await f.hub.call('owner','contact_send',v)).status,'sent');assert.equal(f.seen[0].conversationId,'101');assert.equal(f.seen[0].text,input.text);
 await f.hub.call('owner','contact_send',v);assert.equal(f.stats().sends,1);
});

test('strict rewrite schema applies to initial and bounded repair but not profile',async t=>{
 // Malformed compatible-provider output still requires the same strict repair,
 // and a syntactically valid repair cannot discard a protected amount.
 const contracts=[];
 const f=fixture(t,{model:async(p,d,o)=>{contracts.push(o);if(p.includes('Create a concise'))return '# Profile';return d.jsonRepair?JSON.stringify({text:'changed',format:'plain',warnings:[]}):'bad JSON';}});
 const r=await f.hub.call('owner','contact_send',{recipient:'Саша',requestId:'structured-unsafe',text:'Стоимость 100'});
 assert.equal(contracts[0],undefined);for(const o of contracts.slice(1)){assert.equal(o.jsonSchema.additionalProperties,false);assert.deepEqual(o.jsonSchema.required,['text','format','warnings']);}
 assert.equal(r.status,'sent');assert.equal(r.stylePreparation.reason,'rewrite_changed_numbers_or_links');assert.equal(r.rewriteAttempts,2);assert.equal(f.stats().sends,1);assert.equal(f.seen[0].text,'Стоимость 100');
});


test('style provider failure freezes original preview and sends it without another model call',async t=>{
 // Network/auth/model failures during optional rewrite cannot hold an authorized source hostage.
 const f=fixture(t,{model:async(p)=>{if(p.includes('Create a concise'))return '# Profile';throw new Error('private provider body must not leak');}});
 const v={...input,replyTo:'1'},r=await f.hub.call('owner','contact_prepare',v);
 assert.equal(r.status,'prepared');assert.equal(r.text,v.text);assert.equal(r.format,'plain');assert.equal(r.stylePreparation.status,'original_fallback');assert.equal(f.stats().sends,0);
 assert.equal(JSON.stringify(r).includes('private provider body'),false);
 const before=f.stats().generations;
 await Promise.all([f.hub.call('owner','contact_send',v),f.hub.call('owner','contact_send',v)]);
 assert.equal(f.stats().generations,before);assert.equal(f.stats().sends,1);assert.equal(f.seen[0].replyTo,'1');assert.equal(f.seen[0].text,v.text);
 const receipt=await f.hub.call('owner','contact_delivery',{requestId:v.requestId});assert.equal(receipt.stylePreparation.status,'original_fallback');
});

test('fallback keeps ambiguous send unknown and never retries transport',async t=>{
 // A lost transport response is not a styling failure and must not trigger a second send.
 const f=fixture(t,{model:async(p)=>p.includes('Create a concise')?'# Profile':'bad JSON',send:async()=>{throw new Error('lost receipt');}});
 const first=await f.hub.call('owner','contact_send',input);assert.equal(first.status,'unknown');assert.equal(first.text,input.text);
 assert.equal((await f.hub.call('owner','contact_send',input)).status,'unknown');assert.equal(f.stats().sends,1);assert.equal(f.stats().generations,3);
});

test('malformed rewrite shape falls back but oversized original still fails source validation',async t=>{
 // Only candidate output is disposable; provider source constraints cannot be bypassed.
 const f=fixture(t,{model:async(p)=>p.includes('Create a concise')?'# Profile':JSON.stringify({text:42,warnings:[]})});
 const r=await f.hub.call('owner','contact_prepare',input);assert.equal(r.status,'prepared');assert.equal(r.stylePreparation.reason,'validation_failed');assert.equal(r.text,input.text);
 const bad=await f.hub.call('owner','contact_send',{...input,requestId:'too-long-source',text:'x'.repeat(4100)});
 assert.equal(bad.status,'failed');assert.equal(bad.error,'text_too_long');assert.equal(bad.diagnostic.stage,'source_validation');assert.equal(f.stats().sends,0);
});


test('long auto source uses existing native rich transport without rewriting or truncation',async t=>{
 // Failed styling must not force a supported long report into Telegram's shorter plain limit.
 const f=fixture(t,{model:async(p)=>p.includes('Create a concise')?'# Profile':'bad JSON'});
 Object.assign(f.hub.instances.get('a').capabilities,{formats:['plain','rich_markdown'],maxRichText:30000});
 const v={...input,text:'Точный отчёт: '+ 'текст '.repeat(1000)},r=await f.hub.call('owner','contact_send',v);
 assert.equal(r.status,'sent');assert.equal(r.text,v.text);assert.equal(r.format,'rich_markdown');assert.equal(f.seen[0].text,v.text);assert.equal(f.stats().sends,1);
});


test('failed profile generation sends only the original and never saves a fake profile',async t=>{
 // A first-contact style-model outage must not block sending; authorization still precedes generation.
 const f=fixture(t,{model:async()=>{throw new Error('private model failure');}});
 const r=await f.hub.call('owner','contact_send',input);assert.equal(r.status,'sent');assert.equal(r.text,input.text);assert.equal(r.rewriteAttempts,0);assert.equal(r.stylePreparation.stage,'profile_generation');
 assert.equal(f.stats().generations,1);assert.equal(f.stats().sends,1);assert.equal(f.hub.contactAgent.book.profile('person:sasha'),null);assert.equal(JSON.stringify(r).includes('private model failure'),false);
});

test('changed URL fallback survives reopening the durable operation database',async t=>{
 // Recovery must retain the exact source and fallback receipt, never the model's redirected URL.
 const f=fixture(t,{model:async(p,d)=>p.includes('Create a concise')?'# Profile':JSON.stringify({text:d.source.replace('example.com','other.invalid'),warnings:[]})});
 const r=await f.hub.call('owner','contact_prepare',input);assert.equal(r.stylePreparation.reason,'rewrite_changed_numbers_or_links');
 const reopened=new ContactBook(f.root);
 try{const stored=reopened.operation(JSON.stringify(['owner',input.requestId]));assert.equal(stored.status,'prepared');assert.equal(stored.text,input.text);assert.deepEqual(stored.stylePreparation,r.stylePreparation);}finally{reopened.close();}
 assert.equal(f.stats().sends,0);
});


test('explicit same smart send resumes fenced provider without rewrite or preview expiry',async t=>{
 // A portal SSH failure predates submission. Repeating the original source/key
 // may resume only a provider with a durable fence; read-only delivery cannot.
 let resumes=0,seen;
 const f=fixture(t,{send:async()=>{throw new HubError('portal_transport_failed');},resumeSend:async v=>{resumes++;seen=v;return {status:'sent',messageId:'recovered'};}});
 assert.equal((await f.hub.call('owner','contact_send',input)).status,'unknown');
 const identity=JSON.stringify(['owner',input.requestId]);
 const op=f.hub.contactAgent.book.operation(identity);
 f.hub.contactAgent.book.saveOperation(identity,{...op,preparedAt:'2000-01-01T00:00:00Z'});
 const before=f.stats();
 assert.equal((await f.hub.call('owner','contact_delivery',{requestId:input.requestId})).status,'unknown');assert.equal(resumes,0);
 const recovered=await f.hub.call('owner','contact_send',input);
 assert.equal(recovered.status,'sent');assert.equal(recovered.messageId,'recovered');
 assert.equal(resumes,1);assert.equal(seen.text,op.text);assert.equal(seen.requestId,f.seen[0].requestId);
 assert.equal(f.stats().generations,before.generations);assert.equal(f.stats().sends,1);
 assert.equal((await f.hub.call('owner','contact_send',input)).messageId,'recovered');assert.equal(resumes,1);
 await assert.rejects(f.hub.call('owner','contact_send',{...input,text:'changed'}),/idempotency_conflict/);
});

test('raw recovery coalesces concurrent retries and preserves stored effective reply',async t=>{
 // Process-local calls join one recovery; server-side fence handles separate
 // processes. The original optional quote decision must not be recomputed.
 let resumes=0,release;
 const gate=new Promise(r=>{release=r;});
 const f=fixture(t,{send:async()=>{throw new HubError('portal_transport_failed');},resumeSend:async v=>{resumes++;assert.equal(v.replyTo,null);await gate;return {status:'sent',messageId:'one'};}});
 const v={connectionId:'a',conversationId:'101',requestId:'raw-recovery',text:'exact',replyTo:null};
 assert.equal((await f.hub.call('owner','send',v)).status,'unknown');
 const first=f.hub.call('owner','send',v),second=f.hub.call('owner','send',v);
 await new Promise(r=>setImmediate(r));assert.equal(resumes,1);release();
 assert.equal((await first).messageId,'one');assert.equal((await second).messageId,'one');assert.equal(f.stats().sends,1);
 await assert.rejects(f.hub.call('reader','send',v),/not_authorized/);
 await assert.rejects(f.hub.call('owner','send',{...v,text:'changed'}),/idempotency_conflict/);
});

test('lost recovery response reconciles created receipt without another native write',async t=>{
 // The fake provider creates once but drops its reply. Native receipt lookup
 // resolves that crash window; another explicit retry must return the same ID.
 let created=false,resumes=0;
 const f=fixture(t,{send:async()=>{throw new HubError('portal_transport_failed');},resumeSend:async()=>{resumes++;created=true;throw new HubError('portal_transport_failed');},reconcile:async()=>created?{status:'sent',messageId:'native-id'}:{status:'unknown',messageId:null}});
 await f.hub.call('owner','contact_send',input);
 assert.equal((await f.hub.call('owner','contact_send',input)).messageId,'native-id');
 assert.equal((await f.hub.call('owner','contact_send',input)).messageId,'native-id');assert.equal(resumes,1);
});

test('ambiguous native submission fence remains unknown and cannot reenter recovery',async t=>{
 // A durable submitting record without a receipt is evidence of uncertainty,
 // not proof of failure. Both journals must remain intact and block another Add.
 let resumes=0;
 const f=fixture(t,{send:async()=>{throw new HubError('portal_transport_failed');},resumeSend:async()=>{resumes++;throw new HubError('portal_send_ambiguous');}});
 await f.hub.call('owner','contact_send',input);
 assert.equal((await f.hub.call('owner','contact_send',input)).status,'unknown');
 assert.equal((await f.hub.call('owner','contact_send',input)).status,'unknown');assert.equal(resumes,1);assert.equal(f.stats().sends,1);
});

test('provider receipt resolves an old unknown without entering recovery',async t=>{
 // A lost original response may already have created the report. Read-only
 // receipt reconciliation wins before invoking any fenced writer again.
 let found=false,resumes=0;
 const f=fixture(t,{send:async()=>{throw new HubError('portal_transport_failed');},resumeSend:async()=>{resumes++;return {status:'sent',messageId:'wrong'};},reconcile:async()=>found?{status:'sent',messageId:'already-created'}:{status:'unknown',messageId:null}});
 const first=await f.hub.call('owner','contact_send',input);assert.equal(first.canRetrySend,true);
 found=true;
 assert.equal((await f.hub.call('owner','contact_send',input)).messageId,'already-created');assert.equal(resumes,0);
});

test('temporary recovery storage refusal preserves original unknown and permits a later fenced attempt',async t=>{
 // Unavailable private storage cannot authorize Add, but fixing its availability
 // must not permanently poison a transport-unknown request with a new key.
 let resumes=0;
 const f=fixture(t,{send:async()=>{throw new HubError('portal_transport_failed');},resumeSend:async()=>{resumes++;if(resumes===1)throw new HubError('portal_recovery_storage_unavailable');return {status:'sent',messageId:'recovered'};}});
 await f.hub.call('owner','contact_send',input);
 const unavailable=await f.hub.call('owner','contact_send',input);assert.equal(unavailable.status,'unknown');assert.equal(unavailable.canRetrySend,true);
 assert.equal((await f.hub.call('owner','contact_send',input)).messageId,'recovered');assert.equal(resumes,2);assert.equal(f.stats().sends,1);
});
