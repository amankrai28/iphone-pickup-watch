import test from 'node:test';
import assert from 'node:assert/strict';
import {MonitorEngine,scan,stockMessage,INTERVAL,BLOCK_COOLDOWN} from '../src/monitor.mjs';
import {products,stores,parseStore,parsePrice,currentOptions} from '../src/apple.mjs';
import {phoneStatus} from '../src/push.mjs';
class Storage{data=new Map();next=null;async get(k){return structuredClone(this.data.get(k));}async put(k,v){this.data.set(k,structuredClone(v));}async setAlarm(t){this.next=t;}async getAlarm(){return this.next;}async deleteAlarm(){this.next=null;}}
test('bounded 15-second pilot delays requests, survives restart, and expires back to ten seconds',async()=>{
 const h=harness();h.white=false;await h.engine().start();await h.engine().alarm();const before=await h.engine().state();
 await h.storage.put('push:subscriptions',[{fixture:'preserved',endpoint:'https://web.push.apple.com/fixture-only'}]);
 const started=h.time,p=await h.engine().setIntervalPilot({intervalMs:15000,durationMs:600000});
 assert.equal(p.targetIntervalMs,15000);assert.equal(p.nextCheck,started+15000);
 h.time=started+10000;await h.engine().alarm();assert.equal(h.requests.length,1);
 h.time=started+15000;await h.engine().alarm();assert.equal(h.requests.length,2);assert.equal(h.storage.next,h.time+15000);
 const status=await phoneStatus(h.engine(),h.storage,h.time);assert.equal(status.targetIntervalMs,15000);assert.equal(status.refreshHealth.targetMs,15000);
 h.time=p.intervalPilot.endsAt;assert.equal((await h.engine().state()).pollIntervalMs,10000);await h.engine().alarm();assert.equal(h.storage.next,h.time+10000);
 assert.deepEqual(await h.storage.get('push:subscriptions'),[{fixture:'preserved',endpoint:'https://web.push.apple.com/fixture-only'}]);assert.equal((await h.engine().state()).stockEvents.startedAt,before.stockEvents.startedAt);
});
test('starting, ending and expiring a pilot never erase an existing source wait',async()=>{
 const h=harness();h.http=541;h.retry='1800';await h.engine().start();await h.engine().alarm();const notBefore=h.storage.next;
 await h.engine().setIntervalPilot({intervalMs:15000,durationMs:300000});assert.equal(h.storage.next,notBefore);
 h.time+=300000;await h.engine().alarm();assert.equal(h.requests.length,1);assert.equal(h.storage.next,notBefore);
 await h.engine().setIntervalPilot({intervalMs:10000});assert.equal(h.storage.next,notBefore);assert.equal((await h.engine().state()).serverNotBefore,notBefore);
});
test('pilot validates safe bounds and leaves a paused monitor paused',async()=>{
 const h=harness();const original=await h.engine().state();
 for(const input of [{intervalMs:5000,durationMs:600000},{intervalMs:15000,durationMs:60000},{intervalMs:15000,durationMs:1800001}])await assert.rejects(h.engine().setIntervalPilot(input),e=>e.status===400);
 assert.deepEqual(await h.engine().state(),original);await h.engine().setIntervalPilot({intervalMs:15000,durationMs:600000});assert.equal(h.storage.next,null);assert.equal((await h.engine().state()).enabled,false);
});
test('512GB source titles and mismatched part identities remain UNKNOWN and cannot be relabeled as stock',async()=>{
 const h=harness();h.wrongTitle=true;const r=await scan(h.fetcher,h.time);assert.ok(r.options.every(o=>o.status==='UNKNOWN'&&o.identity.reportedTitle.includes('512GB')&&!o.identity.verified));assert.throws(()=>stockMessage(r.options));
 h.wrongTitle=false;const good=await scan(h.fetcher,h.time);const o=good.options.find(o=>o.status==='AVAILABLE');assert.equal(o.capacityGb,256);assert.equal(o.identity.reportedPart,o.part);assert.equal(o.identity.verified,true);
 const message=stockMessage([o]);assert.equal(message.variants[0].part,o.part);assert.equal(message.variants[0].capacityGb,256);assert.equal(message.variants[0].identity.reportedTitle,'iPhone Duo 256GB '+o.color);
 assert.throws(()=>stockMessage([{...o,capacityGb:512}]));assert.throws(()=>stockMessage([{...o,part:'WRONG'}]));
});
function harness(){
 const h={time:Date.parse('2026-10-27T15:00:00Z'),quote:'Available Tomorrow',white:true,black:false,price:1999,http:200,notifyHttp:200,sent:[],requests:[],wrongTitle:false,retry:'600'};
 h.fetcher=async(url,opts={})=>{
  h.requests.push(url);
  if(url==='https://ntfy.sh/'){
   h.sent.push(JSON.parse(opts.body));
   return h.notifyHttp===200?Response.json({id:'message-'+h.sent.length,event:'message'}):new Response('',{status:h.notifyHttp,headers:{'Retry-After':h.retry}});
  }
  if(h.http!==200)return new Response('',{status:h.http,headers:{'Retry-After':h.retry}});
  if(url.includes('/pickup-message')){
   const parts=[...new URL(url).searchParams.entries()].filter(([k])=>/^parts\.\d+$/.test(k)).map(([,v])=>v);
   return Response.json({body:{stores:[...stores,{name:'Boston',id:'R999',city:'Boston'}].map(s=>({storeNumber:s.id,retailStore:{lastFetched:h.time-(h.staleStoreMs??h.staleMs??0),availableNow:true},partsAvailability:Object.fromEntries(parts.map(part=>{const p=products.find(p=>p.part===part),available=p.color==='Star White'?h.white:h.black;return [part,{partNumber:part,storePickEligible:true,pickupSearchQuote:available?h.quote:'Currently unavailable',messageTypes:{regular:{storeSelectionEnabled:available,storePickupProductTitle:`iPhone Duo ${h.wrongTitle?'512GB':'256GB'} ${p.color}`}}}];}))}))}},{headers:{Date:new Date(h.time-(h.staleMs||0)).toUTCString(),'Cache-Control':'no-store',...(h.age===undefined?{}:{Age:String(h.age)})}});
  }
  const p=products.find(p=>url.includes(p.slug));
  return new Response('<script type="application/ld+json">'+JSON.stringify({offers:[{priceCurrency:'USD',sku:p.part+'+unlocked',price:h.price}]})+'</script>Connect to any carrier later',{headers:{Date:new Date(h.time).toUTCString(),'Cache-Control':'no-store'}});
 };
 h.storage=new Storage();h.env={NTFY_TOPIC:'test_topic_abcdefghijklmnopqrstuvwxyz'};
 h.engine=()=>{const engine=new MonitorEngine(h.storage,h.env,{fetcher:h.fetcher,now:()=>h.time,sourceClient:{fetch:(...args)=>h.fetcher(...args),diagnostics:async()=>({ready:true,cookieCount:0})}}),start=engine.start.bind(engine);engine.start=async()=>{const state=await start();if(!state.lastAttemptAt&&!state.lastCheck&&state.nextCheck)h.time=Math.max(h.time,state.nextCheck);return state;};return engine;};
 return h;
}
test('tomorrow pickup notifies with calendar date and direct exact order link',async()=>{
 const h=harness(),e=h.engine();await e.start();await e.alarm();assert.equal(h.sent.length,1);
 assert.match(h.sent[0].title,/^AVAILABLE/);assert.match(h.sent[0].message,/October 28, 2026/);
 assert.equal(h.sent[0].click,'https://www.apple.com/xc/product/MK1E4LL/A');assert.match(h.sent[0].message,/65 Broadway/);
 assert.ok(h.sent[0].message.includes('No carrier plan, activation or financing required'));
 const s=await e.state();assert.equal(s.lastResult.length,8);assert.equal(s.lastResult.filter(o=>o.status==='AVAILABLE').length,4);assert.equal(h.storage.next,h.time+INTERVAL);
});
test('worker eviction/restart keeps timer state and prevents duplicate alerts',async()=>{
 const h=harness();await h.engine().start();await h.engine().alarm();h.time+=INTERVAL;await h.engine().alarm();assert.equal(h.sent.length,1);assert.equal((await h.engine().state()).checks,2);
});
test('confirmed disappearance and reappearance produces a fresh alert',async()=>{
 const h=harness(),e=h.engine();await e.start();await e.alarm();h.white=false;h.time+=INTERVAL;await e.alarm();h.white=true;h.time+=INTERVAL;await e.alarm();assert.equal(h.sent.length,2);
});
test('UNKNOWN does not reset duplicate suppression',async()=>{
 const h=harness(),e=h.engine();await e.start();await e.alarm();h.http=500;h.time+=INTERVAL;await e.alarm();assert.ok((await e.state()).lastResult.every(o=>o.status==='UNKNOWN'));h.http=200;h.time+=15000;await e.alarm();assert.equal(h.sent.length,1);
});
test('Apple rate limit respects Retry-After and cannot produce stock alerts',async()=>{
 const h=harness(),e=h.engine();h.http=429;await e.start();await e.alarm();assert.equal(h.sent.length,0);assert.ok(h.storage.next>=h.time+600000);assert.ok((await e.state()).enabled);
});
test('access denial pauses service rather than cycling through alternate routes',async()=>{
 const h=harness(),e=h.engine();h.http=403;await e.start();await e.alarm();assert.equal((await e.state()).enabled,false);assert.equal(h.storage.next,null);assert.equal(h.requests.length,1);
});
test('notification failure is retried after a fresh qualifying check',async()=>{
 const h=harness(),e=h.engine();h.notifyHttp=503;await e.start();await e.alarm();assert.ok((await e.state()).notificationError);assert.equal((await e.state()).activeKeys.length,0);h.time+=600000;h.notifyHttp=200;await e.alarm();assert.equal(h.sent.length,2);assert.equal((await e.state()).activeKeys.length,4);
});
test('pause survives restart and prevents further source requests',async()=>{
 const h=harness(),e=h.engine();await e.start();await e.stop();await h.engine().alarm();assert.equal(h.requests.length,0);assert.equal(h.storage.next,null);
});
test('test push is clearly marked and does not start the monitor',async()=>{
 const h=harness(),e=h.engine();await e.testNotification();assert.match(h.sent[0].title,/^TEST/);assert.equal((await e.state()).enabled,false);assert.equal(h.storage.next,null);
});
test('wrong model, over-budget price, and check-back-tomorrow never notify',async()=>{
 for(const mode of ['wrongTitle','price','quote']){
  const h=harness();if(mode==='wrongTitle')h.wrongTitle=true;if(mode==='price')h.price=2000;if(mode==='quote')h.quote='Check back tomorrow';
  const e=h.engine();await e.start();await e.alarm();assert.equal(h.sent.length,0,mode);
 }
});
test('public store availability flag does not qualify any part',async()=>{
 const h=harness();h.white=false;const r=await scan(h.fetcher,h.time);assert.ok(r.options.every(o=>o.status==='NOT AVAILABLE'));assert.throws(()=>stockMessage(r.options));
});
test('stale part data and missing product price are UNKNOWN',()=>{
 const p=products[0],s=stores[0],now=new Date('2026-10-27T16:00:00Z');
 const row={storeNumber:s.id,retailStore:{lastFetched:now.getTime()-121000},partsAvailability:{[p.part]:{partNumber:p.part,storePickEligible:true,pickupSearchQuote:'Available Today',messageTypes:{regular:{storeSelectionEnabled:true,storePickupProductTitle:'iPhone Duo 256GB Night Sky'}}}}};
 assert.equal(parseStore(row,p,s,null,now).status,'UNKNOWN');row.retailStore.lastFetched=now.getTime();assert.equal(parseStore(row,p,s,null,now).status,'UNKNOWN');
});
test('relative date is anchored to Apple timestamp across New York midnight',()=>{
 const p=products[1],s=stores[0],now=new Date('2026-10-28T04:00:20Z'),stamp=Date.parse('2026-10-28T03:59:50Z');
 const row={storeNumber:s.id,retailStore:{lastFetched:stamp},partsAvailability:{[p.part]:{partNumber:p.part,storePickEligible:true,pickupSearchQuote:'Available Tomorrow',messageTypes:{regular:{storeSelectionEnabled:true,storePickupProductTitle:'iPhone Duo 256GB Star White'}}}}};
 const r=parseStore(row,p,s,{verified:true,price:1999,checkedAt:now.toISOString()},now);assert.equal(r.pickupDate,'2026-10-28');assert.equal(r.status,'AVAILABLE');
});
test('white unlocked price must come from its own exact SKU',()=>{
 const html='<script type="application/ld+json">{"offers":[{"priceCurrency":"USD","price":1999,"sku":"MK1E4LL/A+unlocked"}]}</script>Connect to any carrier later';
 assert.equal(parsePrice(html,products[1]).verified,true);assert.equal(parsePrice(html,products[0]).verified,false);assert.equal(parsePrice(html.replace('1999','null'),products[1]).verified,false);
});

