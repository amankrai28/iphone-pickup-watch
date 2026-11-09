import {INTERVAL,ERROR_RETRY_MS,STOCK_MAX_AGE_MS} from './config.mjs';
const BLOCK_COOLDOWN=20*60*1000;
export class UpstreamError extends Error {
 constructor(message,{retryMs=60000,serverRetryMs=0,hardStop=false,kind='upstream',httpStatus=null,sourceMeta=null}={}){super(message);Object.assign(this,{retryMs,serverRetryMs,hardStop,kind,httpStatus,sourceMeta});}
}
export function retryDelay(value,now){const seconds=Number(value);if(value&&Number.isFinite(seconds))return Math.max(0,seconds*1000);const date=Date.parse(value||'');return Number.isFinite(date)?Math.max(0,date-now):0;}
const diagnosticHeaderNames=['date','age','cache-control','retry-after','etag','last-modified','server','via','content-type','x-cache','cf-cache-status','x-rate-limit','x-ratelimit-limit','x-ratelimit-remaining','ratelimit-limit','ratelimit-remaining','ratelimit-reset'];
function responseDiagnostics(response,url,now){return {url,httpStatus:response.status,checkedAt:new Date(now).toISOString(),headers:Object.fromEntries(diagnosticHeaderNames.flatMap(name=>response.headers.has(name)?[[name,response.headers.get(name).slice(0,256)]]:[]))};}
async function errorResponseSummary(response){
 // Always release a rejected response, while retaining only a bounded public
 // page title and fingerprint, never cookies, challenge tokens or a full body.
 const reader=response.body?.getReader();let bytes=new Uint8Array();
 try{if(reader){const first=await reader.read();if(first.value)bytes=first.value.subarray(0,4096);}}catch{}
 finally{try{await reader?.cancel();}catch{}}
 const text=new TextDecoder().decode(bytes),title=text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
 const clean=title?.replace(/<[^>]*>/g,'').replace(/https?:\/\/\S+/gi,'[URL]').replace(/[A-Za-z0-9_=-]{32,}/g,'[identifier]').replace(/\s+/g,' ').trim().slice(0,160)||null;
 const hash=await crypto.subtle.digest('SHA-256',bytes);
 return {errorTitle:clean,errorBodyPrefixHash:Array.from(new Uint8Array(hash)).map(value=>value.toString(16).padStart(2,'0')).join('')};
}
export async function read(fetcher,url,now,json=true,clock=()=>now,maxAgeMs=STOCK_MAX_AGE_MS){
 const r=await fetcher(url,{headers:{Accept:json?'application/json':'text/html','User-Agent':'iPhonePickupWatch/2.0 (+https://your-worker.example.com)','Cache-Control':'no-cache'},cache:'no-store',signal:AbortSignal.timeout(12000)});
 const serverDelay=retryDelay(r.headers.get('Retry-After'),now);
 if(!r.ok){const blocked=r.status===541,sourceMeta={...responseDiagnostics(r,url,clock()),...await errorResponseSummary(r)};throw new UpstreamError(`Apple HTTP ${r.status}`,{retryMs:Math.max(blocked?BLOCK_COOLDOWN:ERROR_RETRY_MS,serverDelay),serverRetryMs:serverDelay,hardStop:r.status===403,kind:blocked?'blocked':r.status===429?'rate_limited':r.status===403?'access_denied':'upstream',httpStatus:r.status,sourceMeta});}
 try{
  const value=json?await r.json():await r.text(),received=clock(),date=Date.parse(r.headers.get('Date'));
  const age=r.headers.get('Age'),ageMs=age===null?0:/^\d+$/.test(age)?Number(age)*1000:NaN;
  const timestamp=Math.min(date,received-ageMs),valid=r.status===200&&Number.isFinite(timestamp)&&timestamp<=received+60000&&received-timestamp<=maxAgeMs&&date<=received+60000;
  const meta={...responseDiagnostics(r,url,received),responseDate:r.headers.get('Date'),age,cacheControl:r.headers.get('Cache-Control'),responseTimestamp:valid?new Date(timestamp).toISOString():null,fresh:valid,maxAgeMs};
  return {value,meta};
 }catch{throw new UpstreamError('Apple response could not be read.',{kind:'invalid_response',httpStatus:r.status});}
}
