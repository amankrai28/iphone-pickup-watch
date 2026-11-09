import {qualifyCandidate,reviewCheckout} from './checkout-rehearsal.mjs';
import {products,stores} from './apple.mjs';
const KEY='checkout:coordination:v1';
export const CHECKOUT_LEASE_MS=30_000;
const RETENTION_MS=7*24*60*60*1000,MAX_SEEN=128;
const iso=n=>new Date(n).toISOString();
const candidate=o=>({storeId:o.storeId,part:o.part,color:o.color,pickupDate:o.pickupDate,price:o.price,checkedAt:iso(Date.parse(o.checkedAt)),evidenceTimestamp:iso(Date.parse(o.evidenceTimestamp)),expiresAt:iso(Date.parse(o.expiresAt)),selectable:true,status:'AVAILABLE'});
const initial=()=>({version:1,revision:0,paused:false,orderConfirmed:false,active:null,seen:[],lastEventByPair:{},history:[]});
const eventIdOK=id=>typeof id==='string'&&id.length>0&&id.length<=240;
const safeCheckout=c=>{
 const result={storeId:stores.some(s=>s.id===c?.storeId)?c.storeId:null,part:products.some(p=>p.part===c?.part)?c.part:null,pickupDate:/^2026-\d{2}-\d{2}$/.test(c?.pickupDate||'')?String(c.pickupDate):null,paymentLast4:/^\d{4}$/.test(c?.paymentLast4||'')?String(c.paymentLast4):null,currency:/^[A-Z]{3}$/.test(c?.currency||'')?String(c.currency):null,checkedAt:Number.isFinite(Date.parse(c?.checkedAt||''))?iso(Date.parse(c.checkedAt)):null};
 for(const k of ['quantity','devicePrice','total'])result[k]=typeof c?.[k]==='number'&&Number.isFinite(c[k])?c[k]:null;
 for(const k of ['pickupSelectable','requiresUserVerification','paymentMethodVerified','unlocked','connectLater','paidInFull','tradeIn','extras'])result[k]=typeof c?.[k]==='boolean'?c[k]:null;
 return result;
};

