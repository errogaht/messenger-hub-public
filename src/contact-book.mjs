import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {id,ref,HubError,key} from './contracts.mjs';

export const endpointSchema=z.object({connectionId:id,conversationId:ref,kind:z.enum(['direct','group','channel','calls','email']),label:z.string().max(2000).default('')}).strict();
export const contactSchema=z.object({id:id,name:z.string().min(1).max(500),aliases:z.array(z.string().min(1).max(500)).max(100).default([]),endpoints:z.array(endpointSchema).min(1).max(100),allowSend:z.boolean().default(true),revision:z.number().int().nonnegative().default(0)}).strict();
export const normalize=value=>value.normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё','е').replace(/[^\p{L}\p{N}@]+/gu,' ').trim();
export const endpointKey=e=>key(e.connectionId,e.conversationId);
/** Typo tolerance only ranks suggestions; it is never sufficient to authorize a recipient choice. */
function nearToken(a,b){
 if(a===b||a.startsWith(b)&&b.length>=4||b.startsWith(a)&&a.length>=4)return true;
 if(Math.min(a.length,b.length)<5||Math.abs(a.length-b.length)>1)return false;
 let previous=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){const row=[i];for(let j=1;j<=b.length;j++)row[j]=Math.min(row[j-1]+1,previous[j]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1));previous=row;}
 return previous[b.length]<=1;
}


