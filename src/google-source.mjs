import {products} from './apple.mjs';
import {UpstreamError,retryDelay} from './apple-http.mjs';
import {replaySourceFrames} from './native-source.mjs';
import {PRICE_MAX_AGE_MS} from './config.mjs';

const encoder=new TextEncoder();
export class GoogleSource {
 constructor(config,{fetcher=fetch,now=()=>Date.now()}={}){this.config=config;this.fetcher=fetcher;this.now=now;}
 settings(){
  try{
   const c=typeof this.config==='string'?JSON.parse(this.config):this.config,u=new URL(c.url);
   if(u.protocol!=='https:'||u.hostname!=='script.google.com'||!/^\/macros\/s\/[A-Za-z0-9_-]{30,}\/exec$/.test(u.pathname)||u.search||u.hash||u.username||u.password||!/^[a-f0-9]{64}$/.test(c.key))throw Error();
   return c;
  }catch{throw new UpstreamError('Google collector configuration is incomplete.',{kind:'collector_configuration'});}
 }
 async collect(prices,{signal}={}){
  const c=this.settings(),id=crypto.randomUUID(),issuedAt=this.now();
  const neededPrices=products.filter(p=>!prices[p.part]?.verified||!Number.isFinite(Date.parse(prices[p.part]?.checkedAt))||issuedAt<Date.parse(prices[p.part].checkedAt)||issuedAt-Date.parse(prices[p.part].checkedAt)>=PRICE_MAX_AGE_MS-20000).map(p=>p.part);
  const payload=JSON.stringify({v:1,id,issuedAt,neededPrices});
  const key=await crypto.subtle.importKey('raw',encoder.encode(c.key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(payload)))).map(v=>v.toString(16).padStart(2,'0')).join('');
  let response;
  try{
   response=await this.fetcher(c.url,{method:'POST',headers:{'Content-Type':'application/json','User-Agent':'iPhonePickupWatch-Control/1.0',Accept:'application/json'},body:JSON.stringify({payload,signature}),redirect:'manual',signal,cache:'no-store'});
   for(let redirects=0;response.status>=300&&response.status<400;redirects++){
    const location=response.headers.get('Location');await response.body?.cancel();
    const u=new URL(location||'',c.url);
    if(redirects>=2||u.protocol!=='https:'||u.hostname!=='script.googleusercontent.com'||u.username||u.password)throw Error('Unexpected collector redirect.');
    // Google serves ContentService output at a one-time URL. No secret body or
    // credential is forwarded to the redirected GET.
    response=await this.fetcher(u.href,{headers:{Accept:'application/json','User-Agent':'iPhonePickupWatch-Control/1.0'},redirect:'manual',signal,cache:'no-store'});
   }
   if(!response.ok){const wait=retryDelay(response.headers.get('Retry-After'),this.now());await response.body?.cancel();throw new UpstreamError('Google collector HTTP request failed.',{kind:'collector_connection',serverRetryMs:response.status===429?Math.max(60000,wait):wait});}
   const text=await response.text();if(text.length>1024*1024)throw Error('Collector response too large.');
   const result=JSON.parse(text);
   if(result.id!==id||!Number.isFinite(result.completedAt)||Math.abs(this.now()-result.completedAt)>20000)throw Error('Collector response identity or timing mismatch.');
   if(!result.ok){
    const wait=Number.isFinite(result.notBefore)?Math.max(0,result.notBefore-this.now()):0;
    const category=['timeout','invalid_json','source_error'].includes(result.errorCategory)?' ('+result.errorCategory+')':'';
    throw new UpstreamError(result.code==='wait'?'Google collector is retaining the source wait.':'Google collector could not verify Apple'+category+'.',{kind:result.code==='wait'?'collector_wait':'collector_error',serverRetryMs:wait});
   }
   return replaySourceFrames(result.frames);
  }catch(error){
   if(error instanceof UpstreamError)throw error;
   throw new UpstreamError('Google collector request failed; availability is UNKNOWN.',{kind:'collector_connection'});
  }
 }
 async diagnostics(){try{this.settings();return {kind:'google',ready:true};}catch{return {kind:'google',ready:false};}}
}
