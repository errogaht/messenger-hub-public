/** Emit full data once. The history pager measures this exact MCP result envelope,
 * so escaping and the short text summary count toward its serialized budget. */
export function toolResult(result,imageContent=null){
 // Binary image data belongs in a native MCP image block, never in text or
 // structured JSON. Hub/API attachment responses keep their existing base64.
 const {base64,...metadata}=result;
 if(base64&&['image/jpeg','image/png','image/webp','image/gif'].includes(result.mimeType)){
  if(base64.length<=Math.ceil(8*1024*1024/3)*4)imageContent={type:'image',data:base64,mimeType:result.mimeType};
  result={...metadata,imageContent:imageContent?'inline':'omitted_size_limit'};
 }
 return {content:[{type:'text',text:JSON.stringify({result:'See structuredContent',...(result.status?{status:result.status}:{}),...(result.items?{items:result.items.length}:{})})},...(imageContent?[imageContent]:[])],structuredContent:result};}
export const resultChars=result=>JSON.stringify(toolResult(result)).length;