test('one inventory request covers exactly both colors and only the four allowed stores',async()=>{const h=harness();h.white=false;const result=await scan(h.fetcher,h.time);assert.equal(h.requests.length,1);const query=new URL(h.requests[0]).searchParams;assert.equal(query.get('parts.0'),'MK1F4LL/A');assert.equal(query.get('parts.1'),'MK1E4LL/A');assert.equal(result.options.length,8);assert.equal(result.healthy,true);assert.ok(result.options.every(o=>stores.some(s=>s.id===o.storeId)));});
test('541 cooldown persists across restart, early alarms and start requests',async()=>{const h=harness();h.http=541;h.retry='1';const e=h.engine();await e.start();await e.alarm();const first=await e.state();assert.equal(first.enabled,true);assert.equal(first.sourceHealth,'blocked');assert.equal(first.cooldownUntil,h.time+60000);assert.equal(h.requests.length,1);h.time+=INTERVAL;await h.engine().start();await h.engine().alarm();assert.equal(h.requests.length,1);assert.equal(h.storage.next,first.cooldownUntil);h.time=first.cooldownUntil;await h.engine().alarm();assert.equal(h.requests.length,2);assert.equal(h.storage.next,h.time+60000);assert.equal(h.sent.length,0);});
test('even a successful alarm cannot be repeated sooner than the sustained interval',async()=>{const h=harness();h.white=false;const e=h.engine();await e.start();await e.alarm();h.time+=5000;await h.engine().alarm();assert.equal(h.requests.length,1);assert.equal((await e.state()).checks,1);});
test('missing one part is degraded, never healthy or a disappearance for that color',async()=>{const h=harness();h.white=false;const fetcher=async(url,opts)=>{const r=await h.fetcher(url,opts);const d=await r.json();for(const row of d.body.stores)delete row.partsAvailability['MK1E4LL/A'];return Response.json(d,{headers:r.headers});};const r=await scan(fetcher,h.time);assert.equal(r.healthy,false);assert.equal(r.options.filter(o=>o.status==='UNKNOWN').length,4);assert.ok(r.errors.length);});
test('healthy recovery is recorded separately from attempts and blocked streak resets only after three healthy checks',async()=>{const h=harness();h.white=false;h.http=541;const e=h.engine();await e.start();await e.alarm();let s=await e.state();assert.equal(s.lastVerifiedAt,null);assert.equal(s.healthyChecks,0);h.time=s.cooldownUntil;h.http=200;await e.alarm();s=await e.state();assert.equal(s.sourceHealth,'healthy');assert.equal(s.lastVerifiedAt,s.lastCheck);assert.equal(s.blockedFailures,1);h.time=s.nextCheck;await e.alarm();h.time=(await e.state()).nextCheck;await e.alarm();s=await e.state();assert.equal(s.healthyStreak,3);assert.equal(s.pollIntervalMs,10000);assert.equal(s.blockedFailures,0);assert.equal(s.recentChecks.length,4);assert.ok(s.enabled);});

