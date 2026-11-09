import test from 'node:test';
import assert from 'node:assert/strict';
import {MonitorEngine,scan,BLOCK_COOLDOWN} from '../src/monitor.mjs';
import {products,stores,batchSourceUrl,orderUrl} from '../src/apple.mjs';
import {captureSourceFrames,replaySourceFrames,compactSourceBody} from '../src/native-source.mjs';
import {parsePrice} from '../src/apple.mjs';
import {nativeCycle,apiClient} from '../native/collector.mjs';
import {phoneStatus} from '../src/push.mjs';

class Storage{data=new Map();next=null;async get(k){return structuredClone(this.data.get(k));}async put(k,v){this.data.set(k,structuredClone(v));}async setAlarm(t){this.next=t;}async getAlarm(){return this.next;}async deleteAlarm(){this.next=null;}}
function fixture(){
 const h={time:Date.parse('2026-10-28T14:00:00Z'),storage:new Storage(),available:false,sourceRequests:[],pushes:[],pending:null};
 h.source=async url=>{
  h.sourceRequests.push(url);
  const headers={Date:new Date(h.time).toUTCString(),'Cache-Control':'no-store'};
  if(url===batchSourceUrl())return Response.json({body:{stores:stores.map(s=>({storeNumber:s.id,retailStore:{lastFetched:h.time-86400000},partsAvailability:Object.fromEntries(products.map(p=>[p.part,{partNumber:p.part,storePickEligible:true,pickupSearchQuote:h.available?'Available Tomorrow':'Currently unavailable',messageTypes:{regular:{storeSelectionEnabled:h.available,storePickupProductTitle:`iPhone Duo 256GB ${p.color}`}}}]))}))}},{headers});
  const p=products.find(p=>orderUrl(p)===url);assert.ok(p);
  return new Response('<script type="application/ld+json">'+JSON.stringify({offers:{sku:p.part+'+unlocked',price:1999,priceCurrency:'USD'}})+'</script>Connect to any carrier later',{headers});
 };
 h.engine=()=>new MonitorEngine(h.storage,{NTFY_TOPIC:'native_test_only_abcdefghijklmnop'},{now:()=>h.time,fetcher:async(url,options)=>{assert.equal(url,'https://ntfy.sh/','The native Worker must never request Apple.');h.pushes.push(JSON.parse(options.body));return Response.json({id:'test-'+h.pushes.length,event:'message'});}});
 h.api=async(route,body)=>{
  const e=h.engine();if(route==='/native/claim')return e.nativeClaim();if(route==='/native/report')return e.nativeReport(body);throw Error('Unexpected route.');
 };
 h.journal={read:async()=>structuredClone(h.pending),write:async value=>{h.pending=structuredClone(value);},clear:async()=>{h.pending=null;}};
 h.cycle=options=>nativeCycle({api:h.api,journal:h.journal,fetcher:h.source,now:()=>h.time,...options});
 h.activate=async()=>{await h.engine().nativeActivate();h.time=(await h.engine().state()).nextCheck;};
 return h;
}