/** Private address book: exact endpoint ownership, Markdown profiles, FTS names. No provider credentials. */
export class ContactBook {
 constructor(root){
  this.root=path.resolve(root);mkdirSync(this.root,{recursive:true,mode:0o700});chmodSync(this.root,0o700);
  this.db=new DatabaseSync(path.join(root,'contacts.sqlite'));chmodSync(path.join(root,'contacts.sqlite'),0o600);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY, body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS endpoints(route TEXT PRIMARY KEY,contact TEXT NOT NULL);
   CREATE VIRTUAL TABLE IF NOT EXISTS names USING fts5(id UNINDEXED,words,tokenize='unicode61');
   CREATE TABLE IF NOT EXISTS operations(identity TEXT PRIMARY KEY,digest TEXT NOT NULL,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS profiles(identity TEXT PRIMARY KEY,sources TEXT NOT NULL,filename TEXT NOT NULL);
  `);
 }
 all(){return this.db.prepare('SELECT body FROM contacts ORDER BY id').all().map(r=>JSON.parse(r.body));}
 get(id){const row=this.db.prepare('SELECT body FROM contacts WHERE id=?').get(id);return row?JSON.parse(row.body):null;}
 byEndpoint(e){const row=this.db.prepare('SELECT contact FROM endpoints WHERE route=?').get(endpointKey(e));return row?this.get(row.contact):null;}
 /** Revision checks prevent lost edits; an endpoint can never silently move to another person. */
 put(input){
  const c=contactSchema.parse(input),old=this.get(c.id);
  if((old?.revision??0)!==c.revision)throw new HubError('contact_revision_conflict');
  if(new Set(c.endpoints.map(endpointKey)).size!==c.endpoints.length)throw new HubError('duplicate_endpoint');
  c.revision++;
  this.db.exec('BEGIN IMMEDIATE');
  try{
   for(const e of c.endpoints){const owner=this.byEndpoint(e);if(owner&&owner.id!==c.id)throw new HubError('endpoint_already_linked',{contactId:owner.id,endpoint:{connectionId:e.connectionId,conversationId:e.conversationId}});}
   this.db.prepare('DELETE FROM endpoints WHERE contact=?').run(c.id);
   for(const e of c.endpoints)this.db.prepare('INSERT INTO endpoints VALUES(?,?)').run(endpointKey(e),c.id);
   this.db.prepare('INSERT INTO contacts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(c.id,JSON.stringify(c));
   this.db.prepare('DELETE FROM names WHERE id=?').run(c.id);
   this.db.prepare('INSERT INTO names VALUES(?,?)').run(c.id,normalize([c.name,...c.aliases].join(' ')));
   this.db.exec('COMMIT');return c;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 /** Explicit owner merge only. Existing operation snapshots retain their original destination. */
 merge(targetId,sourceId,targetRevision,sourceRevision){
  const target=this.get(targetId),source=this.get(sourceId);
  if(!target||!source||targetId===sourceId)throw new HubError('contact_merge_invalid');
  if(target.revision!==targetRevision||source.revision!==sourceRevision)throw new HubError('contact_revision_conflict');
  const combined=contactSchema.parse({...target,revision:target.revision+1,
   aliases:[...new Set([...target.aliases,source.name,...source.aliases])].filter(n=>n!==target.name),
   endpoints:[...target.endpoints,...source.endpoints],allowSend:target.allowSend&&source.allowSend});
  const profiles=[this.profile('person:'+targetId),this.profile('person:'+sourceId)].filter(Boolean);
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.db.prepare('DELETE FROM contacts WHERE id=?').run(sourceId);
   this.db.prepare('UPDATE endpoints SET contact=? WHERE contact=?').run(targetId,sourceId);
   this.db.prepare('UPDATE contacts SET body=? WHERE id=?').run(JSON.stringify(combined),targetId);
   this.db.prepare('DELETE FROM names WHERE id IN (?,?)').run(targetId,sourceId);
   this.db.prepare('INSERT INTO names VALUES(?,?)').run(targetId,normalize([combined.name,...combined.aliases].join(' ')));
   if(profiles.length)this.setProfile('person:'+targetId,profiles.map(p=>p.markdown).join('\n\n---\n\n'),profiles.flatMap(p=>p.sources));
   this.db.exec('COMMIT');return combined;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 /** FTS is a local accelerator; callers filter authorization BEFORE ranking or limiting results. */
 search(query,visible){
  if(/^\+?[\d ()-]{7,}$/.test(query))query=query.replace(/\D/g,'');
  const q=normalize(query),tokens=q.split(' ').filter(Boolean);
  let fts=new Set();
  if(tokens.length)fts=new Set(this.db.prepare('SELECT id FROM names WHERE names MATCH ?').all(tokens.map(t=>'"'+t.replaceAll('"','')+'"*').join(' AND ')).map(x=>x.id));
  return this.all().map(visible).filter(Boolean).map(c=>{
   const names=[c.name,...c.aliases,...c.endpoints.flatMap(e=>[e.conversationId,e.conversationId.split('@')[0]])].map(normalize),exact=c.id===query||names.includes(q);
   const prefix=tokens.length&&names.some(n=>tokens.every(t=>n.split(' ').some(w=>nearToken(w,t))));
   return {...c,match:exact?'exact':prefix||fts.has(c.id)?'suggested':'none'};
  }).filter(c=>!q||c.match!=='none').sort((a,b)=>(a.match==='exact'?-1:0)-(b.match==='exact'?-1:0)||a.name.localeCompare(b.name)).slice(0,20);
 }
 filename(identity){return path.join(this.root,createHash('sha256').update(identity).digest('hex')+'.md');}
 profile(identity){
  const row=this.db.prepare('SELECT sources,filename FROM profiles WHERE identity=?').get(identity);
  if(!row)return null;
  const markdown=readFileSync(path.join(this.root,row.filename),'utf8');
  if(Buffer.byteLength(markdown)>100000)throw new HubError('profile_too_large');
  return {markdown,sources:JSON.parse(row.sources)};
 }
 /** Local Markdown edits are hot-read. Source routes stay in SQLite so edits cannot erase provenance. */
 setProfile(identity,markdown,sources){
  if(Buffer.byteLength(markdown)>100000)throw new HubError('profile_too_large');
  // Versioned files ensure a crash cannot pair new content with old authorization provenance.
  const filename=this.filename(identity).replace(/\.md$/,'.'+randomUUID()+'.md'),temp=filename+'.tmp';
  writeFileSync(temp,markdown,{mode:0o600});renameSync(temp,filename);
  this.db.prepare('INSERT INTO profiles VALUES(?,?,?) ON CONFLICT(identity) DO UPDATE SET sources=excluded.sources,filename=excluded.filename').run(identity,JSON.stringify(sources),path.basename(filename));
 }
 personality(){const p=path.join(this.root,'personality.md'),text=existsSync(p)?readFileSync(p,'utf8'):'';if(text.length>20000)throw new HubError('personality_too_large');return text;}
 setPersonality(text){const p=path.join(this.root,'personality.md'),temp=p+'.tmp';writeFileSync(temp,text,{mode:0o600});renameSync(temp,p);}
 /** A reservation precedes LLM work. Crashed operations stay blocked, never auto-resend. */
 reserve(identity,digest,body){
  const inserted=this.db.prepare('INSERT OR IGNORE INTO operations VALUES(?,?,?)').run(identity,digest,JSON.stringify(body)).changes;
  const row=this.db.prepare('SELECT * FROM operations WHERE identity=?').get(identity);
  if(row.digest!==digest)throw new HubError('idempotency_conflict');
  return {fresh:!!inserted,body:JSON.parse(row.body)};
 }
 operation(identity){const row=this.db.prepare('SELECT body FROM operations WHERE identity=?').get(identity);return row?JSON.parse(row.body):null;}
 saveOperation(identity,body){this.db.prepare('UPDATE operations SET body=? WHERE identity=?').run(JSON.stringify(body),identity);return body;}
 close(){this.db.close();}
}
