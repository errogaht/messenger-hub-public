import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {appendFile} from 'node:fs/promises';

/** Synthetic stdio bridge only: the ledger observes calls across child process
 * lifetimes. It never loads Hub configuration, credentials or provider clients. */
const ledger=process.argv[2];
let releaseWrite;
const server=new Server({name:'isolated-upstream-fixture',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(CallToolRequestSchema,async({params})=>{
 const held=params.name==='held_write'?new Promise(resolve=>{releaseWrite=resolve;}):null;
 await appendFile(ledger,JSON.stringify({pid:process.pid,name:params.name})+'\n');
 // Model a lost transport after the fake operation has started. The Hub caller
 // cannot know its effect and must never retry it inside the same invocation.
 if(params.name.endsWith('_and_disconnect'))process.exit(0);
 if(held)await held;
 if(params.name==='release_write')releaseWrite?.();
 return {content:[{type:'text',text:JSON.stringify({pid:process.pid,name:params.name})}]};
});
await server.connect(new StdioServerTransport());