// This coordinator has NO submit method, browser credentials, fetch URL or HTTP client.
// Production constructs it without an adapter: observations only, purchasing disabled.
// A rehearsal adapter can be injected by trusted code, never by HTTP request/config.
export class CheckoutCoordinator {
 constructor(storage,{now=()=>Date.now(),id=()=>crypto.randomUUID(),adapter=null,adapterTimeoutMs=15_000}={}){
  this.storage=storage;this.now=now;this.id=id;this.adapter=adapter;this.adapterTimeoutMs=Math.min(15_000,Math.max(1,adapterTimeoutMs));
 }
 get rehearsalEnabled(){return this.adapter?.mode==='rehearsal-only'&&this.adapter?.canSubmit===false&&typeof this.adapter?.runReview==='function';}
 async transaction(action){
  if(typeof this.storage.transaction!=='function')throw Error('Atomic Durable Object storage is required.');
  return this.storage.transaction(async tx=>{
   const s=await tx.get(KEY)||initial();
   const result=await action(s);
   await tx.put(KEY,s);
   return structuredClone(result);
  });
 }
 async status(){
  const s=await this.storage.get(KEY)||initial();this.expire(s);
  return {...s,mode:this.rehearsalEnabled?'rehearsal-only':'observe-only',purchaseEnabled:false,executorConfigured:this.rehearsalEnabled};
 }
 prune(s){
  const cutoff=this.now()-RETENTION_MS;
  s.seen=s.seen.filter(e=>Date.parse(e.at)>=cutoff).slice(0,MAX_SEEN);
  s.history=s.history.filter(e=>Date.parse(e.at)>=cutoff).slice(0,32);
 }
 record(s,eventId,o,outcome){
  s.lastEventByPair[o.storeId+':'+o.part]=eventId;
  s.seen.unshift({eventId,at:iso(this.now()),outcome,storeId:o.storeId,part:o.part,pickupDate:o.pickupDate});this.prune(s);
 }
 expire(s){
  const a=s.active;
  if(!a||a.expiresAt>this.now()||!['RESERVED','DISPATCH_INTENT'].includes(a.phase))return;
  a.phase=a.phase==='RESERVED'?'BLOCKED':'RECONCILIATION_REQUIRED';
  a.reason=a.executionStarted?'EXECUTOR_TIMEOUT_UNCERTAIN':'RESERVATION_EXPIRED_NO_DISPATCH';
  // Expiry NEVER silently releases a global lock after a possible side effect.
 }
 async offer(options,journal){
  const candidates=options.filter(o=>qualifyCandidate(o,this.now()).eligible).map(o=>({o,eventId:journal?.pairs?.[o.storeId+':'+o.part]?.activeEventId})).filter(x=>eventIdOK(x.eventId));
  if(!candidates.length)return {accepted:0,purchaseEnabled:false};
  // Reserve from fresh evidence before push delivery. The outbox is independent
  // of push success; duplicate/replayed frames cannot create another dispatch.
  let accepted=0;
  for(const {o,eventId} of candidates){const r=await this.reserve(eventId,o);if(r.reserved)accepted++;}
  return {accepted,purchaseEnabled:false};
 }
 async reserve(eventId,option){
  const validation=qualifyCandidate(option,this.now());
  if(!eventIdOK(eventId)||!validation.eligible)return {reserved:false,reason:'INVALID_OR_STALE_CANDIDATE'};
  return this.transaction(s=>{
   this.prune(s);this.expire(s);
   if(s.orderConfirmed)return {reserved:false,reason:'ORDER_ALREADY_CONFIRMED'};
   if(s.paused)return {reserved:false,reason:'KILL_SWITCH'};
   if(s.seen.some(e=>e.eventId===eventId)||s.lastEventByPair[option.storeId+':'+option.part]===eventId)return {reserved:false,reason:'DUPLICATE_EVENT'};
   if(s.active)return {reserved:false,reason:'GLOBAL_ATTEMPT_LOCKED'};
   if(!this.rehearsalEnabled){this.record(s,eventId,option,'OBSERVED_EXECUTOR_DISABLED');return {reserved:false,reason:'EXECUTOR_DISABLED'};}
   s.revision++;
   s.active={id:this.id(),fence:s.revision,eventId,candidate:candidate(option),phase:'RESERVED',createdAt:iso(this.now()),expiresAt:this.now()+CHECKOUT_LEASE_MS,executionStarted:false,purchaseEnabled:false};
   this.record(s,eventId,option,'RESERVED');
   return {reserved:true,attempt:s.active};
  });
 }
 async dispatch(attemptId){
  const prepared=await this.transaction(s=>{
   this.expire(s);const a=s.active;
   if(s.paused||s.orderConfirmed||!this.rehearsalEnabled||!a||a.id!==attemptId||a.phase!=='RESERVED')return null;
   if(!qualifyCandidate(a.candidate,this.now()).eligible){a.phase='BLOCKED';a.reason='EVIDENCE_EXPIRED_BEFORE_DISPATCH';return null;}
   a.phase='DISPATCH_INTENT';a.executionStarted=true;a.dispatchedAt=iso(this.now());
   // This durable write commits before any adapter call. A crash after it freezes
   // the attempt on expiry instead of invoking the adapter a second time.
   return {attemptId:a.id,fence:a.fence,eventId:a.eventId,candidate:a.candidate,mode:'rehearsal-only',stopBeforePurchase:true,policy:{quantity:1,deviceCap:1999,totalCap:2126,currency:'USD',paymentLast4:'0000',noTradeIn:true,noExtras:true,connectLater:true,paidInFull:true,pickupOnly:true,protectedOrderId:'W0000000000'}};
  });
  if(!prepared)return {dispatched:false,purchaseEnabled:false};
  let outcome,timer;const controller=new AbortController();
  try{
   outcome=await Promise.race([
    Promise.resolve().then(()=>this.adapter.runReview(structuredClone(prepared),{signal:controller.signal})),
    new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({kind:'UNCERTAIN'});},this.adapterTimeoutMs);})
   ]);
  }catch{outcome={kind:'UNCERTAIN'};}
  finally{clearTimeout(timer);}
  const accepted=await this.report(prepared.attemptId,prepared.fence,outcome);
  return {dispatched:true,accepted,purchaseEnabled:false};
 }
 async report(attemptId,fence,outcome){
  return this.transaction(s=>{
   this.expire(s);const a=s.active;
   if(!a||a.id!==attemptId||a.fence!==fence||a.phase!=='DISPATCH_INTENT')return false;
   if(outcome?.kind==='REVIEW'&&outcome.noSubmissionConfirmed===true){
    const checkout=safeCheckout(outcome.checkout);
    const reviewed=reviewCheckout({mode:'rehearsal-only',phase:'REHEARSING',stopBeforePurchase:true,candidate:a.candidate},checkout,this.now());
    a.phase=reviewed.phase;a.reasons=reviewed.reasons;a.reviewedAt=reviewed.reviewedAt;a.review=checkout;a.noSubmissionConfirmed=true;
   }else if(outcome?.kind==='STOPPED'&&outcome.noSubmissionConfirmed===true){
    a.phase='BLOCKED';a.reason='EXECUTOR_STOPPED_BEFORE_PURCHASE';a.noSubmissionConfirmed=true;
   }else{
    a.phase='RECONCILIATION_REQUIRED';a.reason='UNEXPECTED_OR_UNCERTAIN_SUBMISSION';
   }
   return true;
  });
 }
 async finishNoPurchase(attemptId){
  return this.transaction(s=>{
   this.expire(s);const a=s.active;
   if(!a||a.id!==attemptId||!['REVIEW_READY','BLOCKED'].includes(a.phase))return false;
   if(a.executionStarted&&a.noSubmissionConfirmed!==true)return false;
   s.history.unshift({eventId:a.eventId,attemptId:a.id,at:iso(this.now()),outcome:'CONFIRMED_NO_PURCHASE'});s.active=null;this.prune(s);return true;
  });
 }
 async pause(){
  return this.transaction(s=>{
   s.paused=true;const a=s.active;
   if(a?.phase==='RESERVED'){a.phase='BLOCKED';a.reason='KILL_SWITCH_BEFORE_DISPATCH';}
   else if(a?.phase==='DISPATCH_INTENT'){a.phase='RECONCILIATION_REQUIRED';a.reason='KILL_SWITCH_DURING_EXECUTION';}
   return {paused:true,purchaseEnabled:false};
  });
 }
 async reconcile(attemptId,evidence){
  return this.transaction(s=>{
   const a=s.active;if(!a||a.id!==attemptId||a.phase!=='RECONCILIATION_REQUIRED')return {resolved:false};
   const checked=Date.parse(evidence?.checkedAt||'');
   if(evidence?.source!=='apple-order-history'||evidence.complete!==true||!Number.isFinite(checked)||checked<this.now()-60000||checked>this.now())return {resolved:false,reason:'FRESH_OFFICIAL_EVIDENCE_REQUIRED'};
   const orders=Array.isArray(evidence.orders)?evidence.orders:[];
   // An empty order page cannot prove a timed-out request was never accepted.
   // Only a positively matched new order closes this lock; there is no automatic
   // no-order reset or retry path after uncertain execution.
   const matches=orders.filter(o=>o.orderId!=='W0000000000'&&/^W[0-9]{6,20}$/.test(o.orderId||'')&&o.part===a.candidate.part&&o.storeId===a.candidate.storeId&&o.pickupDate===a.candidate.pickupDate&&o.quantity===1);
   if(matches.length!==1)return {resolved:false,reason:matches.length?'MULTIPLE_MATCHING_ORDERS':'NO_POSITIVE_ORDER_CONFIRMATION'};
   s.orderConfirmed=true;s.paused=true;a.phase='ORDER_CONFIRMED';a.confirmedOrderId=matches[0].orderId;a.reconciledAt=iso(this.now());
   return {resolved:true,purchaseEnabled:false};
  });
 }
 // Deliberate hard boundary: neither adapter results nor persisted state can
 // activate purchasing. A real submitter is absent from this implementation.
 requestSubmission(){throw Error('Purchasing is not implemented or enabled.');}
}
