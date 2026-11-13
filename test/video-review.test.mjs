import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Hub} from '../src/hub.mjs';
import {Store} from '../src/store.mjs';
import {createHttp} from '../src/server.mjs';
import {createMcp} from '../src/mcp.mjs';

async function fixture(t,{core,source}={}){
 const root=await mkdtemp(path.join(tmpdir(),'hub-video-'));let downloads=0,thumbs=0;
 const plugin={create:()=>({capabilities:{history:true,send:false,attachments:true,changes:false,kinds:['message']},conversations:async()=>({items:[],next:null}),history:async()=>({items:[],next:null,complete:true}),attachment:async()=>{downloads++;return {base64:source?(await readFile(source)).toString('base64'):Buffer.from('synthetic-video').toString('base64'),mimeType:'video/mp4',filename:'clip.mp4'};},videoThumbnail:async()=>{thumbs++;return {status:'ready',base64:Buffer.from('synthetic-thumbnail').toString('base64'),mimeType:'image/jpeg',width:1,height:1,video:{durationSeconds:2,width:64,height:48}};}})};
 const config={version:1,store:':memory:',plugins:{fake:'/fake'},connections:{a:{plugin:'fake',label:'A',settings:{}}},scopes:{owner:{token:'o'.repeat(40),connections:{a:{read:true,send:false,conversations:['chat']}}},other:{token:'x'.repeat(40),connections:{a:{read:true,send:false,conversations:['other']}}}},media:{root},videoReview:{enabled:true,pollMs:100}};
 const hub=new Hub(config,{fake:plugin},new Store(':memory:'),{videoReview:core?{core}:undefined});
 const f=hub.media.register('a',{id:'1',conversationId:'chat',direction:'inbound',senderId:'s',at:'2026-10-10T00:00:00Z',text:'',attachments:[]},{id:'message:1',kind:'video',filename:'clip.mp4',mimeType:'video/mp4',size:100});
 t.after(async()=>{if(!hub.media.closed)await hub.close();await rm(root,{recursive:true,force:true});});return {hub,root,config,plugin,id:f.id,stats:()=>({downloads,thumbs})};
}

test('thumbnail never downloads original; scoped derivative streams use existing file endpoint',async t=>{
 // A cold chat may show its native poster without downloading/admitting any video/ASR.
 const f=await fixture(t,{core:async()=>{throw new Error('no core on preview');}});
 const result=await f.hub.call('owner','video_thumbnail',{fileId:f.id});assert.equal(result.status,'ready');assert.equal(f.stats().downloads,0);
 const again=await f.hub.call('owner','video_thumbnail',{fileId:f.id});assert.equal(again.thumbnail.fileId,result.thumbnail.fileId);assert.equal(f.stats().thumbs,1);
 await assert.rejects(f.hub.call('other','video_thumbnail',{fileId:f.id}),/not_authorized/);
 await assert.rejects(f.hub.call('other','file_download',{fileId:result.thumbnail.fileId}),/not_authorized/);
 const server=createHttp(f.hub);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const url=`http://127.0.0.1:${server.address().port}/files/${result.thumbnail.fileId}`;
 assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{Authorization:'Bearer '+'x'.repeat(40)}})).status,404);
 assert.equal((await fetch(url,{headers:{Authorization:'Bearer '+'o'.repeat(40)}})).status,200);
 assert.equal(f.stats().downloads,0);
});

test('explicit prepare shares job, paginates complete cues and keeps status/read inert',async t=>{
 // Injected core represents shared paid state: consumer concurrency cannot create more prepares.
 let calls=0,ready=false;const cues=[{start:0,end:1,text:'first'},{start:1,end:2,text:'second'}];
 const f=await fixture(t,{core:async p=>{if(p.action==='settings')return {model:'fake'};if(p.action==='prepare'){calls++;await new Promise(r=>setTimeout(r,20));ready=true;}if(p.action==='read')return {segments:cues.slice(p.offset,p.offset+p.limit),offset:p.offset,nextOffset:p.offset+1<2?p.offset+1:null,total:2};return {status:ready?'ready':'queued',segmentCount:ready?2:0};}});
 await assert.rejects(f.hub.call('other','video_prepare',{fileId:f.id}),/not_authorized/);assert.equal(calls,0);
 await Promise.all([f.hub.call('owner','video_prepare',{fileId:f.id,waitMs:1000}),f.hub.call('owner','video_prepare',{fileId:f.id,waitMs:1000})]);assert.equal(calls,1);assert.equal(f.stats().downloads,1);
 const status=await f.hub.call('owner','video_status',{fileId:f.id});assert.equal(status.status,'ready');assert.equal(f.hub.media.metadata(f.hub.media.get(f.id)).video.status,'ready');assert.equal(calls,1);
 const page=await f.hub.call('owner','video_read',{fileId:f.id,offset:0,limit:1});assert.equal(page.nextOffset,1);assert.equal(page.segments[0].text,'first');
 assert.equal((await f.hub.call('owner','video_read',{fileId:f.id,offset:1,limit:1})).nextOffset,null);assert.equal(calls,1);
 createMcp(f.hub,'owner');for(const name of ['thumbnail','prepare','status','read','frames'])assert.ok(f.hub.schemaInfo.get('owner').tools.some(t=>t.name==='messenger_video_'+name));
});