test('native migration preserves the existing source cooldown, deduplication and device records',async()=>{
 const h=fixture();await h.storage.put('state',{enabled:true,sourceMode:'cloud',nextCheck:h.time+BLOCK_COOLDOWN,cooldownUntil:h.time+BLOCK_COOLDOWN,activeKeys:['existing-alert'],sourceHealth:'blocked',pollIntervalMs:240000});await h.storage.put('push:subscriptions',[{fixture:true}]);
 const r=await h.engine().nativeActivate();assert.equal(r.notBefore,h.time+BLOCK_COOLDOWN);assert.equal(r.intervalMs,10000);
 const claim=await h.engine().nativeClaim();assert.equal(claim.eligible,false);await h.engine().alarm();assert.equal(h.sourceRequests.length,0);assert.deepEqual((await h.engine().state()).activeKeys,['existing-alert']);assert.deepEqual(await h.storage.get('push:subscriptions'),[{fixture:true}]);
});
test('server-issued native lease excludes another collector and survives a Worker restart',async()=>{
 const h=fixture();await h.activate();const first=await h.engine().nativeClaim(),second=await h.engine().nativeClaim();assert.equal(first.eligible,true);assert.equal(second.eligible,false);assert.equal(second.notBefore,first.lease.expiresAt);await h.engine().nativeActivate();assert.equal((await h.engine().state()).nativeLease.id,first.lease.id);
});
test('one native combined request verifies all eight pairs and keeps start-to-start ten-second cadence',async()=>{
 const h=fixture();await h.activate();const started=h.time;
 const result=await h.cycle({fetcher:async(...args)=>{const response=await h.source(...args);h.time+=2300;return response;}});
 assert.equal(result.healthy,true);assert.equal(result.known,8);assert.equal(result.notBefore,started+10000);assert.equal(h.sourceRequests.length,1);assert.equal(h.pending,null);
 const state=await h.engine().state();assert.equal(state.source.transport,'native-mac');assert.equal(state.recentChecks[0].durationMs,2300);assert.ok(state.lastResult.every(o=>o.status==='NOT AVAILABLE'));
 const early=await h.cycle();assert.equal(early.eligible,false);assert.equal(h.sourceRequests.length,1);
 h.time=result.notBefore;assert.equal((await h.cycle()).healthy,true);assert.equal(h.sourceRequests.length,2);
});
test('native real responses are re-parsed server-side before qualifying alerts and replay is idempotent',async()=>{
 const h=fixture();await h.activate();h.available=true;let lost=true;
 const api=async(route,body)=>{const result=await h.api(route,body);if(route==='/native/report'&&lost){lost=false;throw Error('Response lost after commit.');}return result;};
 await assert.rejects(h.cycle({api}),/Response lost/);assert.ok(h.pending.frames);assert.equal(h.pushes.length,1);assert.equal(h.sourceRequests.length,3);
 const replay=await h.cycle({api});assert.equal(replay.duplicate,true);assert.equal(h.sourceRequests.length,3);assert.equal(h.pushes.length,1);assert.equal(h.pending,null);
 const status=await phoneStatus(h.engine(),h.storage,h.time);assert.equal(status.sourceMode,'native');assert.equal(status.options.filter(o=>o.status==='AVAILABLE').length,8);assert.match(h.pushes[0].message,/October 29, 2026/);
});
test('native capture and strict replay reject arbitrary URLs, duplicate calls and injected headers',async()=>{
 const h=fixture(),capture=captureSourceFrames(h.source);await scan(capture.fetcher,h.time,{},()=>h.time);
 const replay=replaySourceFrames(capture.frames);assert.equal((await replay(batchSourceUrl())).status,200);await assert.rejects(replay(batchSourceUrl()),/missing/);
 assert.throws(()=>replaySourceFrames([{...capture.frames[0],url:'http://127.0.0.1/private'}]),/Unexpected/);
 assert.throws(()=>replaySourceFrames([capture.frames[0],capture.frames[0]]),/Unexpected/);
 assert.throws(()=>replaySourceFrames([{...capture.frames[0],headers:{authorization:'secret'}}]),/headers/);
 await assert.rejects(capture.fetcher('https://evil.test/'),/Unexpected/);
});
test('a blocked native source honors Retry-After and cannot be sped up by restart or activation',async()=>{
 const h=fixture();await h.activate();const started=h.time;
 const result=await h.cycle({fetcher:async()=>new Response('blocked',{status:541,headers:{'Retry-After':'2400'}})});
 assert.equal(result.healthy,false);assert.equal(result.known,0);assert.equal(result.httpStatus,541);assert.ok(result.notBefore>=started+2400000);assert.equal(h.pushes.length,0);
 await h.engine().nativeActivate();const again=await h.engine().nativeClaim();assert.equal(again.eligible,false);assert.equal(again.notBefore,result.notBefore);
});
test('expired or mismatched native reports cannot commit source observations',async()=>{
 const h=fixture();await h.activate();const claim=await h.engine().nativeClaim();const capture=captureSourceFrames(h.source);await scan(capture.fetcher,h.time,{},()=>h.time);
 await assert.rejects(h.engine().nativeReport({id:'another',frames:capture.frames}),/does not match/);
 h.time=claim.lease.expiresAt+1;await assert.rejects(h.engine().nativeReport({id:claim.lease.id,frames:capture.frames}),/expired/);assert.equal((await h.engine().state()).checks,0);assert.equal(h.pushes.length,0);
});
test('native watchdog expires a lost attempt without fallback Apple requests',async()=>{
 const h=fixture();await h.activate();const claim=await h.engine().nativeClaim();h.time=claim.lease.expiresAt+1;await h.engine().alarm();const state=await h.engine().state();assert.equal(state.nativeLease,null);assert.equal(state.checkInProgress,false);assert.equal(state.failureKind,'native_timeout');assert.ok(state.lastResult.every(o=>o.status==='UNKNOWN'));assert.equal(h.sourceRequests.length,0);assert.equal(h.pushes.length,0);
});
test('a restart with an unfinished journal cannot repeat the reserved Apple request',async()=>{
 const h=fixture();await h.activate();const claim=await h.engine().nativeClaim();h.pending={id:claim.lease.id,startedAt:claim.lease.startedAt};const result=await h.cycle();assert.equal(result.eligible,false);assert.equal(h.sourceRequests.length,0);
});
test('a control outage never triggers unreserved Apple traffic',async()=>{
 const h=fixture();await assert.rejects(h.cycle({api:async()=>{throw Error('Relay offline.');}}),/Relay offline/);assert.equal(h.sourceRequests.length,0);assert.equal(h.pushes.length,0);
});
test('native transport errors remain UNKNOWN and preserve source failure accounting',async()=>{
 const h=fixture();await h.activate();const result=await h.cycle({fetcher:async()=>{throw Error('Network unavailable.');}});assert.equal(result.healthy,false);assert.equal(result.known,0);assert.equal(result.httpStatus,null);assert.equal(h.pushes.length,0);assert.ok((await h.engine().state()).lastResult.every(o=>o.status==='UNKNOWN'));
});
test('a replayed stale HTTP response cannot produce a native stock alert',async()=>{
 const h=fixture();await h.activate();h.available=true;const result=await h.cycle({fetcher:async(...args)=>{const r=await h.source(...args);r.headers.set('Age','600');return r;}});assert.equal(result.healthy,false);assert.equal(result.known,0);assert.equal(h.pushes.length,0);
});
test('native access denial preserves the established hard stop and never changes routes',async()=>{
 const h=fixture();await h.activate();const result=await h.cycle({fetcher:async()=>new Response('',{status:403})});assert.equal(result.enabled,false);assert.equal(h.storage.next,null);assert.equal((await h.engine().nativeClaim()).paused,true);assert.equal(h.pushes.length,0);
});
test('control token remains in Authorization, never URLs or source headers',async()=>{
 const requests=[],api=apiClient('private-fixture-token',async(url,options)=>{requests.push({url,options});return Response.json({eligible:false});});await api('/native/claim',{});assert.equal(requests[0].url.includes('private-fixture-token'),false);assert.equal(requests[0].options.headers.Authorization,'Bearer private-fixture-token');await assert.rejects(api('/native/other',{}),/Unsupported/);
});
test('native network failures retry after ten seconds without inheriting cloud minute backoff',async()=>{
 const h=fixture();await h.activate();const started=h.time;
 const result=await h.cycle({fetcher:async()=>{throw Error('Temporary connection loss.');}});
 assert.equal(result.notBefore,started+10000);assert.equal(result.known,0);
 h.time=result.notBefore;const recovered=await h.cycle();assert.equal(recovered.healthy,true);assert.equal(recovered.notBefore,h.time+10000);
});
test('native HTTP server failures honor an explicit Retry-After instead of the ten-second target',async()=>{
 const h=fixture();await h.activate();const started=h.time;
 const result=await h.cycle({fetcher:async()=>new Response('',{status:503,headers:{'Retry-After':'120'}})});
 assert.ok(result.notBefore>=started+120000);assert.equal(result.known,0);assert.equal(h.pushes.length,0);
});
test('native stock evidence expires after twenty seconds and a late report cannot alert',async()=>{
 const h=fixture();await h.activate();await h.cycle();let s=await h.engine().state();assert.equal(Date.parse(s.lastResult[0].expiresAt)-Date.parse(s.lastResult[0].evidenceTimestamp),20000);
 h.time=s.nextCheck;h.available=true;
 const lease=await h.engine().nativeClaim(),capture=captureSourceFrames(h.source);await scan(capture.fetcher,h.time,{},()=>h.time);
 h.time+=21000;const receipt=await h.engine().nativeReport({id:lease.lease.id,frames:capture.frames});assert.equal(receipt.healthy,false);assert.equal(receipt.known,0);assert.equal(h.pushes.length,0);
});
test('native prices for both colors are checked concurrently, without extra inventory calls',async()=>{
 const h=fixture();await h.activate();h.available=true;let releaseNight,whiteStarted=false,nightCompleted=false;
 const result=await h.cycle({fetcher:async(url,options)=>{
  if(url===orderUrl(products[0])){await new Promise(resolve=>{releaseNight=resolve;setTimeout(resolve,100);});nightCompleted=true;}
  if(url===orderUrl(products[1])){whiteStarted=true;assert.ok(releaseNight);assert.equal(nightCompleted,false);releaseNight();}
  return h.source(url,options);
 }});
 assert.equal(whiteStarted,true);assert.equal(result.healthy,true);assert.equal(h.sourceRequests.filter(url=>url===batchSourceUrl()).length,1);assert.equal(h.sourceRequests.length,3);
});
test('one stalled price is aborted within the attempt budget without suppressing the other color alert',async()=>{
 const h=fixture();await h.activate();h.available=true;
 const result=await h.cycle({sourceBudgetMs:40,fetcher:async(url,options)=>{
  assert.equal(options.headers['User-Agent'].startsWith('iPhonePickupWatch/'),true);assert.equal(options.headers.Cookie,undefined);
  if(url===orderUrl(products[0]))return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Budget was not enforced.')),500);options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal.reason);},{once:true});});
  return h.source(url,options);
 }});
 assert.equal(result.known,4);assert.equal(result.healthy,false);assert.equal(h.pushes.length,1);assert.match(h.pushes[0].message,/256GB Star White/);assert.equal(h.pushes[0].message.includes('256GB Night Sky'),false);
});
test('compact reports preserve exact price/configuration proof while excluding unrelated markup and stores',async()=>{
 const h=fixture(),response=await h.source(batchSourceUrl()),data=await response.json();data.body.stores.push({storeNumber:'OTHER_STORE',retailStore:{availableNow:true},partsAvailability:{}});
 const inventory=JSON.parse(compactSourceBody(batchSourceUrl(),JSON.stringify(data)));assert.equal(inventory.body.stores.length,4);assert.equal(JSON.stringify(inventory).includes('OTHER_STORE'),false);assert.equal(JSON.stringify(inventory).includes('availableNow'),false);
 const html='<html><div>'+('unrelated-markup-'.repeat(10000))+'</div><script type="application/ld+json">{"offers":{"sku":"MK1E4LL/A+unlocked","price":1999,"priceCurrency":"USD"}}</script><p>Connect to any carrier later</p></html>';
 const proof=compactSourceBody(orderUrl(products[1]),html);assert.ok(proof.length<500);assert.equal(parsePrice(proof,products[1]).verified,true);assert.equal(parsePrice(proof,products[0]).verified,false);assert.equal(proof.includes('unrelated-markup'),false);
});
