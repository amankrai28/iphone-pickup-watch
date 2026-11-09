import assert from 'node:assert/strict';
import {products,stores} from '../src/apple.mjs';
const {Miniflare}=await import(process.env.PICKUP_MINIFLARE_MODULE||'miniflare');
const notifications=[];
const mf=new Miniflare({
 modules:true,scriptPath:new URL('../dist/index.js',import.meta.url).pathname,compatibilityDate:'2026-05-15',
 durableObjects:{MONITOR:{className:'PickupMonitor',useSQLite:true}},
 bindings:{ADMIN_TOKEN:'local-test-token-only',NTFY_TOPIC:'local_test_topic_abcdefghijklmnop'},
 outboundService:async request=>{
  const u=new URL(request.url);
  if(u.hostname==='ntfy.sh'){
   notifications.push(await request.json());return Response.json({id:'test-receipt',event:'message'});
  }
  if(u.pathname.includes('/buy-iphone/'))return new Response('<html>Apple product</html>',{headers:{Date:new Date().toUTCString(),'Set-Cookie':'dssid2=runtime-shopping-session; Path=/shop; Secure; HttpOnly'}});
  assert.match(request.headers.get('Cookie')||'',/dssid2=runtime-shopping-session/);
  const parts=[...u.searchParams.entries()].filter(([k])=>/^parts\.\d+$/.test(k)).map(([,v])=>v);
  assert.deepEqual(parts,products.map(p=>p.part),'Both exact colors must share one pickup request.');
  return Response.json({body:{stores:stores.map(s=>({storeNumber:s.id,retailStore:{lastFetched:Date.now(),availableNow:true},partsAvailability:Object.fromEntries(products.map(p=>[p.part,{partNumber:p.part,storePickEligible:true,pickupSearchQuote:'Currently unavailable',messageTypes:{regular:{storeSelectionEnabled:false,storePickupProductTitle:`iPhone Duo 256GB ${p.color}`}}}]))}))}},{headers:{Date:new Date().toUTCString(),'Cache-Control':'no-store'}});
 }
});
const request=(path,method='GET',authorized=true)=>mf.dispatchFetch('https://worker.test'+path,{method,headers:authorized?{Authorization:'Bearer local-test-token-only'}:{}});
try{
 assert.equal((await request('/status','GET',false)).status,401);
 assert.equal((await request('/checkout/status','GET',false)).status,401);
 const checkout=await(await request('/checkout/status')).json();assert.equal(checkout.mode,'observe-only');assert.equal(checkout.purchaseEnabled,false);assert.equal(checkout.executorConfigured,false);
 assert.equal((await request('/checkout/activate','POST')).status,404,'There is no purchase activation route.');
 assert.equal((await request('/pilot/interval','POST',false)).status,401);
 const pilot=await mf.dispatchFetch('https://worker.test/pilot/interval',{method:'POST',headers:{Authorization:'Bearer local-test-token-only','Content-Type':'application/json'},body:JSON.stringify({intervalMs:15000,durationMs:300000})});assert.equal(pilot.status,200);assert.equal((await pilot.json()).targetIntervalMs,15000);
 assert.equal((await request('/start','POST')).status,200);
 await new Promise(resolve=>setTimeout(resolve,2500));
 const s=await (await request('/status')).json();
 assert.equal(s.implementationVersion,'sku-history-v13-atomic');assert.equal(s.enabled,true);assert.ok(s.checks>=1,'Durable Object alarm must execute without another request.');
 assert.equal(s.lastResult.length,8);assert.ok(s.lastResult.every(o=>o.status==='NOT AVAILABLE'));
 assert.ok(s.nextAlarm>Date.now(),'A new alarm must remain scheduled.');
 assert.equal(notifications.length,0,'Unavailability must not send a stock alert.');
 const result=await (await request('/test','POST')).json();assert.equal(result.id,'test-receipt',JSON.stringify(result));assert.match(notifications[0].title,/^TEST/);
 assert.equal((await request('/pause','POST')).status,200);
 const paused=await (await request('/status')).json();assert.equal(paused.enabled,false);assert.equal(paused.nextAlarm,null);
 console.log('PASS: real Workers runtime, SQLite Durable Object, autonomous alarm, protected controls, test push payload, pause.');
}finally{await mf.dispose();}