test('shared legacy cache read-through and unknown submission never start another paid request',async t=>{
 // Existing local artifacts are accessible after source authorization without a Hub job/POST.
 let prepares=0;
 const f=await fixture(t,{core:async p=>p.action==='settings'?{model:'fake'}:p.action==='prepare'?(prepares++,{status:'submission_unknown',error:{code:'video_submission_unknown',retryable:false}}):{status:'ready',segments:[{start:0,end:1,text:'legacy'}],total:1,nextOffset:null}});
 await f.hub.call('owner','file_download',{fileId:f.id});
 assert.equal((await f.hub.call('owner','video_status',{fileId:f.id})).status,'ready');assert.equal((await f.hub.call('owner','video_read',{fileId:f.id})).segments[0].text,'legacy');assert.equal(prepares,0);
 await f.hub.call('owner','video_prepare',{fileId:f.id,waitMs:1000});await f.hub.call('owner','video_prepare',{fileId:f.id,waitMs:1000});assert.equal(prepares,1);
});

test('real silent video core yields visual-only ready and bounded full-resolution cropped derivatives',async t=>{
 // Real FFmpeg/core, synthetic silent pixels only: no token/network/paid ASR is necessary.
 const root=await mkdtemp(path.join(tmpdir(),'silent-video-')),source=path.join(root,'clip.mp4');t.after(()=>rm(root,{recursive:true,force:true}));
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=blue:size=64x48:rate=10','-t','1','-c:v','mpeg4','-y',source]);
 const f=await fixture(t,{source});await assert.rejects(f.hub.call('owner','video_frames',{fileId:f.id,timestamps:[0]}),/video_not_cached/);
 const ready=await f.hub.call('owner','video_prepare',{fileId:f.id,waitMs:30000});assert.equal(ready.status,'ready');assert.equal(ready.hasAudio,false);assert.equal(ready.segmentCount,0);
 const frames=await f.hub.call('owner','video_frames',{fileId:f.id,timestamps:[0.1,0.3],crop:{x:2,y:2,width:32,height:24}});assert.equal(frames.frames.length,2);assert.equal(frames.frames[0].width,32);
 const png=await f.hub.call('owner','file_download',{fileId:frames.frames[0].fileId});assert.equal(png.mimeType,'image/png');assert.equal(png.sha256,frames.frames[0].sha256);
 await assert.rejects(f.hub.call('other','video_read',{fileId:f.id}),/not_authorized/);
 await assert.rejects(f.hub.call('owner','video_frames',{fileId:f.id,timestamps:[1.1]}),/video_input_invalid/);
});


test('Hub restart resumes selected pending job with its frozen profile and cached original',async t=>{
 // Pending admission survives daemon restart; changed settings cannot initiate a different paid profile.
 const f=await fixture(t,{core:async p=>p.action==='settings'?{model:'frozen'}:{status:'transcribing',taskKnown:true}});
 await f.hub.call('owner','video_prepare',{fileId:f.id});
 for(let n=0;n<100&&f.hub.video.get(f.id)?.status!=='transcribing';n++)await new Promise(r=>setTimeout(r,5));
 assert.equal(f.hub.video.get(f.id).settings.model,'frozen');await f.hub.close();
 let resumed=0;
 const restarted=new Hub(f.config,{fake:f.plugin},new Store(':memory:'),{videoReview:{core:async p=>{assert.notEqual(p.action,'settings');assert.equal(p.settings.model,'frozen');if(p.action==='prepare')resumed++;return {status:'ready',taskKnown:true,segmentCount:1};}}});
 try{for(let n=0;n<100&&restarted.video.get(f.id)?.status!=='ready';n++)await new Promise(r=>setTimeout(r,5));assert.equal(restarted.video.get(f.id).status,'ready');assert.equal(resumed,1);assert.equal(f.stats().downloads,1);}finally{await restarted.close();}
});

