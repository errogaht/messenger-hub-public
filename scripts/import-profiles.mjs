import {readFile,readdir,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {ContactBook,endpointKey} from '../src/contact-book.mjs';
import {profileIdentities} from '../src/profiles.mjs';

/** Import exact legacy identities, never merge contacts by a display name. Re-runs preserve owner edits. */
export async function importProfiles(config,book){
 let imported=0,skipped=0;const unresolved=[];
 for(const [connectionId,c] of Object.entries(config.connections)){
  if(!['telegram','whatsapp'].includes(c.plugin)||!c.settings.profileRoot)continue;
  const root=await realpath(c.settings.profileRoot);
  for(const name of (await readdir(root)).filter(n=>n.endsWith('.md')&&n!=='README.md')){
   const filename=await realpath(path.join(root,name));if(!filename.startsWith(root+path.sep))continue;
   const meta=await stat(filename);if(!meta.isFile()||meta.size>100000){unresolved.push({connectionId,file:name,reason:'file_size'});continue;}
   const markdown=await readFile(filename,'utf8');
   const ids=c.plugin==='telegram'?[(/^(-?\d+)-/.exec(name)??[])[1]].filter(Boolean):profileIdentities(markdown,'whatsapp_jids');
   if(!ids.length){unresolved.push({connectionId,file:name,reason:'no_exact_identity'});continue;}
   const endpoints=ids.map(conversationId=>({connectionId,conversationId,kind:c.plugin==='telegram'?(conversationId.startsWith('-')?'group':'direct'):(conversationId.endsWith('@g.us')?'group':'direct'),label:''}));
   const owners=endpoints.map(e=>book.byEndpoint(e));
   if(owners.some(Boolean)){skipped++;continue;}
   const display=/^display_name:\s*["']?([^\n"']+)["']?\s*$/m.exec(markdown)?.[1];
   const heading=/^#\s+(.+)$/m.exec(markdown)?.[1];
   const title=(display??heading??name.replace(/\.md$/,'')).replace(/^Профиль(?: общения| контакта)?\s*[:—-]\s*/i,'').trim();
   const filenameAlias=name.replace(/^(?:-?\d+|lid-\d+|group-[^-]+)-/,'').replace(/\.md$/,'').replaceAll('-',' ');
   const aliases=[...new Set([filenameAlias,...profileIdentities(markdown,'aliases')])].filter(a=>a&&a!==title);
   const contactId='import-'+createHash('sha256').update(endpointKey(endpoints[0])).digest('hex').slice(0,24);
   const contact=book.put({id:contactId,name:title,aliases,allowSend:!/не использовать для исходящих/i.test(title),endpoints:endpoints.map(e=>({...e,label:title}))});
   const profileIdentity=endpoints[0].kind==='direct'?'person:'+contact.id:'conversation:'+endpointKey(endpoints[0]);
   book.setProfile(profileIdentity,markdown,endpoints.map(({connectionId,conversationId})=>({connectionId,conversationId})));
   imported++;
  }
 }
 return {imported,skipped,unresolved,total:book.all().length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const config=JSON.parse(await readFile(process.argv[2],'utf8'));
  if(!config.assistant?.root)throw new Error('assistant_root_required');
  const book=new ContactBook(config.assistant.root);
  try{console.log(JSON.stringify(await importProfiles(config,book)));}finally{book.close();}
 }catch{process.stderr.write('Profile import failed; inspect private configuration.\n');process.exitCode=1;}
}
