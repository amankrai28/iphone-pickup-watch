import {batchSourceUrl,orderUrl,products,stores} from './apple.mjs';

export const NATIVE_MAX_BYTES=6*1024*1024;
const allowed=new Set([batchSourceUrl(),...products.map(orderUrl)]);
const safeHeaders=['date','age','cache-control','retry-after','content-type'];

// Preserve the exact Apple evidence the validator reads, without uploading a
// megabyte of unrelated product-page markup on a time-sensitive stock drop.
export function compactSourceBody(url,body){
 if(url===batchSourceUrl()){
  try{
   const data=JSON.parse(body);if(!Array.isArray(data?.body?.stores))return body;
   return JSON.stringify({body:{stores:data.body.stores.filter(row=>stores.some(store=>store.id===row?.storeNumber)).map(row=>({storeNumber:row.storeNumber,retailStore:{lastFetched:row.retailStore?.lastFetched},partsAvailability:Object.fromEntries(products.flatMap(product=>{
    const part=row.partsAvailability?.[product.part];if(!part)return [];
    const regular=part.messageTypes?.regular;
    return [[product.part,{partNumber:part.partNumber,storePickEligible:part.storePickEligible,pickupSearchQuote:part.pickupSearchQuote,messageTypes:{regular:{storeSelectionEnabled:regular?.storeSelectionEnabled,storePickupProductTitle:regular?.storePickupProductTitle}}}]];
   }))}))}});
  }catch{return body;}
 }
 if(products.some(product=>orderUrl(product)===url)){
  const scripts=[...body.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi)].map(match=>match[0]);
  return scripts.join('\n')+'\n'+(body.match(/Connect to any carrier later/)?.[0]||'');
 }
 throw Error('Unexpected source URL.');
}

// The owner's collector forwards only responses from the three fixed public URLs.
// The Worker replays them through its existing strict parser; it never accepts an
// agent-supplied AVAILABLE verdict, destination URL, price or push message.
export function replaySourceFrames(frames){
 if(!Array.isArray(frames)||frames.length<1||frames.length>3)throw Error('Invalid native response count.');
 const seen=new Set();
 for(const frame of frames){
  if(!frame||!allowed.has(frame.url)||seen.has(frame.url))throw Error('Unexpected native source URL.');
  seen.add(frame.url);
  if(typeof frame.body!=='string'||frame.body.length>NATIVE_MAX_BYTES)throw Error('Invalid native response body.');
  if(frame.error!==undefined){if(frame.error!=='network_error')throw Error('Invalid native source error.');}
  else if(!Number.isInteger(frame.status)||frame.status<200||frame.status>599)throw Error('Invalid native HTTP status.');
  if(!frame.headers||typeof frame.headers!=='object'||Array.isArray(frame.headers)||Object.entries(frame.headers).some(([key,value])=>!safeHeaders.includes(key)||typeof value!=='string'||value.length>1024))throw Error('Invalid native response headers.');
 }
 if(frames[0].url!==batchSourceUrl())throw Error('The combined inventory response must be first.');
 const remaining=new Map(frames.map(frame=>[frame.url,frame]));
 return async url=>{
  const frame=remaining.get(url);if(!frame)throw Error('Native response missing; availability is UNKNOWN.');
  remaining.delete(url);
  if(frame.error)throw Error('Native Apple connection failed.');
  return new Response(frame.status===204||frame.status===205||frame.status===304?null:frame.body,{status:frame.status,headers:frame.headers});
 };
}

export function captureSourceFrames(fetcher=fetch){
 const frames=[],requested=new Set();
 return {frames,fetcher:async(url,options)=>{
  if(!allowed.has(url)||requested.has(url)||requested.size>=3)throw Error('Unexpected or duplicate source request.');
  requested.add(url);
  let response;
  try{response=await fetcher(url,options);}catch(error){frames.push({url,error:'network_error',body:'',headers:{}});throw error;}
  const headers=Object.fromEntries(safeHeaders.flatMap(key=>response.headers.has(key)?[[key,response.headers.get(key)]]:[]));
  let body='';
  try{
   const reader=response.body?.getReader(),decoder=new TextDecoder();let bytes=0;
   if(reader){for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>NATIVE_MAX_BYTES){await reader.cancel();throw Error('Apple response exceeded the size limit.');}body+=decoder.decode(value,{stream:true});}body+=decoder.decode();}
  }catch(error){frames.push({url,error:'network_error',body:'',headers:{}});throw error;}
  if(response.status===200)body=compactSourceBody(url,body);
  frames.push({url,status:response.status,headers,body});
  return new Response(response.status===204||response.status===205||response.status===304?null:body,{status:response.status,headers});
 }};
}
