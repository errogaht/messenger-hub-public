import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile);
const helper=fileURLToPath(new URL('../src/plugins/bitrix-send-fence.php',import.meta.url));
const uuid='12345678-1234-4123-a123-123456789012';
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'hub-bitrix-fence-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,run:async code=>(await exec('php',['-r',`require $argv[1]; $dir=$argv[2]; $uuid=$argv[3]; ${code}`,helper,dir,uuid])).stdout};}

test('PHP fence serializes independent processes and returns the already created ID',async t=>{
 // Each process represents an SSH worker. Even overlapping retries may invoke
 // the fake native Add only once, then the second observes its durable ID.
 const f=await fixture(t);
 const code=`$f=new HubBitrixSendFence($dir,$uuid,'same'); $id=$f->messageId(); if($id===null){$f->beforeSubmit();file_put_contents($dir.'/adds','x',FILE_APPEND);usleep(100000);$f->created(321);$id=321;} echo $id;`;
 assert.deepEqual(await Promise.all([f.run(code),f.run(code)]),['321','321']);assert.equal(await readFile(path.join(f.dir,'adds'),'utf8'),'x');
});

test('PHP fence preserves crash uncertainty and rejects changed payload identity',async t=>{
 // A worker disappearing after its write-ahead checkpoint may have created a
 // message. Never treat an absent reply or missing UUID as permission to Add.
 const f=await fixture(t);
 await f.run(`$f=new HubBitrixSendFence($dir,$uuid,'same');$f->beforeSubmit();`);
 assert.equal(await f.run(`$f=new HubBitrixSendFence($dir,$uuid,'same');try{$f->beforeSubmit();}catch(Throwable $e){echo $e->getMessage();}`),'portal_send_ambiguous');
 assert.equal(await f.run(`try{$f=new HubBitrixSendFence($dir,$uuid,'different');}catch(Throwable $e){echo $e->getMessage();}`),'request_id_conflict');
});

test('PHP fence allows pre-submission retry and retains a known ID without UUID',async t=>{
 // Constructing a worker before submission is side-effect free for the native
 // chat. A successful Add ID remains usable even if its UUID receipt is lost.
 const f=await fixture(t);
 await f.run(`$f=new HubBitrixSendFence($dir,$uuid,'same');`);
 await f.run(`$f=new HubBitrixSendFence($dir,$uuid,'same');$f->beforeSubmit();$f->created(456);`);
 assert.equal(await f.run(`$f=new HubBitrixSendFence($dir,$uuid,'same');echo $f->messageId();`),'456');
});


test('PHP fence never mistakes a damaged checkpoint for an absent submission',async t=>{
 // JSON null, truncated writes and an invalid created ID all mean uncertainty.
 // None may reopen the native-Add gate after a worker crash/storage problem.
 const f=await fixture(t);
 for(const value of ['null','{','{}','{"digest":"same","stage":"created","messageId":0}']){
  const code=`file_put_contents($dir.'/'.$uuid.'.json',base64_decode($argv[4]));try{$f=new HubBitrixSendFence($dir,$uuid,'same');$f->beforeSubmit();echo 'unsafe';}catch(Throwable $e){echo $e->getMessage();}`;
  const result=await exec('php',['-r',`require $argv[1];$dir=$argv[2];$uuid=$argv[3];${code}`,helper,f.dir,uuid,Buffer.from(value).toString('base64')]);
  assert.equal(result.stdout,'portal_send_ambiguous');
 }
});
