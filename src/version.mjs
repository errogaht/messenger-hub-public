import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
/** Snapshot loaded source at process start. Editing files cannot disguise an old running process. */
const root=fileURLToPath(new URL('../',import.meta.url));
function fingerprint(){const h=createHash('sha256');for(const dir of ['src','src/plugins','prompts','bridges','video-review'])for(const name of readdirSync(path.join(root,dir)).sort()){if(!/\.(mjs|md|php|py|patch)$/.test(name))continue;h.update(dir+'/'+name);h.update(readFileSync(path.join(root,dir,name)));}h.update(readFileSync(path.join(root,'video-review/references/defaults.json')));return h.digest('hex');}
const build=fingerprint();
export const serverInfo=Object.freeze({serverVersion:'0.9.0',downloadContractVersion:1,replyPolicyVersion:1,videoReviewContractVersion:1,markerContractVersion:1,asrContractVersion:2,mentionEvidenceVersion:1,inboxProvenanceVersion:1,httpContractVersion:1,readContractVersion:1,contractVersion:2,pluginContractVersion:1,buildId:build,startedAt:new Date().toISOString()});
export function runtimeInfo(){return {...serverInfo,sourceMatchesRunningBuild:fingerprint()===build};}