test('legacy download refusal resumes after original recovery, keeping profile and one core admission',async t=>{
 // Original failed before ASR, then file_download recovered it. Repeating
 // prepare must not keep that obsolete failure or launch duplicate paid work.
 let prepares=0;
 const f=await fixture(t,{core:async p=>{assert.notEqual(p.action,'settings');assert.equal(p.settings.model,'frozen');if(p.action==='prepare')prepares++;return {status:prepares?'ready':'queued',segmentCount:prepares?1:0};}});
 f.hub.video.save({fileId:f.id,scope:'owner',settings:{model:'frozen'},status:'failed',progress:{phase:'failed'},error:{code:'upstream_unavailable',retryable:false}});
 await f.hub.call('owner','file_download',{fileId:f.id});
 const before=await f.hub.call('owner','video_status',{fileId:f.id});assert.equal(before.status,'failed');assert.equal(before.canResume,true);assert.equal(before.error.retryable,true);assert.equal(prepares,0);
 const results=await Promise.all([f.hub.call('owner','video_prepare',{fileId:f.id,waitMs:1000}),f.hub.call('owner','video_prepare',{fileId:f.id,waitMs:1000})]);
 assert.equal(prepares,1);assert.equal(f.stats().downloads,1);for(const r of results){assert.equal(r.status,'ready');assert.equal(r.error,undefined);}
 assert.equal(f.hub.video.get(f.id).recovery.reason,'original_download_recovered');assert.equal(f.hub.video.get(f.id).coreStarted,true);
});

test('cached original never reopens failed or unknown paid preparation',async t=>{
 // A downloaded source alone is no proof that a previous POST failed. Durable
 // core-entry/sha and unknown fences take precedence over generic error codes.
 let prepares=0;
 const f=await fixture(t,{core:async p=>p.action==='settings'?{}:p.action==='prepare'?(prepares++,{status:'ready'}):{status:'queued'}});
 await f.hub.call('owner','file_download',{fileId:f.id});
 for(const saved of [{status:'failed',coreStarted:true},{status:'failed',sha256:'known'},{status:'submission_unknown'}]){
  f.hub.video.save({fileId:f.id,scope:'owner',settings:{model:'frozen'},...saved,error:{code:'upstream_unavailable',retryable:false}});
  const result=await f.hub.call('owner','video_prepare',{fileId:f.id,waitMs:10});assert.equal(result.status,saved.status);
 }
 assert.equal(prepares,0);
});

test('real headless factual error manifests are returned, never used as diagnostic error codes',async t=>{
 // Unknown/failed paid receipts are valid status objects, not thrown Error.code
 // objects. Exercise the actual Python->Node boundary without any paid/network IO.
 const {runVideoCore}=await import('../src/video-review.mjs');const root=await mkdtemp(path.join(tmpdir(),'video-status-')),source=path.join(root,'source.bin');await writeFile(source,'synthetic');
 const previous=process.env.VIDEO_REVIEW_CACHE;process.env.VIDEO_REVIEW_CACHE=path.join(root,'cache');t.after(async()=>{if(previous===undefined)delete process.env.VIDEO_REVIEW_CACHE;else process.env.VIDEO_REVIEW_CACHE=previous;await rm(root,{recursive:true,force:true});});
 const settings={submit_url:'http://127.0.0.1:1/fake',status_url:'http://127.0.0.1:1/{task_id}',model:'fake',fast_inference:true};
 for(const state of ['submission_unknown','failed']){
  execFileSync('python3',['-c',"import sys,json;sys.path.insert(0,sys.argv[1]);import core;d,sha,_=core.identity(core.Path(sys.argv[2]),json.loads(sys.argv[3]));core.save(d/'source.json',{'sha256':sha,'has_audio':True});core.save(d/'task.json',{'state':sys.argv[4]})",path.resolve('video-review'),source,JSON.stringify(settings),state]);
  const result=await runVideoCore({action:'status',source,settings},{});assert.equal(result.status,state);assert.equal(typeof result.error.code,'string');assert.equal(result.error.retryable,false);
 }
});
