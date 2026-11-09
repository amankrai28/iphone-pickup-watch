import {products,orderUrl,batchSourceUrl} from './apple.mjs';
import {read,UpstreamError} from './apple-http.mjs';

const SESSION_KEY='apple:anonymous-session:v1';
const allowed=new Set([batchSourceUrl(),...products.map(orderUrl)]);
const botCookie=/^(?:_abck|ak_bmsc|bm_.+|__cf_bm|cf_clearance)$/i;
const cookieKey=cookie=>cookie.name+';'+cookie.domain+';'+cookie.path;
function setCookies(headers){
 if(typeof headers.getSetCookie==='function')return headers.getSetCookie();
 if(typeof headers.getAll==='function')return headers.getAll('Set-Cookie');
 return (headers.get('Set-Cookie')||'').split(/,(?=\s*[^\s;,=]+=)/).filter(Boolean);
}
export function parseCookie(line,url,now){
 const origin=new URL(url),pieces=line.split(';'),first=pieces.shift(),eq=first.indexOf('=');
 if(eq<1)return null;
 const name=first.slice(0,eq).trim(),value=first.slice(eq+1).trim();
 if(!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name)||botCookie.test(name)||value.length>4096||/[\r\n;]/.test(value))return null;
 const cookie={name,value,domain:origin.hostname,hostOnly:true,path:origin.pathname.slice(0,origin.pathname.lastIndexOf('/')+1)||'/',secure:false,expiresAt:null,createdAt:now};
 let maxAge=null;
 for(const piece of pieces){const index=piece.indexOf('='),key=(index<0?piece:piece.slice(0,index)).trim().toLowerCase(),val=index<0?'':piece.slice(index+1).trim();
  if(key==='domain'){const domain=val.toLowerCase().replace(/^\./,'');if(domain!=='apple.com'&&domain!=='www.apple.com')return null;if(origin.hostname!==domain&&!origin.hostname.endsWith('.'+domain))return null;cookie.domain=domain;cookie.hostOnly=false;}
  if(key==='path'&&val.startsWith('/'))cookie.path=val;
  if(key==='secure')cookie.secure=true;
  if(key==='max-age'&&/^-?\d+$/.test(val))maxAge=Number(val);
  if(key==='expires'&&Number.isFinite(Date.parse(val)))cookie.expiresAt=Date.parse(val);
 }
 if(maxAge!==null)cookie.expiresAt=now+Math.max(0,maxAge)*1000;
 return cookie;
}
export function cookieHeader(cookies,url,now){
 const u=new URL(url);
 return cookies.filter(cookie=>!botCookie.test(cookie.name)&&(cookie.expiresAt===null||cookie.expiresAt>now)&&(!cookie.secure||u.protocol==='https:')&&(cookie.hostOnly?u.hostname===cookie.domain:u.hostname===cookie.domain||u.hostname.endsWith('.'+cookie.domain))&&(u.pathname===cookie.path||u.pathname.startsWith(cookie.path.endsWith('/')?cookie.path:cookie.path+'/'))).sort((a,b)=>b.path.length-a.path.length||a.createdAt-b.createdAt).map(cookie=>cookie.name+'='+cookie.value).join('; ');
}
export class AppleSession{
 constructor(storage,{fetcher=fetch,now=()=>Date.now()}={}){this.storage=storage;this.fetcher=fetcher;this.now=now;this.cookieQueue=Promise.resolve();this.bootstrapFrame=null;}
 async state(){return await this.storage.get(SESSION_KEY)||{createdAt:new Date(this.now()).toISOString(),bootstrapAt:null,cookies:[]};}
 async raw(url,options){
  if(!allowed.has(url))throw Error('Unexpected Apple session URL.');
  const state=await this.state(),headers=new Headers(options.headers),value=cookieHeader(state.cookies,url,this.now());
  if(value)headers.set('Cookie',value);
  const response=await this.fetcher(url,{...options,headers,redirect:'manual'});
  // Rejected responses never replace the session or install challenge tokens.
  if(response.status===200){
   const issued=setCookies(response.headers).map(line=>parseCookie(line,url,this.now())).filter(Boolean);
   if(issued.length){this.cookieQueue=this.cookieQueue.catch(()=>{}).then(async()=>{
    const current=await this.state(),jar=new Map(current.cookies.filter(cookie=>cookie.expiresAt===null||cookie.expiresAt>this.now()).map(cookie=>[cookieKey(cookie),cookie]));
    for(const cookie of issued){if(cookie.expiresAt!==null&&cookie.expiresAt<=this.now())jar.delete(cookieKey(cookie));else jar.set(cookieKey(cookie),cookie);}
    current.cookies=[...jar.values()].slice(-24);await this.storage.put(SESSION_KEY,current);
   });try{await this.cookieQueue;}catch(error){try{await response.body?.cancel();}catch{}throw error;}}
  }
  return response;
 }
 async bootstrap(options){
  if((await this.state()).bootstrapAt)return;
  try{
   const response=await read((url,requestOptions)=>this.raw(url,{...requestOptions,signal:options.signal}),orderUrl(products[0]),this.now(),false,this.now);
   if(response.meta.httpStatus!==200)throw new UpstreamError('Apple session page did not return HTTP 200.',{kind:'invalid_response'});
   const state=await this.state();state.bootstrapAt=new Date(this.now()).toISOString();await this.storage.put(SESSION_KEY,state);
   this.bootstrapFrame={body:response.value,headers:response.meta.headers,at:this.now()};
  }catch(error){error.sourceMeta={...error.sourceMeta,stage:'session-bootstrap'};throw error;}
 }
 async fetch(url,options){
  if(!allowed.has(url))throw Error('Unexpected Apple session URL.');
  await this.bootstrap(options);
  if(url===orderUrl(products[0])&&this.bootstrapFrame&&this.now()-this.bootstrapFrame.at<8000)return new Response(this.bootstrapFrame.body,{headers:this.bootstrapFrame.headers});
  return this.raw(url,options);
 }
 async diagnostics(){const state=await this.state();return {ready:Boolean(state.bootstrapAt),bootstrapAt:state.bootstrapAt,cookieCount:state.cookies.filter(cookie=>!botCookie.test(cookie.name)&&(cookie.expiresAt===null||cookie.expiresAt>this.now())).length};}
}
