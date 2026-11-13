import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {profileIdentities,findIdentityProfile} from '../src/profiles.mjs';
test('new WhatsApp profiles resolve exact aliases without matching body mentions',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hub-profile-'));
 const markdown='---\nwhatsapp_jids:\n  - "111@s.whatsapp.net"\n  - "222@lid"\nkind: direct\n---\nA mention of 333@s.whatsapp.net is not identity.';
 try{
  await fs.writeFile(path.join(root,'person.md'),markdown);
  assert.deepEqual(profileIdentities(markdown,'whatsapp_jids'),['111@s.whatsapp.net','222@lid']);
  assert.equal(await findIdentityProfile(root,'whatsapp_jids','333@s.whatsapp.net'),null);
  assert.equal(await findIdentityProfile(root,'whatsapp_jids','222@lid'),path.join(root,'person.md'));
  await fs.writeFile(path.join(root,'ambiguous.md'),markdown);
  await assert.rejects(findIdentityProfile(root,'whatsapp_jids','222@lid'),/ambiguous/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
