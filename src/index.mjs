import {DurableObject} from 'cloudflare:workers';
import {MonitorEngine} from './monitor.mjs';
import {phoneAssets} from './phone.mjs';
import {registerPhone,phoneStatus} from './push.mjs';
import {NATIVE_MAX_BYTES} from './native-source.mjs';
async function requestJson(request,limit){
 if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')throw Object.assign(Error('JSON required.'),{status:415});
 const reader=request.body?.getReader(),decoder=new TextDecoder();let text='',size=0;
 if(reader){for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw Object.assign(Error('Payload too large.'),{status:413});}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
 try{return JSON.parse(text||'{}');}catch{throw Object.assign(Error('Invalid JSON.'),{status:400});}
}
export class PickupMonitor extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.engine=new MonitorEngine(ctx.storage,env);}
 async alarm(){return this.engine.alarm();}
 async fetch(request){
  const path=new URL(request.url).pathname;
  try{
   if(path==='/phone/status'&&request.method==='GET')return Response.json(await phoneStatus(this.engine,this.ctx.storage),{headers:{'Cache-Control':'no-store'}});
   if(path==='/phone/config'&&request.method==='GET')return Response.json({publicKey:this.env.VAPID_PUBLIC_KEY},{headers:{'Cache-Control':'no-store'}});
   if(path.startsWith('/phone/')&&request.method==='POST'){
    if(request.headers.get('Content-Type')!=='application/json')return new Response('JSON required',{status:415});
    const reader=request.body?.getReader();let text='',size=0;if(reader){const decoder=new TextDecoder();for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>4096){await reader.cancel();return new Response('Too large',{status:413});}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
    const body=JSON.parse(text||'{}');
    if(path==='/phone/subscribe')return Response.json(await registerPhone(this.ctx.storage,body));
    if(path==='/phone/received'){const receivedAt=new Date().toISOString(),last=await this.ctx.storage.get('push:lastMessage');if(last?.id===body.id){last.receivedAt=receivedAt;await this.ctx.storage.put('push:lastMessage',last);}const history=await this.ctx.storage.get('push:history')||[];if(history.some(item=>item.id===body.id))await this.ctx.storage.put('push:history',history.map(item=>item.id===body.id?{...item,receivedAt}:item));await this.ctx.storage.transaction(async tx=>{const saved=await tx.get('push:stockHistory')||[];if(saved.some(item=>item.id===body.id))await tx.put('push:stockHistory',saved.map(item=>item.id===body.id?{...item,receivedAt}:item));});return Response.json({ok:true});}
    if(path==='/phone/test'){const last=await this.ctx.storage.get('push:lastTest')||0;if(Date.now()-last<20000)return Response.json({error:'Wait 20 seconds before another test.'},{status:429,headers:{'Retry-After':'20'}});await this.ctx.storage.put('push:lastTest',Date.now());return Response.json(await this.engine.testNotification());}
   }
   if(request.method==='GET'&&path==='/status'){
    const state=await this.engine.state();
    return Response.json({...state,implementationVersion:'sku-history-v13-atomic',nextAlarm:await this.ctx.storage.getAlarm()},{headers:{'Cache-Control':'no-store'}});
   }
   if(request.method==='GET'&&path==='/checkout/status')return Response.json(await this.engine.checkout.status(),{headers:{'Cache-Control':'no-store'}});
   if(request.method==='POST'&&path==='/pilot/interval')return Response.json(await this.engine.setIntervalPilot(await requestJson(request,1024)));
   if(request.method==='POST'&&path==='/start')return Response.json(await this.engine.start());
   if(request.method==='POST'&&path==='/pause')return Response.json(await this.engine.stop());
   if(request.method==='POST'&&path==='/test')return Response.json(await this.engine.testNotification());
   if(request.method==='POST'&&path==='/native/activate')return Response.json(await this.engine.nativeActivate());
   if(request.method==='POST'&&path==='/native/claim')return Response.json(await this.engine.nativeClaim());
   if(request.method==='POST'&&path==='/native/report')return Response.json(await this.engine.nativeReport(await requestJson(request,NATIVE_MAX_BYTES)));
   return new Response('Not found',{status:404});
  }catch(error){return Response.json({error:error.message||'Operation failed. Check configuration and retry.'},{status:[400,409,413,415].includes(error.status)?error.status:503});}
 }
}
export default {
 async fetch(request,env){
  const url=new URL(request.url),base='/setup/'+env.SETUP_TOKEN+'/';
  const asset=phoneAssets(request,env);if(asset)return asset;
  if(env.SETUP_TOKEN&&url.pathname===base.slice(0,-1))return Response.redirect(url.origin+base,308);
  if(env.SETUP_TOKEN&&url.pathname.startsWith(base+'api/')){
   if(request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)return new Response('Forbidden',{status:403});
   url.pathname='/phone/'+url.pathname.slice((base+'api/').length);
   return env.MONITOR.getByName('pickup-monitor').fetch(new Request(url,request));
  }
  if(new URL(request.url).pathname==='/health')return Response.json({service:'iPhone pickup monitor',monitoring:'Use authenticated /status to verify.'});
  if(!env.ADMIN_TOKEN||request.headers.get('Authorization')!=='Bearer '+env.ADMIN_TOKEN)return new Response('Unauthorized',{status:401});
  const monitor=env.MONITOR.getByName('pickup-monitor');
  return monitor.fetch(request);
 }
};
