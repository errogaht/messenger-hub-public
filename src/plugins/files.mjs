import {open,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {HubError} from '../contracts.mjs';

/** Provider paths are data. Resolve relative paths against their private root, never the process cwd. */
export async function boundedPath(filename,root,maxBytes=25*1024*1024){
 const allowed=await realpath(root),resolved=await realpath(path.resolve(allowed,filename));
 if(!resolved.startsWith(allowed+path.sep))throw new HubError('attachment_path_denied');
 const metadata=await stat(resolved);if(!metadata.isFile()||metadata.size<1||metadata.size>maxBytes)throw new HubError('attachment_size_invalid');
 const mime={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.ogg':'audio/ogg','.oga':'audio/ogg','.aac':'audio/aac','.opus':'audio/ogg','.mp3':'audio/mpeg','.wav':'audio/wav','.flac':'audio/flac','.m4a':'audio/mp4','.mp4':'video/mp4','.webm':'video/webm','.pdf':'application/pdf','.txt':'text/plain','.zip':'application/zip'}[path.extname(resolved).toLowerCase()]??'application/octet-stream';
 return {path:resolved,size:metadata.size,filename:path.basename(resolved),mimeType:mime};
}
/** Legacy base64 compatibility remains capped; new file downloads return a private path instead. */
export async function boundedFile(filename,root){
 const metadata=await boundedPath(filename,root),file=await open(metadata.path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const bytes=await file.readFile();if(bytes.length>25*1024*1024)throw new HubError('attachment_size_invalid');return {base64:bytes.toString('base64'),filename:metadata.filename,mimeType:metadata.mimeType};}finally{await file.close();}
}
