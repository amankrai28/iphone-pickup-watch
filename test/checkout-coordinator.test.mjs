import test from 'node:test';import assert from 'node:assert/strict';
import {CheckoutCoordinator,CHECKOUT_LEASE_MS} from '../src/checkout-coordinator.mjs';
import {MonitorEngine} from '../src/monitor.mjs';
class AtomicStorage{
 constructor(){this.data=new Map();this.queue=Promise.resolve();}
 async get(k){return structuredClone(this.data.get(k));}
 async put(k,v){this.data.set(k,structuredClone(v));}
 async transaction(fn){const task=this.queue.then(async()=>{const data=new Map([...this.data].map(([k,v])=>[k,structuredClone(v)]));const result=await fn({get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v))});this.data=data;return result;});this.queue=task.catch(()=>{});return task;}
 async deleteAlarm(){}
}
function harness({enabled=true,runReview,adapterTimeoutMs}={}){
 const h={time:Date.parse('2026-10-29T13:30:03Z'),calls:[],storage:new AtomicStorage(),ids:0};
 h.option=(patch={})=>({status:'AVAILABLE',storeId:'R446',part:'MK1F4LL/A',color:'Night Sky',price:1999,pickupDate:'2026-10-29',selectable:true,checkedAt:new Date(h.time).toISOString(),evidenceTimestamp:new Date(h.time).toISOString(),expiresAt:new Date(h.time+20000).toISOString(),...patch});
 h.checkout=(patch={})=>({storeId:'R446',part:'MK1F4LL/A',pickupDate:'2026-10-29',quantity:1,checkedAt:new Date(h.time).toISOString(),pickupSelectable:true,requiresUserVerification:false,paymentMethodVerified:true,paymentLast4:'0000',unlocked:true,connectLater:true,paidInFull:true,tradeIn:false,extras:false,currency:'USD',devicePrice:1999,total:2100.00,...patch});
 h.adapter={mode:'rehearsal-only',canSubmit:false,runReview:async(command,options)=>{h.calls.push(command);return runReview?runReview(command,options):{kind:'REVIEW',noSubmissionConfirmed:true,checkout:h.checkout()};}};
 h.coordinator=()=>new CheckoutCoordinator(h.storage,{now:()=>h.time,id:()=>`fixture-attempt-${++h.ids}`,adapter:enabled?h.adapter:null,adapterTimeoutMs});return h;
}
const reserve=h=>h.coordinator().reserve('event-new-haven',h.option());
test('production default records a bounded observation without creating a browser job or enabling purchase',async()=>{
 const h=harness({enabled:false});const r=await reserve(h);assert.equal(r.reason,'EXECUTOR_DISABLED');assert.equal(h.calls.length,0);const s=await h.coordinator().status();assert.equal(s.active,null);assert.equal(s.purchaseEnabled,false);assert.equal(s.mode,'observe-only');assert.equal(s.seen.length,1);assert.equal((await reserve(h)).reason,'DUPLICATE_EVENT');assert.throws(()=>h.coordinator().requestSubmission());
});
test('simultaneous colors/stores across coordinator instances share one atomic global reservation',async()=>{
 const h=harness();const results=await Promise.all([reserve(h),h.coordinator().reserve('white-holyoke',h.option({storeId:'R191',part:'MK1E4LL/A',color:'Star White'}))]);assert.equal(results.filter(r=>r.reserved).length,1);assert.equal(results.find(r=>!r.reserved).reason,'GLOBAL_ATTEMPT_LOCKED');assert.equal((await h.coordinator().status()).revision,1);
});
test('restart and repeated dispatch cannot invoke the adapter twice; intent is durable before the adapter runs',async()=>{
 const h=harness({runReview:async command=>{assert.equal((await h.storage.get('checkout:coordination:v1')).active.phase,'DISPATCH_INTENT');assert.equal(command.stopBeforePurchase,true);assert.equal(command.policy.paymentLast4,'0000');assert.equal(command.policy.protectedOrderId,'W0000000000');return {kind:'REVIEW',noSubmissionConfirmed:true,checkout:h.checkout()};}});
 const {attempt}=await reserve(h);const r=await Promise.all([h.coordinator().dispatch(attempt.id),h.coordinator().dispatch(attempt.id)]);assert.equal(r.filter(x=>x.dispatched).length,1);assert.equal(h.calls.length,1);assert.equal((await h.coordinator().status()).active.phase,'REVIEW_READY');assert.equal(await h.coordinator().finishNoPurchase(attempt.id),true);assert.equal((await reserve(h)).reason,'DUPLICATE_EVENT');
});
test('fresh inventory is revalidated before dispatch; expired evidence never opens a browser',async()=>{
 const h=harness();const {attempt}=await reserve(h);h.time+=21000;assert.equal((await h.coordinator().dispatch(attempt.id)).dispatched,false);assert.equal(h.calls.length,0);assert.equal((await h.coordinator().status()).active.phase,'BLOCKED');assert.equal(await h.coordinator().finishNoPurchase(attempt.id),true);
});
test('a reservation expiring before dispatch can be closed explicitly, never automatically reassigned',async()=>{
 const h=harness();const {attempt}=await reserve(h);h.time+=CHECKOUT_LEASE_MS+1;assert.equal((await h.coordinator().reserve('another',h.option())).reason,'GLOBAL_ATTEMPT_LOCKED');assert.equal(h.calls.length,0);assert.equal(await h.coordinator().finishNoPurchase(attempt.id),true);
});
test('adapter timeout freezes the attempt and a late result cannot release it',async()=>{
 let release;const gate=new Promise(r=>release=r);const h=harness({runReview:()=>gate,adapterTimeoutMs:5});const {attempt}=await reserve(h);await h.coordinator().dispatch(attempt.id);let s=await h.coordinator().status();assert.equal(s.active.phase,'RECONCILIATION_REQUIRED');assert.equal(await h.coordinator().finishNoPurchase(attempt.id),false);release({kind:'REVIEW',noSubmissionConfirmed:true,checkout:h.checkout()});await Promise.resolve();assert.equal((await h.coordinator().status()).active.phase,'RECONCILIATION_REQUIRED');assert.equal((await h.coordinator().reserve('another',h.option())).reason,'GLOBAL_ATTEMPT_LOCKED');
});
test('exception text and untrusted adapter data never leak into durable records',async()=>{
 const h=harness({runReview:()=>{throw Error('SECRET-PASSWORD-AND-SESSION');}});const {attempt}=await reserve(h);await h.coordinator().dispatch(attempt.id);assert.equal(JSON.stringify(await h.coordinator().status()).includes('SECRET'),false);assert.equal((await h.coordinator().status()).active.phase,'RECONCILIATION_REQUIRED');
});
test('only an exact eligible pickup review with authorized card can become review-ready',async()=>{
 for(const patch of [{paymentLast4:'1111'},{pickupSelectable:false},{pickupDate:'2026-11-01'},{storeId:'R191'},{quantity:2},{tradeIn:true},{extras:true},{total:2126.01},{requiresUserVerification:true}]){
  const h=harness({runReview:()=>({kind:'REVIEW',noSubmissionConfirmed:true,checkout:h.checkout(patch)})});const {attempt}=await reserve(h);await h.coordinator().dispatch(attempt.id);assert.equal((await h.coordinator().status()).active.phase,'BLOCKED',JSON.stringify(patch));assert.equal(await h.coordinator().finishNoPurchase(attempt.id),true);
 }
});
test('review-ready without explicit no-submission evidence remains frozen',async()=>{
 const h=harness({runReview:()=>({kind:'REVIEW',checkout:h.checkout()})});const {attempt}=await reserve(h);await h.coordinator().dispatch(attempt.id);assert.equal((await h.coordinator().status()).active.phase,'RECONCILIATION_REQUIRED');
});
test('kill switch before dispatch prevents execution; kill during execution rejects the late acknowledgment',async()=>{
 const h=harness();const {attempt}=await reserve(h);await h.coordinator().pause();assert.equal((await h.coordinator().dispatch(attempt.id)).dispatched,false);assert.equal(h.calls.length,0);
 let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);const running=harness({runReview:()=>{entered();return gate;}});const a=(await reserve(running)).attempt;const pending=running.coordinator().dispatch(a.id);await ready;await running.coordinator().pause();release({kind:'REVIEW',noSubmissionConfirmed:true,checkout:running.checkout()});assert.equal((await pending).accepted,false);assert.equal((await running.coordinator().status()).active.phase,'RECONCILIATION_REQUIRED');assert.equal(await running.coordinator().finishNoPurchase(a.id),false);
});
test('empty history and the protected November order cannot clear an uncertain attempt',async()=>{
 const h=harness({runReview:()=>({kind:'UNCERTAIN'})});const {attempt}=await reserve(h);await h.coordinator().dispatch(attempt.id);const base={source:'apple-order-history',complete:true,checkedAt:new Date(h.time).toISOString()};assert.equal((await h.coordinator().reconcile(attempt.id,{...base,orders:[]})).resolved,false);assert.equal((await h.coordinator().reconcile(attempt.id,{...base,orders:[{orderId:'W0000000000',part:'MK1F4LL/A',storeId:'R446',pickupDate:'2026-10-29',quantity:1}]})).resolved,false);assert.equal((await h.coordinator().status()).active.phase,'RECONCILIATION_REQUIRED');
});
test('one positively matched new order terminates all future attempts; ambiguous or stale proof cannot',async()=>{
 const h=harness({runReview:()=>({kind:'UNCERTAIN'})});const {attempt}=await reserve(h);await h.coordinator().dispatch(attempt.id);const order={orderId:'W1234567890',part:'MK1F4LL/A',storeId:'R446',pickupDate:'2026-10-29',quantity:1},base={source:'apple-order-history',complete:true,checkedAt:new Date(h.time).toISOString()};assert.equal((await h.coordinator().reconcile(attempt.id,{...base,orders:[order,order]})).resolved,false);assert.equal((await h.coordinator().reconcile(attempt.id,{...base,checkedAt:new Date(h.time-61000).toISOString(),orders:[order]})).resolved,false);assert.equal((await h.coordinator().reconcile(attempt.id,{...base,orders:[order]})).resolved,true);assert.equal((await h.coordinator().status()).orderConfirmed,true);assert.equal((await h.coordinator().reserve('new',h.option())).reason,'ORDER_ALREADY_CONFIRMED');
});
test('unknown, replayed, wrong variants and non-October evidence cannot reserve; no non-atomic storage fallback exists',async()=>{
 const h=harness();for(const patch of [{status:'UNKNOWN'},{part:'512GB'},{color:'Star White'},{pickupDate:'2026-11-01'},{checkedAt:new Date(h.time-21000).toISOString()}])assert.equal((await h.coordinator().reserve('e',h.option(patch))).reason,'INVALID_OR_STALE_CANDIDATE');await assert.rejects(()=>new CheckoutCoordinator({get:async()=>null},{now:()=>h.time}).reserve('e',h.option()),/Atomic/);
});
test('event dispatch eligibility is independent of failed push delivery and persists across monitor restart',async()=>{
 const h=harness({enabled:false});const e=new MonitorEngine(h.storage,{NTFY_TOPIC:'test_topic_abcdefghijklmnopqrstuvwxyz'},{now:()=>h.time,fetcher:async()=>{assert.equal((await h.coordinator().status()).seen.length,1,'Persist event before push.');return new Response('',{status:503});}});const s=await e.state();s.enabled=true;const result={options:[h.option()],healthy:true,errors:[],prices:{},source:{transport:'fixture'},serverRetryMs:0};await e.applyResult(s,result,h.time);await e.save(s);assert.equal(s.notificationError!==null,true);assert.equal((await h.coordinator().status()).seen.length,1);h.time+=10000;const again=new MonitorEngine(h.storage,{NTFY_TOPIC:'test_topic_abcdefghijklmnopqrstuvwxyz'},{now:()=>h.time,fetcher:async()=>new Response('',{status:503})});const persisted=await again.state();await again.applyResult(persisted,{...result,options:[h.option()]},h.time);assert.equal((await h.coordinator().status()).seen.length,1);assert.equal((await h.coordinator().status()).active,null);
});
test('a purchase-capable adapter cannot be activated through persisted state or a runtime flag',async()=>{
 const h=harness();h.adapter.canSubmit=true;assert.equal((await reserve(h)).reason,'EXECUTOR_DISABLED');assert.throws(()=>h.coordinator().requestSubmission());assert.equal(h.calls.length,0);
});
test('untrusted review fields are reduced to typed configuration values, never raw credentials or markup',async()=>{
 const h=harness({runReview:()=>({kind:'REVIEW',noSubmissionConfirmed:true,checkout:{...h.checkout(),part:'SECRET-SESSION',total:{cookie:'SECRET-SESSION'},address:'SECRET-ADDRESS',cookies:'SECRET-COOKIES'}})});const {attempt}=await reserve(h);await h.coordinator().dispatch(attempt.id);const s=await h.coordinator().status();assert.equal(s.active.phase,'BLOCKED');assert.equal(JSON.stringify(s).includes('SECRET'),false);assert.equal(s.active.review.part,null);assert.equal(s.active.review.total,null);
});
