import assert from 'node:assert/strict';import {Miniflare} from 'miniflare';
const mf=new Miniflare({modules:true,scriptPath:new URL('./checkout-runtime-worker.mjs',import.meta.url).pathname,compatibilityDate:'2026-05-15',durableObjects:{FIXTURE:{className:'Fixture',useSQLite:true}},outboundService:()=>{throw Error('No network call is permitted in the checkout fixture.');}});
const now=Date.parse('2026-10-29T13:30:03Z'),option={status:'AVAILABLE',storeId:'R446',part:'MK1F4LL/A',color:'Night Sky',price:1999,pickupDate:'2026-10-29',selectable:true,checkedAt:new Date(now).toISOString(),evidenceTimestamp:new Date(now).toISOString(),expiresAt:new Date(now+20000).toISOString()};
const call=async(path,body)=>{const r=await mf.dispatchFetch('https://fixture.test'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});assert.equal(r.status,200,await r.clone().text());return r.json();};
try{
 const race=await Promise.all([call('/reserve',{eventId:'new-haven-black',option}),call('/reserve',{eventId:'holyoke-white',option:{...option,part:'MK1E4LL/A',color:'Star White',storeId:'R191'}})]);
 assert.equal(race.filter(x=>x.reserved).length,1);const attempt=race.find(x=>x.reserved).attempt;
 const dispatch=await Promise.all([call('/dispatch',{attemptId:attempt.id}),call('/dispatch',{attemptId:attempt.id})]);assert.equal(dispatch.filter(x=>x.dispatched).length,1);
 const status=await call('/status');assert.equal(status.active.phase,'BLOCKED');assert.equal(status.purchaseEnabled,false);assert.equal((await call('/finish',{attemptId:attempt.id})).finished,true);
 assert.equal((await call('/reserve',{eventId:attempt.eventId,option:attempt.candidate})).reason,'DUPLICATE_EVENT');
 console.log('PASS: actual Workers SQLite transactions, cross-request global lock, single dispatch, explicit no-purchase release, duplicate-event rejection; zero outbound requests.');
}finally{await mf.dispose();}
