import {readFile,stat} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';

/** Project installations receive only a scoped credential, never the hub's master configuration. */
async function main(){
 const filename=process.env.MESSENGER_HUB_CREDENTIAL;
 if(!filename||(await stat(filename)).mode&0o077)throw new Error('private_credential_required');
 const {url,token}=JSON.parse(await readFile(filename,'utf8'));
 if(!url?.startsWith('http://127.0.0.1:')||typeof token!=='string')throw new Error('credential_invalid');
 const upstream=new Client({name:'messenger-hub-scope',version:'0.1.0'});
 await upstream.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
 const server=new Server({name:'messenger-hub',version:upstream.getServerVersion()?.version??'unknown'},{capabilities:{tools:{}}});
 server.setRequestHandler(ListToolsRequestSchema,()=>upstream.listTools());
 // A ten-minute settled wait needs transport headroom; unrelated tools retain
 // their existing timeout. This never retries an interrupted tool call.
 server.setRequestHandler(CallToolRequestSchema,request=>upstream.callTool(request.params,undefined,{timeout:request.params.name==='messenger_wait_for_settled_message'?630000:240000}));
 await server.connect(new StdioServerTransport());
 process.stdin.once('end',()=>void upstream.close());
}
main().catch(()=>{process.stderr.write('messenger-hub scoped connection failed\n');process.exitCode=1;});
