import {readFile,readdir,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {HubError} from './contracts.mjs';

/** Exact frontmatter identities only; names and incidental mentions in the body never merge contacts. */
export function profileIdentities(markdown,field){
 if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field))throw new HubError('profile_field_invalid');
 const front=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1];if(!front)return [];
 const lines=front.split(/\r?\n/),start=lines.findIndex(line=>line===`${field}:`);if(start<0)return [];
 const values=[];
 for(const line of lines.slice(start+1)){
  if(line.trim()&&!/^\s/.test(line))break;
  const m=/^\s+-\s+(?:"([^"\\]*)"|'([^']*)'|([^\s#'"\[\]{}]+))\s*$/.exec(line);
  if(m)values.push(m[1]??m[2]??m[3]);
 }
 return values;
}

/** Discover profiles created by an existing skill without editing hub config or following outside symlinks. */
export async function findIdentityProfile(directory,field,identity){
 const root=await realpath(directory),names=(await readdir(root)).filter(n=>n.endsWith('.md'));
 if(names.length>2000)throw new HubError('profile_index_too_large');
 const matches=[];
 for(const name of names){
  const filename=await realpath(path.join(root,name));if(!filename.startsWith(root+path.sep))continue;
  const metadata=await stat(filename);if(!metadata.isFile()||metadata.size>100000)continue;
  if(profileIdentities(await readFile(filename,'utf8'),field).includes(identity))matches.push(filename);
 }
 if(matches.length>1)throw new HubError('profile_identity_ambiguous');
 return matches[0]??null;
}
