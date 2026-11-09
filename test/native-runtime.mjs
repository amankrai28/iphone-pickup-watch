import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {products,stores,batchSourceUrl} from '../src/apple.mjs';
import {nativeCycle,apiClient} from '../native/collector.mjs';

const sourceStarts=[];let pending=null;
const mf=new Miniflare({modules:true,scriptPath:new URL('../dist/index.js',import.meta.url).pathname,compatibilityDate:'2026-05-15',durableObjects:{MONITOR:{className:'PickupMonitor',useSQLite:true}},bindings:{ADMIN_TOKEN:'native-runtime-admin-only',NTFY_TOPIC:'native_runtime_fixture_abcdefghijkl'},outboundService:async()=>{throw Error('The native Worker must not initiate any source request.');}});
const raw=(route,body,authorized=true)=>mf.dispatchFetch('https://worker.test'+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(authorized?{Authorization:'Bearer native-runtime-admin-only'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
const api=apiClient('native-runtime-admin-only',(url,options)=>mf.dispatchFetch('https://worker.test'+new URL(url).pathname,options));
const journal={read:async()=>structuredClone(pending),write:async value=>{pending=structuredClone(value);},clear:async()=>{pending=null;}};
const source=async url=>{
 assert.equal(url,batchSourceUrl());sourceStarts.push(Date.now());
 return Response.json({body:{stores:stores.map(store=>({storeNumber:store.id,retailStore:{lastFetched:Date.now()-86400000},partsAvailability:Object.fromEntries(products.map(product=>[product.part,{partNumber:product.part,storePickEligible:true,pickupSearchQuote:'Currently unavailable',messageTypes:{regular:{storeSelectionEnabled:false,storePickupProductTitle:`iPhone Duo 256GB ${product.color}`}}}]))}))}},{headers:{Date:new Date().toUTCString(),'Cache-Control':'no-store'}});
};
const cycle=()=>nativeCycle({api,journal,fetcher:source});
try{
 for(const route of ['/native/activate','/native/claim','/native/report'])assert.equal((await raw(route,{},false)).status,401);
 assert.equal((await raw('/native/claim',{})).status,409);
 const activation=await(await raw('/native/activate',{})).json();assert.equal(activation.mode,'native');
 await new Promise(resolve=>setTimeout(resolve,Math.max(0,activation.notBefore-Date.now()+20)));
 const first=await cycle();assert.equal(first.healthy,true);assert.equal(first.known,8);assert.equal(sourceStarts.length,1);
 assert.equal((await cycle()).eligible,false);assert.equal(sourceStarts.length,1);
 assert.equal((await raw('/native/report',{id:'wrong',frames:[]})).status,409);
 await new Promise(resolve=>setTimeout(resolve,Math.max(0,first.notBefore-Date.now()+20)));
 const second=await cycle();assert.equal(second.healthy,true);assert.equal(sourceStarts.length,2);
 const s=await(await raw('/status')).json();assert.equal(s.sourceMode,'native');assert.equal(s.checks,2);assert.ok(s.lastResult.every(option=>option.status==='NOT AVAILABLE'));assert.equal(s.nativeLease,null);assert.equal(s.nextCheck,s.recentChecks[0].startedAt?Date.parse(s.recentChecks[0].startedAt)+10000:null);
 const gap=sourceStarts[1]-sourceStarts[0];assert.ok(gap>=9900&&gap<15000,'Actual native runtime source interval: '+gap+'ms');
 await raw('/pause',{});console.log('PASS: native Node collector + actual Workers runtime; protected migration, one combined request, strict server reparse, lease exclusion, '+gap+'ms observed fixture cadence, no cloud source traffic.');
}finally{await mf.dispose();}
