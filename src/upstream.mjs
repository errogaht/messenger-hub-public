import {Agent,fetch as httpFetch} from 'undici';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {HubError} from './contracts.mjs';

/** Classify only Telegram READ rejections; format failures are never access
 * denials and this helper never changes write retry or receipt semantics. */
function telegramReadError(name,text){
 if(!['get_messages','get_message_context','get_media_info','hub_native_history','hub_native_message','hub_topic_history'].includes(name))return null;
 if(/ChannelPrivateError|CHANNEL_PRIVATE|UserBannedInChannelError|USER_BANNED_IN_CHANNEL|ChatAdminRequiredError|CHAT_ADMIN_REQUIRED/.test(text))return new HubError('conversation_access_denied');
 if(/UsernameNotOccupiedError|USERNAME_NOT_OCCUPIED/.test(text))return new HubError('conversation_not_found');
 if(/UsernameInvalidError|USERNAME_INVALID/.test(text))return new HubError('conversation_format_invalid');
 return new HubError('telegram_read_provider_failed');
}

/** Classify transport evidence without provider bodies or caller arguments.
 * Both handshake and tool deadlines matter: losing initialize must not be
 * mislabeled as a failed native history RPC that never reached the bridge. */
function transportFailure(error,operation,config,timeoutMs,phase){
 const timeout=error?.code===-32001||['TimeoutError','AbortError'].includes(error?.name)||/TIMEOUT/.test(error?.cause?.code??'');
 return new HubError(timeout?'upstream_timeout':'upstream_unavailable',{providerOperation:operation,transport:config.url?'http':'stdio',phase,failureType:timeout?'request_timeout':'transport_failure',...(timeout?{timeoutMs}:{})});
}

/** Connections reuse existing bridges; a scoped caller never controls executable, URL or account. */
export class Upstream {
  constructor(config){
    this.config=config;this.pending=null;this.httpPools=new WeakMap();
    // One bounded pool per provider transport, never the unbounded global
    // fetch dispatcher. Bursty/history metadata reads must not exhaust the
    // bridge's file descriptors; the long-lived GET stream occupies one slot.
    this.httpConnections=config.httpConnections??16;
    if(config.url&&(!Number.isInteger(this.httpConnections)||this.httpConnections<2||this.httpConnections>64))throw new HubError('upstream_http_connections_invalid');
  }
  async client(){
    if(!this.pending){
      // Defer construction until pending is assigned: even a synchronous failed
      // transport cannot let its close callback invalidate a newer connection.
      const pending=Promise.resolve().then(async()=>{
        const client=new Client({name:'messenger-hub',version:'0.1.0'});
        // A confirmed close retires only this transport. The failed call is never
        // retried here; a later independent operation may establish a new client.
        let agent;
        client.onclose=()=>{if(this.pending===pending)this.pending=null;void agent?.destroy().catch(()=>{});};
        const c=this.config;
        if(c.url){agent=new Agent({connections:this.httpConnections,pipelining:1});this.httpPools.set(client,agent);}
        const transport=c.url?new StreamableHTTPClientTransport(new URL(c.url),{fetch:(url,init)=>httpFetch(url,{...init,dispatcher:agent})}):new StdioClientTransport({command:c.command,args:c.args??[],cwd:c.cwd,env:c.env,stderr:'ignore'});
        try{await client.connect(transport);return client;}catch(e){await client.close().catch(()=>{});throw e;}
      }).catch(e=>{if(this.pending===pending)this.pending=null;throw transportFailure(e,'initialize',this.config,60000,'connect');});
      this.pending=pending;
    }
    return this.pending;
  }
  async call(name,args={},options={}){
    try{
      const result=await (await this.client()).callTool({name,arguments:args},undefined,{timeout:options.timeoutMs??60000});
      if(result.isError){
        const detail=(result.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
        // This exact Telegram RPC rejection proves no message was created;
        // arbitrary errors/timeouts never authorize a second write.
        if(/REPLY_MESSAGE_ID_INVALID|REPLY_MESSAGE_NOT_FOUND|ReplyMessageIdInvalidError/.test(detail))throw new HubError('reply_target_invalid',{messageCreated:false});
        if(/download_media|download/i.test(name)||args.action==='download_media'){
          if(/expired|expiration/i.test(detail))throw new HubError('attachment_expired');
          if(/(?:status code|HTTP)\s*:?\s*410\b/i.test(detail))throw new HubError('attachment_gone');
          if(/(?:status code|HTTP)\s*:?\s*404\b|not found/i.test(detail))throw new HubError('attachment_not_found');
          if(/decrypt|bad mac|hmac|integrity/i.test(detail))throw new HubError('attachment_decryption_failed');
          if(/(?:status code|HTTP)\s*:?\s*(401|403)\b|forbidden|permission/i.test(detail))throw new HubError('attachment_permission_denied');
          if(/timeout|timed out|connection|(?:status code|HTTP)\s*:?\s*(429|5\d\d)\b/i.test(detail))throw new HubError('attachment_temporarily_unavailable');
          throw new HubError('attachment_unavailable');
        }
        throw telegramReadError(name,detail)??new HubError('upstream_rejected');
      }
      // FastMCP may wrap the SAME provider error string in structuredContent.
      // Decode both wire encodings through one classifier so access errors do
      // not become misleading history-shape/ID errors in downstream adapters.
      let text;
      if(result.structuredContent){
        const value=result.structuredContent;
        if(Object.keys(value).length===1&&typeof value.result==='string')text=value.result;
        else return value;
      }else text=(result.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
      // Telegram's bridge can return a successful MCP envelope containing its
      // exact coded error prose. Classify that frame before JSON normalization;
      // ordinary message bodies containing the prose are not an error frame.
      const coded=/^An error occurred \(code: ([A-Z][A-Z0-9-]{0,79})\)\. Check mcp_errors\.log for details\.$/.exec(text.trim());
      if(coded){const error=telegramReadError(name,text)??new HubError('upstream_rejected');error.details={...error.details,providerOperation:name,providerErrorCode:coded[1]};throw error;}
      if(/^(Error|Failed)\b/i.test(text.trim())){if(/REPLY_MESSAGE_ID_INVALID|REPLY_MESSAGE_NOT_FOUND|ReplyMessageIdInvalidError/.test(text))throw new HubError('reply_target_invalid',{messageCreated:false});throw telegramReadError(name,text)??new HubError('upstream_rejected');}
      try{return JSON.parse(text);}catch{return text;}
    }catch(e){
      if(e instanceof HubError)throw e;
      // Preserve safe transport evidence rather than flattening a known request
      // timeout into an opaque outage. Never expose exception messages, URLs,
      // tool arguments or credentials, and never replay the failed operation.
      throw transportFailure(e,name,this.config,options.timeoutMs??60000,'request');
    }
  }
  /** Explicit shutdown owns the captured connection only; a delayed old close
   * must not erase a fresh pending connection created by another caller. */
  async close(){const pending=this.pending;if(!pending)return;try{const client=await pending;await client.close();await this.httpPools.get(client)?.destroy();}catch{}finally{if(this.pending===pending)this.pending=null;}}
}
