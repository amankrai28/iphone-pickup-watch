import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHmac} from 'node:crypto';
import {GoogleSource} from '../src/google-source.mjs';
import {MonitorEngine,scan} from '../src/monitor.mjs';
import {products,stores,batchSourceUrl,orderUrl} from '../src/apple.mjs';

const key='a'.repeat(64),config={url:'https://script.google.com/macros/s/'+'f'.repeat(45)+'/exec',key};
function harness(){
 const h={now:Date.parse('2026-10-28T15:00:00Z'),status:200,calls:[],available:true},props=new Map([['COLLECTOR_KEY',key]]);let locked=false;
 class Clock extends Date{constructor(...args){super(...(args.length?args:[h.now]));}static now(){return h.now;}}
 const context=vm.createContext({Date:Clock,console,Set,ContentService:{MimeType:{TEXT:'text',JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})},PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty:(k,v)=>props.set(k,v)})},LockService:{getScriptLock:()=>({tryLock(){if(locked)return false;locked=true;return true;},hasLock:()=>locked,releaseLock(){locked=false;}})},Utilities:{Charset:{UTF_8:'UTF-8'},computeHmacSha256Signature:(s,k)=>Array.from(createHmac('sha256',k).update(s).digest())},UrlFetchApp:{fetch:(url,options)=>source(url,options),fetchAll:requests=>requests.map(r=>source(r.url,r))}});
 function source(url,options){
  h.calls.push({url,options});
  const status=h.status,headers={Date:new Date(h.now).toUTCString(),'Cache-Control':'no-store',...(status===429?{'Retry-After':'600'}:{})};
  let body;
  if(status!==200)body='<title>Page Not Found - Apple</title>';
  else if(url===batchSourceUrl())body=JSON.stringify({body:{stores:stores.map(s=>({storeNumber:s.id,partsAvailability:Object.fromEntries(products.map(p=>[p.part,{partNumber:p.part,storePickEligible:true,pickupSearchQuote:h.available?'Available Tomorrow':'Currently unavailable',messageTypes:{regular:{storeSelectionEnabled:h.available,storePickupProductTitle:'iPhone Duo 256GB '+p.color}}}]))}))}});
  else{const p=products.find(p=>orderUrl(p)===url);assert.ok(p);body='<script type="application/ld+json">'+JSON.stringify({price:1999,priceCurrency:'USD',sku:p.part+'+unlocked'})+'</script>Connect to any carrier later';}
  return {getAllHeaders:()=>headers,getContentText:()=>body,getResponseCode:()=>status};
 }
 vm.runInContext(fs.readFileSync(new URL('../google/Collector.gs',import.meta.url),'utf8'),context);
 h.request=envelope=>JSON.parse(context.doPost({postData:{contents:JSON.stringify(envelope)}}).text);
 h.fetcher=async(url,options)=>{assert.equal(url,config.url);h.lastEnvelope=JSON.parse(options.body);const value=h.request(h.lastEnvelope);return Response.json(value);};
 h.props=props;h.client=new GoogleSource(config,{fetcher:h.fetcher,now:()=>h.now});return h;
}
test('Google collector uses authenticated fixed URLs and shared strict price/pickup validation',async()=>{
 const h=harness(),replay=await h.client.collect({});const result=await scan(replay,h.now,{},()=>h.now,{maxAgeMs:20000,parallelPrices:true});
 assert.equal(result.healthy,true);assert.equal(result.options.filter(o=>o.status==='AVAILABLE').length,8);assert.ok(result.options.every(o=>o.pickupDate==='2026-10-29'&&o.price===1999));
 assert.deepEqual(h.calls.map(c=>c.url),[batchSourceUrl(),...products.map(orderUrl)]);assert.ok(h.calls.every(c=>c.options.followRedirects===false&&c.options.validateHttpsCertificates&&c.options.timeoutSeconds<=7));
 assert.equal(JSON.stringify(await h.client.diagnostics()).includes(key),false);
});
test('Google rejects unsigned, replayed, early and held requests without another Apple call',async()=>{
 const h=harness();assert.equal(h.request({payload:'{}',signature:'x'}).ok,false);assert.equal(h.calls.length,0);
 await h.client.collect({});const count=h.calls.length;await assert.rejects(h.client.collect({}),e=>e.kind==='collector_wait');assert.equal(h.calls.length,count);
 h.now+=10000;h.status=429;await h.client.collect({});const after=h.calls.length;h.now+=10000;await assert.rejects(h.client.collect({}),e=>e.kind==='collector_wait'&&e.serverRetryMs>=590000);assert.equal(h.calls.length,after);
});
test('normal RPC arrival jitter is accepted and earlier signed nonces cannot be replayed',async()=>{
 const h=harness();h.available=false;await h.client.collect({});const previous=h.lastEnvelope;h.now+=7800;await h.client.collect({});assert.equal(h.calls.length,2);
 h.now+=10000;const count=h.calls.length;assert.equal(h.request(previous).code,'wait');assert.equal(h.calls.length,count);
});
test('Google content redirect never forwards the secret request and refuses other hosts',async()=>{
 let id,calls=0;const client=new GoogleSource(config,{now:()=>1000,fetcher:async(url,options)=>{calls++;if(calls===1){id=JSON.parse(JSON.parse(options.body).payload).id;return new Response(null,{status:302,headers:{Location:'https://script.googleusercontent.com/macros/echo?fixture=1'}});}assert.equal(options.body,undefined);assert.equal(options.method,undefined);return Response.json({ok:false,id,completedAt:1000,code:'wait',notBefore:9000});}});
 await assert.rejects(client.collect({}),e=>e.kind==='collector_wait'&&e.serverRetryMs===8000);assert.equal(calls,2);
 const denied=new GoogleSource(config,{fetcher:async()=>new Response(null,{status:302,headers:{Location:'https://evil.test/'}})});await assert.rejects(denied.collect({}),e=>e.kind==='collector_connection');
 const limited=new GoogleSource(config,{now:()=>1000,fetcher:async()=>new Response(null,{status:429,headers:{'Retry-After':'120'}})});await assert.rejects(limited.collect({}),e=>e.serverRetryMs===120000);
});
test('Google source failures retain UNKNOWN and source waits through the monitor',async()=>{
 const h=harness(),data=new Map(),storage={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),setAlarm:async()=>{},deleteAlarm:async()=>{}};
 const engine=new MonitorEngine(storage,{NTFY_TOPIC:'test_topic_abcdefghijklmnopqrstuvwxyz',GOOGLE_COLLECTOR_CONFIG:JSON.stringify(config)},{fetcher:h.fetcher,now:()=>h.now});
 await engine.start();h.now+=1000;h.status=429;await engine.alarm();let s=await engine.state();assert.equal(s.sourceHealth,'degraded');assert.equal(s.failureKind,'rate_limited');assert.ok(s.lastResult.every(o=>o.status==='UNKNOWN'));assert.ok(s.nextCheck>=h.now+600000);
 h.now=s.nextCheck;h.status=200;h.available=false;await engine.alarm();s=await engine.state();assert.equal(s.sourceHealth,'healthy');assert.equal(s.source.transport,'google');assert.equal(s.sourceSession.kind,'google');assert.ok(s.lastResult.every(o=>o.status==='NOT AVAILABLE'));
});
test('losing the Google secret cannot activate the old Apple collector',async()=>{
 let calls=0;const now=Date.parse('2026-10-28T15:00:00Z'),data=new Map([['state',{enabled:true,sourceSession:{kind:'google',ready:true}}]]);
 const storage={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),setAlarm:async()=>{},deleteAlarm:async()=>{}};
 const engine=new MonitorEngine(storage,{}, {now:()=>now,fetcher:async()=>{calls++;throw Error('Unexpected network request.');}});await engine.alarm();
 const state=await engine.state();assert.equal(calls,0);assert.equal(state.failureKind,'collector_configuration');assert.deepEqual(state.sourceSession,{kind:'google',ready:false});assert.ok(state.lastResult.every(o=>o.status==='UNKNOWN'));
});