test('Retry-After cannot be bypassed by restart, start, or an early alarm',async()=>{const h=harness();h.http=429;h.retry='1800';const e=h.engine();await e.start();await e.alarm();const allowed=h.storage.next;h.time+=INTERVAL;await h.engine().start();await h.engine().alarm();assert.equal(h.requests.length,1);assert.equal(h.storage.next,allowed);assert.equal(allowed,h.time-INTERVAL+1800000);});

test('healthy background scans and phone status use ten seconds without overlap',async()=>{
 const h=harness();h.white=false;const e=h.engine();await e.start();await e.alarm();
 assert.equal(h.storage.next,h.time+10000);
 assert.equal((await phoneStatus(e,h.storage)).intervalMs,10000);
 h.time+=9999;await h.engine().alarm();assert.equal(h.requests.length,1);
 h.time+=1;await h.engine().alarm();assert.equal(h.requests.length,2);
 assert.equal(h.storage.next,h.time+10000);assert.equal(h.sent.length,0);
});
test('ordinary cloud failures keep ten seconds while rate rejection backs off',async()=>{
 for(const mode of ['rate_limit','upstream','missing_part']){
  const h=harness();h.white=false;h.retry='';
  if(mode==='rate_limit')h.http=429;
  if(mode==='upstream')h.http=500;
  if(mode==='missing_part'){
   const fetcher=h.fetcher;h.fetcher=async(url,opts)=>{const r=await fetcher(url,opts),d=await r.json();for(const row of d.body.stores)delete row.partsAvailability['MK1E4LL/A'];return Response.json(d,{headers:r.headers});};
  }
  const e=h.engine();await e.start();await e.alarm();assert.equal(h.storage.next,h.time+(mode==='rate_limit'?60000:10000),mode);
  h.time+=9999;await h.engine().alarm();assert.equal(h.requests.length,1,mode);
  assert.equal(h.sent.length,0,mode);
 }
});

