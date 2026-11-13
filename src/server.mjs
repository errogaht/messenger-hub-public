import {diagnostic} from './errors.mjs';
import {runtimeInfo} from './version.mjs';
import http from 'node:http';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {readFile,stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {configSchema,loadPlugins,Hub} from './hub.mjs';
import {Store} from './store.mjs';
import {createMcp} from './mcp.mjs';
import {HubError} from './contracts.mjs';

/** Loopback HTTP with mandatory bearer auth; browser origins are rejected before any body or tool. */
export function createHttp(hub){
 const streams=new Set();
 const server=http.createServer(async(req,res)=>{
  const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  if(req.headers.origin||!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host??''))return reply(403,{error:'origin_denied'});
  if(req.url==='/health'&&req.method==='GET')return reply(200,{service:'messenger-hub',version:1,...runtimeInfo()});
  // GOWA authenticates the exact raw body with its existing HMAC mechanism.
  // Bindings are disabled by default and never infer an account from payload.
  const hook=/^\/api\/v1\/webhook\/([a-zA-Z0-9_.:-]+)$/.exec(req.url??'');
  if(req.method==='POST'&&hook){try{hub.native.binding(hook[1],'gowa_webhook');let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1000000)throw new HubError('request_too_large');chunks.push(chunk);}reply(200,hub.native.webhook(hook[1],Buffer.concat(chunks),req.headers['x-hub-signature-256']));}catch(e){reply(403,{error:e instanceof HubError?e.code:'native_payload_invalid',diagnostic:diagnostic(e,'native_ingest')});}return;}
  let scope;
  try{scope=hub.authenticate(req.headers.authorization?.replace(/^Bearer /,''));}catch{return reply(401,{error:'unauthorized'});}
  if(req.method==='GET'&&req.url==='/api/v1/schema'){const facade=createMcp(hub,scope);const schema=await hub.call(scope,'schema');await facade.close();return reply(200,{httpContractVersion:1,readContractVersion:1,...schema});}
  if(req.method==='POST'&&(req.url==='/api/v1/call'||req.url?.startsWith('/api/v1/ingest/'))){try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1000000)throw new HubError('request_too_large');chunks.push(chunk);}const body=JSON.parse(Buffer.concat(chunks).toString());
   if(req.url.startsWith('/api/v1/ingest/'))return reply(200,hub.native.accept(scope,req.url.slice('/api/v1/ingest/'.length),body));
   const allowed=['video_thumbnail','video_prepare','video_status','video_read','video_frames','message_mark','message_mark_result','health','identity','connections','conversations','topics','history','message_get','message_context','search_messages','schema','subscription_status','subscription_save','inbox_projects','inbox_consumer_ensure','inbox_replay','inbox_claim','inbox_ack','inbox_context','inbox_event_get','inbox_diagnostics','file_download','files_download','transcription_status','transcribe_media','media_stage','send_raw','send_media','delivery','media_delivery'];
   if(!allowed.includes(body.method))throw new HubError('api_method_not_allowed');return reply(200,{httpContractVersion:1,result:await hub.call(scope,body.method,body.input??{})});
  }catch(e){return reply(400,{error:e instanceof HubError?e.code:'validation_failed',diagnostic:diagnostic(e,'local_api')});}}
  // Ordinary local push is independent of MCP Events. Only journal identifiers
  // cross this stream; scoped replay/claim fetch bodies and ack stays separate.
  const url=new URL(req.url,'http://127.0.0.1');
  if(req.method==='GET'&&url.pathname==='/inbox/events'){
   let last=req.headers['last-event-id']??url.searchParams.get('cursor'),busy=false,closed=false,blocked=false;
   const consumerId=url.searchParams.get('consumerId');
   const close=()=>{if(closed)return;closed=true;hub.inbox.changes.off('observed',wake);streams.delete(res);res.end();};
   const wake=()=>{if(busy||closed||blocked)return;busy=true;try{
    // Each drain resumes from the last written durable token. A slow reader
    // causes backpressure, never an unbounded in-memory body queue.
    while(!closed){const frames=hub.inbox.read.notifications(scope,consumerId,last);if(!frames.length)break;
     for(const frame of frames){last=frame.id;if(!res.write(`id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)){blocked=true;res.once('drain',()=>{blocked=false;wake();});return;}}
     if(frames.length<100)break;
    }
   }catch{close();}finally{busy=false;}};
   try{
    // Validate grants/cursor before headers; rejected subscriptions cannot hang.
    hub.inbox.read.notifications(scope,consumerId,last,1);
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});res.flushHeaders();streams.add(res);res.once('close',close);hub.inbox.changes.on('observed',wake);wake();
   }catch(e){reply(403,{error:e instanceof HubError?e.code:'inbox_request_invalid',diagnostic:diagnostic(e,'inbox_push')});}return;
  }
  if(req.method==='POST'&&url.pathname==='/inbox/read'){
   try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>20000)throw new HubError('request_too_large');chunks.push(chunk);}const {method,input}=JSON.parse(Buffer.concat(chunks).toString());if(!['inbox_projects','inbox_replay','inbox_context','inbox_diagnostics','inbox_event_get','subscription_status'].includes(method))throw new HubError('read_method_invalid');reply(200,await hub.call(scope,method,input));}catch(e){reply(400,{error:e instanceof HubError?e.code:'invalid_request',diagnostic:diagnostic(e,'inbox_read')});}return;
  }
  // File UUIDs are routing handles, never public bearer capabilities. Recheck this caller's grants.
  if(req.method==='GET'&&/^\/files\/[0-9a-f-]{36}$/.test(req.url??'')){
   try{
    if(!hub.media)throw new Error();const f=await hub.media.download(scope,req.url.slice(7));
    res.writeHead(200,{'Content-Type':f.mimeType??'application/octet-stream','Content-Length':f.size,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
    await pipeline(createReadStream(f.path),res);
   }catch{if(!res.headersSent)reply(404,{error:'file_unavailable'});else res.destroy();}return;
  }
  if(req.method!=='POST'||req.url!=='/mcp')return reply(404,{error:'not_found'});
  let server,transport;
  try{
   let size=0;const chunks=[];
   for await(const chunk of req){size+=chunk.length;if(size>1000000)throw new HubError('request_too_large');chunks.push(chunk);}
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   server=createMcp(hub,scope);transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
   res.once('close',()=>{void transport.close();void server.close();});
   await server.connect(transport);await transport.handleRequest(req,res,body);
  }catch(e){if(!res.headersSent)reply(e instanceof HubError?413:400,{error:'invalid_request'});else res.end();}
 });
 // Shutdown persistent sockets before server.close, otherwise graceful restart
 // would wait forever for an external clerk that keeps its stream connected.
 server.closeInboxStreams=()=>{for(const res of streams)res.end();};
 return server;
}

export async function main(){
 const filename=process.env.MESSENGER_HUB_CONFIG;
 if(!filename)throw new HubError('config_required');
 if((await stat(filename)).mode&0o077)throw new HubError('config_permissions_must_be_0600');
 const config=configSchema.parse(JSON.parse(await readFile(filename,'utf8')));
 const hub=new Hub(config,await loadPlugins(config),new Store(config.store));
 // Durable subscription collection belongs to this service, not MCP callers.
 const server=createHttp(hub);hub.inbox.start();
 server.listen(config.port,'127.0.0.1',()=>process.stdout.write(`messenger-hub ready on loopback:${config.port}\n`));
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.closeInboxStreams();server.close(()=>void hub.close().then(()=>process.exit(0)));});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{process.stderr.write('messenger-hub startup_failed\n');process.exitCode=1;});
