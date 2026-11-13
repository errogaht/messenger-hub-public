import {parseFragment} from 'parse5';
const urlPattern=/https?:\/\/[^\s<>"']+/g;
const numberPattern=/\b\d+(?:[.,:/-]\d+)*\b/g;
const proseUrl=value=>value.replace(/[)\]*`,.;!?]+$/g,'');
const blocks=new Set(['p','div','br','h1','h2','h3','h4','h5','h6','table','tr','td','th','li','ul','ol','details','summary','pre','blockquote']);

/** Compare semantic URL/number multisets, never globally deduplicate facts.
 * HTML is parsed as data (no fetch/execution). An anchor displaying its own href
 * is ONE link; two anchors remain TWO. Inline tags must not split one amount.
 * Attribute targets remain byte-exact after HTML entity decoding: no URL
 * normalization, percent decoding, query reordering or permissive equivalence. */
export function protectedLiterals(value){
 const urls=[];let text=value;
 if(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*|\/?)>/i.test(value)){
  const fragment=parseFragment(value),chunks=[],stack=[{node:fragment,skipText:false}];
  const visible=node=>{
   const values=[],pending=[node];
   while(pending.length){const n=pending.pop();if(n.nodeName==='#text')values.push(n.value);else pending.push(...(n.childNodes??[]).slice().reverse());}
   return values.join('');
  };
  while(stack.length){
   const {node,skipText,exit}=stack.pop(),name=node.tagName;
   if(exit){if(blocks.has(name))chunks.push(' ');continue;}
   if(node.nodeName==='#text'){if(!skipText)chunks.push(node.value);continue;}
   if(blocks.has(name))chunks.push(' ');
   const attrs=new Map((node.attrs??[]).map(a=>[a.name,a.value]));
   const target=attrs.get('href');
   for(const field of ['href','src']){const v=attrs.get(field);if(v&&/^https?:\/\//.test(v))urls.push(v);}
   // User-visible alt/title may contain protected facts; geometry/style attributes do not.
   for(const field of ['alt','title'])if(attrs.has(field))chunks.push(' '+attrs.get(field)+' ');
   const hideLabel=skipText||name==='a'&&/^https?:\/\//.test(target??'')&&visible(node).trim()===target;
   stack.push({node,exit:true});
   for(const child of (node.content?.childNodes??node.childNodes??[]).slice().reverse())stack.push({node:child,skipText:hideLabel});
  }
  text=chunks.join('');
 }
 // A Markdown link with its URL as label is the same semantic case. Keep other
 // label facts and every distinct occurrence; images retain their source URLs.
 text=text.replace(/!?\[([^\]\n]*)\]\((https?:\/\/[^\s]+?)(?:\s+["'][^"']*["'])?\)/g,(_,label,target)=>{urls.push(target);return label===target?' ':label;});
 text=text.replace(urlPattern,url=>{urls.push(proseUrl(url));return ' ';});
 return {urls:urls.sort(),numbers:[...text.matchAll(numberPattern)].map(m=>m[0]).sort()};
}