test('stale successful responses keep a steady retry and recover without duplicate stock alerts',async()=>{
 const h=harness(),e=h.engine();await e.start();await e.alarm();assert.equal(h.sent.length,1);
 h.staleMs=121000;h.time+=10000;
 for(let i=0;i<6;i++){
  await e.alarm();const s=await e.state();assert.equal(s.failureKind,'stale_data');assert.equal(s.nextCheck,h.time+10000);assert.equal(s.transientFailures,0);assert.ok(s.lastResult.every(o=>o.status==='UNKNOWN'));h.time=s.nextCheck;
 }
 h.staleMs=0;await e.alarm();const s=await e.state();assert.equal(s.sourceHealth,'healthy');assert.equal(s.nextCheck,h.time+10000);assert.equal(h.sent.length,1);
});
test('failed pushes do not stall inventory scans or retry without fresh qualifying stock',async()=>{
 const h=harness();h.notifyHttp=503;h.retry='0';const e=h.engine();await e.start();await e.alarm();
 assert.equal((await e.state()).nextCheck,h.time+10000);assert.equal(h.sent.length,1);
 for(let i=0;i<5;i++){h.time+=10000;await e.alarm();}assert.equal((await e.state()).checks,6);assert.equal(h.sent.length,1);
 h.white=false;h.time+=10000;await e.alarm();assert.equal(h.sent.length,1);
 h.white=true;h.notifyHttp=200;h.time+=10000;await e.alarm();const s=await e.state();assert.equal(h.sent.length,2);assert.equal(s.notificationRetryAt,0);assert.equal(s.notificationError,null);assert.equal(s.activeKeys.length,4);
});
test('a restart during the very first scan sees the durable reservation and cannot issue another request',async()=>{
 const h=harness(),original=h.fetcher;let release,entered;
 const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 h.fetcher=async(...args)=>{entered();await gate;return original(...args);};
 const e=h.engine();await e.start();const pending=e.alarm();await ready;
 const inFlight=await e.state();assert.equal(inFlight.checkInProgress,true);assert.ok(inFlight.lastAttemptAt);assert.ok(inFlight.nextCheck>h.time);
 h.time+=10000;await h.engine().alarm();assert.equal(h.requests.length,0);assert.equal(h.storage.next,inFlight.nextCheck);
 release();await pending;assert.equal(h.requests.filter(u=>u.includes('/pickup-message')).length,1);assert.equal((await e.state()).checkInProgress,false);
});
test('expired Apple evidence is UNKNOWN even when the last request just finished',async()=>{
 const h=harness();h.white=false;const result=await scan(h.fetcher,h.time);const sample=result.options[0];
 assert.equal(currentOptions([sample],h.time+119999)[0].status,'NOT AVAILABLE');
 assert.equal(currentOptions([sample],h.time+120001)[0].status,'UNKNOWN');
 const e=h.engine();await e.start();await e.alarm();let s=await e.state();
 s.lastCheck=new Date(h.time+120001).toISOString();s.nextCheck=h.time+130001;await e.save(s);
 const d=await phoneStatus(e,h.storage,h.time+120001);assert.ok(d.options.every(o=>o.status==='UNKNOWN'));
});
test('overdue background timer cannot present current stock as verified',async()=>{
 const h=harness(),e=h.engine();await e.start();await e.alarm();const s=await e.state();s.nextCheck=h.time-31000;await e.save(s);
 const d=await phoneStatus(e,h.storage,h.time);assert.equal(d.monitorHealth,'overdue');assert.ok(d.options.every(o=>o.status==='UNKNOWN'));assert.equal(d.enabled,true);
});
test('slow price verification cannot turn expired pickup evidence into an alert',async()=>{
 const h=harness(),original=h.fetcher;h.fetcher=async(url,opts)=>{const r=await original(url,opts);if(!url.includes('/pickup-message'))h.time+=121000;return r;};
 const r=await scan(h.fetcher,h.time,{},()=>h.time);assert.ok(r.options.every(o=>o.status==='UNKNOWN'));assert.equal(r.healthy,false);
});
test('malformed cached price time is reverified and malformed store timestamps stay unknown',async()=>{
 const h=harness();const r=await scan(h.fetcher,h.time,{'MK1E4LL/A':{verified:true,price:1999,checkedAt:'not-a-date'}});assert.equal(r.options.filter(o=>o.status==='AVAILABLE').length,4);assert.equal(h.requests.filter(u=>!u.includes('/pickup-message')).length,1);
 for(const stamp of [NaN,Infinity,8640000000000000]){const p=products[0],store=stores[0],row={storeNumber:store.id,retailStore:{lastFetched:stamp},partsAvailability:{[p.part]:{partNumber:p.part,pickupSearchQuote:'Available Today',storePickEligible:true,messageTypes:{regular:{storeSelectionEnabled:true,storePickupProductTitle:'iPhone Duo 256GB Night Sky'}}}}};assert.equal(parseStore(row,p,store,{verified:true,price:1999},new Date(h.time)).status,'UNKNOWN');}
});

test('fresh part-level response is verified even when retail store metadata is old',async()=>{
 const h=harness();h.staleStoreMs=2*24*3600000;const r=await scan(h.fetcher,h.time);
 assert.equal(r.healthy,true);assert.equal(r.options.filter(o=>o.status==='AVAILABLE').length,4);
 for(const o of r.options){assert.equal(o.evidenceSource,'http-response');assert.equal(Date.parse(o.evidenceTimestamp),h.time);assert.equal(Date.parse(o.appleTimestamp),h.time-h.staleStoreMs);}
});
test('missing, old, future or explicitly aged HTTP evidence stays UNKNOWN despite fresh store metadata',async()=>{
 for(const variant of ['missing','old','future','aged','invalidAge']){
  const h=harness(),original=h.fetcher;h.white=false;
  h.fetcher=async(url,opts)=>{const r=await original(url,opts),headers=new Headers(r.headers);
   if(variant==='missing')headers.delete('Date');
   if(variant==='old')headers.set('Date',new Date(h.time-121000).toUTCString());
   if(variant==='future')headers.set('Date',new Date(h.time+61000).toUTCString());
   if(variant==='aged')headers.set('Age','121');
   if(variant==='invalidAge')headers.set('Age','invalid');
   return new Response(await r.text(),{headers});
  };
  const r=await scan(h.fetcher,h.time);assert.equal(r.healthy,false,variant);assert.ok(r.options.every(o=>o.status==='UNKNOWN'),variant);
 }
});
test('relative pickup date follows the actual response Date across midnight, not store metadata',async()=>{
 const h=harness();h.time=Date.parse('2026-10-28T04:00:20Z');h.staleStoreMs=2*24*3600000;const original=h.fetcher;
 h.fetcher=async(url,opts)=>{const r=await original(url,opts),headers=new Headers(r.headers);if(url.includes('/pickup-message'))headers.set('Date','Wed, 28 Oct 2026 03:59:50 GMT');return new Response(await r.text(),{headers});};
 const r=await scan(h.fetcher,h.time);const available=r.options.filter(o=>o.status==='AVAILABLE');assert.equal(available.length,4);assert.ok(available.every(o=>o.pickupDate==='2026-10-28'));
});
test('cloud recovery immediately returns to the target after a fresh accepted cycle',async()=>{
 const h=harness();h.white=false;h.http=541;h.retry='';await h.engine().start();await h.engine().alarm();let s=await h.engine().state();assert.equal(s.pollIntervalMs,10000);assert.equal(s.cooldownUntil,h.time+60000);
 h.time=s.cooldownUntil;h.http=200;await h.engine().alarm();s=await h.engine().state();assert.equal(s.nextCheck,h.time+10000);assert.equal(s.sourceHealth,'healthy');
});
test('cloud rejected-source retries back off at one, two, four, then five minutes, never one hour',async()=>{
 const h=harness();h.white=false;h.http=541;h.retry='';const e=h.engine();await e.start();
 for(const expected of [60000,120000,240000,300000,300000]){await e.alarm();const s=await e.state();assert.equal(s.nextCheck,h.time+expected);assert.equal(s.pollIntervalMs,10000);h.time=s.nextCheck;}
 assert.equal(h.sent.length,0);
});
test('an old unrecorded cooldown is preserved until source instructions are known',async()=>{
 const h=harness();h.white=false;await h.storage.put('state',{enabled:true,sourceHealth:'blocked',lastCheck:new Date(h.time).toISOString(),nextCheck:h.time+BLOCK_COOLDOWN,cooldownUntil:h.time+BLOCK_COOLDOWN});
 const e=h.engine();await e.alarm();assert.equal(h.requests.length,0);assert.equal((await e.state()).nextCheck,h.time+BLOCK_COOLDOWN);
 h.time+=BLOCK_COOLDOWN;await e.alarm();const s=await e.state();assert.equal(s.pollIntervalMs,10000);assert.equal(s.nextCheck,h.time+10000);assert.equal(s.sourceHealth,'healthy');
});
test('migration shortens only the captured client-imposed wait and retains explicit server waits',async()=>{
 for(const reported of [null,'1800']){
  const h=harness(),checked=h.time-10*60000;await h.storage.put('state',{enabled:true,sourceMode:'cloud',sourceHealth:'blocked',blockedFailures:4,source:{checkedAt:new Date(checked).toISOString(),headers:reported?{'retry-after':reported}:{}},lastAttemptAt:new Date(checked).toISOString(),nextCheck:checked+3600000,cooldownUntil:checked+3600000,pollIntervalMs:240000});
  await h.engine().start();const s=await h.engine().state();assert.equal(s.pollIntervalMs,10000);assert.equal(s.nextCheck,reported?checked+1800000:h.time+1000);assert.equal(s.pacingVersion,3);
 }
});
test('rejected source responses retain safe diagnostics and release the response stream',async()=>{
 const h=harness();let cancelled=false;
 const response=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('<html><title>Request denied</title><p>private-challenge-cookie</p>'));},cancel(){cancelled=true;}}),{status:541,headers:{Date:new Date(h.time).toUTCString(),'Content-Type':'text/html','Retry-After':'300','Set-Cookie':'private-session=do-not-store','X-Rate-Limit':'remaining=0'}});
 const result=await scan(async()=>response,h.time,{},()=>h.time);
 assert.equal(cancelled,true);assert.equal(result.source.errorTitle,'Request denied');assert.equal(result.source.headers['retry-after'],'300');assert.equal(result.source.headers['x-rate-limit'],'remaining=0');assert.equal(result.source.errorBodyPrefixHash.length,64);
 assert.equal(JSON.stringify(result.source).includes('private-session'),false);assert.equal(JSON.stringify(result.source).includes('private-challenge-cookie'),false);assert.equal(result.options.every(option=>option.status==='UNKNOWN'),true);
});
test('cloud starts stay ten seconds apart even when a successful fetch takes eight seconds',async()=>{
 const h=harness();h.white=false;const original=h.fetcher,starts=[];h.fetcher=async(...args)=>{starts.push(h.time);const r=await original(...args);h.time+=8000;return r;};
 const e=h.engine();await e.start();const first=h.time;await e.alarm();assert.equal((await e.state()).nextCheck,first+10000);
 h.time=first+10000;await e.alarm();assert.deepEqual(starts,[first,first+10000]);assert.equal((await e.state()).nextCheck,first+20000);
});
test('an early first alarm cannot start an unreserved cloud request',async()=>{
 const h=harness(),e=new MonitorEngine(h.storage,h.env,{fetcher:h.fetcher,now:()=>h.time,sourceClient:{fetch:(...args)=>h.fetcher(...args),diagnostics:async()=>({})}});
 const state=await e.start();await e.alarm();assert.equal(h.requests.length,0);h.time=state.nextCheck;await e.alarm();assert.ok(h.requests.length>0);
});
test('continuous cloud health resets after a missed cadence rather than treating sparse successes as continuous',async()=>{
 const h=harness();h.white=false;const e=h.engine();await e.start();
 for(let i=0;i<6;i++){await e.alarm();h.time=(await e.state()).nextCheck;}
 let d=await phoneStatus(e,h.storage,h.time);assert.equal(d.refreshHealth.targetMetRecently,true);assert.equal(d.refreshHealth.consecutiveFresh,6);
 h.time+=30000;await e.alarm();d=await phoneStatus(e,h.storage,h.time);assert.equal(d.refreshHealth.targetMetRecently,false);assert.equal(d.refreshHealth.consecutiveFresh,1);
});
test('a New Haven-only 256GB drop is detected, notified, journaled and persisted',async()=>{
 const h=harness(),original=h.fetcher;h.white=false;h.black=true;
 const fetcher=async(url,opts)=>{const response=await original(url,opts);if(!url.includes('/pickup-message'))return response;const data=await response.json();for(const row of data.body.stores)for(const a of Object.values(row.partsAvailability))if(row.storeNumber!=='R446'){a.pickupSearchQuote='Currently unavailable';a.messageTypes.regular.storeSelectionEnabled=false;}return Response.json(data,{headers:response.headers});};
 const storage=new Storage(),engine=new MonitorEngine(storage,{NTFY_TOPIC:'test_topic_abcdefghijklmnopqrstuvwxyz'},{fetcher,now:()=>h.time});
 await engine.start();h.time+=1000;await engine.alarm();let state=await engine.state();
 assert.equal(h.sent.length,1);assert.match(h.sent[0].message,/Apple New Haven/);assert.equal(state.stockEvents.events.length,1);assert.equal(state.stockEvents.events[0].storeId,'R446');
 const restarted=new MonitorEngine(storage,{NTFY_TOPIC:'test_topic_abcdefghijklmnopqrstuvwxyz'},{fetcher,now:()=>h.time});h.time=state.nextCheck;await restarted.alarm();state=await restarted.state();assert.equal(h.sent.length,1);assert.equal(state.stockEvents.events.length,1);assert.equal(state.stockEvents.events[0].availableObservations,2);
 const publicState=await phoneStatus(restarted,storage,h.time);assert.equal(publicState.stockEvents.events[0].store,'New Haven');
});
test('missing New Haven payload stays UNKNOWN and does not prevent other stores from qualifying',async()=>{
 const h=harness(),original=h.fetcher;
 const fetcher=async(url,opts)=>{const response=await original(url,opts);if(!url.includes('/pickup-message'))return response;const data=await response.json();data.body.stores=data.body.stores.filter(s=>s.storeNumber!=='R446');return Response.json(data,{headers:response.headers});};
 const result=await scan(fetcher,h.time,{},()=>h.time);assert.ok(result.options.filter(o=>o.storeId==='R446').every(o=>o.status==='UNKNOWN'));assert.equal(result.options.filter(o=>o.status==='AVAILABLE').length,3);assert.equal(result.healthy,false);
});
