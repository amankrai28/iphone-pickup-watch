import {products,stores,dates,currentOptions} from './apple.mjs';
const allowedParts=new Set(products.map(p=>p.part)),allowedStores=new Set(stores.map(s=>s.id));
// This module cannot submit a purchase, contact Apple, or access credentials.
// A live execution adapter and scoped purchase authorization are deliberately absent.
export function initialRehearsal(){return {mode:'rehearsal-only',phase:'IDLE',candidate:null,seen:[],stopBeforePurchase:true};}
export function qualifyCandidate(option,now=Date.now()){
 const reasons=[];
 if(!option||currentOptions([option],now)[0]?.status!=='AVAILABLE')reasons.push('Fresh qualifying stock is required.');
 if(!allowedParts.has(option?.part)||!allowedStores.has(option?.storeId))reasons.push('Wrong exact part or store.');
 if(option?.color!==products.find(p=>p.part===option?.part)?.color)reasons.push('Color does not match exact part.');
 if(!Number.isFinite(option?.price)||option.price<=0||option.price>1999)reasons.push('Device price must be at most $1,999.');
 if(!dates(new Date(now)).includes(option?.pickupDate)||!/^2026-10-\d{2}$/.test(option?.pickupDate||''))reasons.push('Pickup must be today or tomorrow within October 2026.');
 const age=now-Date.parse(option?.checkedAt||''),evidenceAge=now-Date.parse(option?.evidenceTimestamp||'');
 if(!Number.isFinite(age)||age<0||age>20000||!Number.isFinite(evidenceAge)||evidenceAge<0||evidenceAge>20000)reasons.push('Candidate evidence must be no more than 20 seconds old.');
 if(option?.selectable!==true)reasons.push('Pickup must be selectable.');
 return {eligible:reasons.length===0,reasons};
}
export function startRehearsal(previous,eventId,option,readiness={},now=Date.now()){
 const state=structuredClone(previous||initialRehearsal());
 if(state.mode!=='rehearsal-only'||state.stopBeforePurchase!==true)throw Error('Only no-purchase rehearsal mode is implemented.');
 if(state.phase!=='IDLE')return {state,started:false,reason:'A rehearsal is active or needs reconciliation.'};
 if(typeof eventId!=='string'||!eventId||state.seen.includes(eventId))return {state,started:false,reason:'Missing or duplicate event.'};
 const validation=qualifyCandidate(option,now);
 if(!validation.eligible)return {state,started:false,reason:validation.reasons.join(' ')};
 const missing=['authorizedPrivateBrowser','appleSessionVerified','paymentUsabilityVerified','pickupDetailsVerified'].filter(k=>readiness[k]!==true);
 if(missing.length)return {state,started:false,reason:'Readiness not established: '+missing.join(', ')};
 state.phase='REHEARSING';state.seen=[eventId,...state.seen].slice(0,200);
 state.candidate={eventId,storeId:option.storeId,part:option.part,color:option.color,pickupDate:option.pickupDate,price:option.price,detectedAt:option.checkedAt};
 return {state,started:true,stopBeforePurchase:true,reason:'Navigate and review only; do not submit.'};
}
export function reviewCheckout(state,checkout,now=Date.now()){
 if(state?.mode!=='rehearsal-only'||state?.phase!=='REHEARSING'||state.stopBeforePurchase!==true)throw Error('No active no-purchase rehearsal.');
 const c=state.candidate,reasons=[];
 if(checkout?.storeId!==c.storeId||checkout?.part!==c.part||checkout?.pickupDate!==c.pickupDate||checkout?.quantity!==1)reasons.push('Checkout must match one exact candidate.');
 if(checkout?.unlocked!==true||checkout?.connectLater!==true||checkout?.paidInFull!==true||checkout?.tradeIn!==false||checkout?.extras!==false)reasons.push('Unlocked, connect later, pay in full, no trade-in or extras must be verified.');
 if(checkout?.currency!=='USD'||!Number.isFinite(checkout?.total)||checkout.total<=0||checkout.total>2126||!Number.isFinite(checkout?.devicePrice)||checkout.devicePrice<=0||checkout.devicePrice>1999)reasons.push('Verified price must stay within $1,999 device and $2,126 total.');
 const checkoutAge=now-Date.parse(checkout?.checkedAt||'');
 if(checkout?.pickupSelectable!==true||!Number.isFinite(checkoutAge)||checkoutAge<0||checkoutAge>20000)reasons.push('Fresh selectable pickup must be verified in actual checkout.');
 if(checkout?.requiresUserVerification!==false||checkout?.paymentMethodVerified!==true||checkout?.paymentLast4!=='0000')reasons.push('Apple verification and the authorized card ending 0000 must be explicitly verified.');
 if(!dates(new Date(now)).includes(c.pickupDate)||!/^2026-10-\d{2}$/.test(c.pickupDate))reasons.push('Pickup is outside the allowed dates.');
 return {...state,phase:reasons.length?'BLOCKED':'REVIEW_READY',reviewedAt:new Date(now).toISOString(),reasons,stopBeforePurchase:true};
}
export function finishRehearsal(state,outcome){
 if(!['REHEARSING','REVIEW_READY','BLOCKED'].includes(state?.phase))throw Error('No active rehearsal.');
 // Any uncertainty freezes the single global attempt. Never retry a possible submission.
 if(outcome==='unexpected-or-uncertain-submission')return {...state,phase:'RECONCILIATION_REQUIRED',stopBeforePurchase:true};
 if(outcome!=='confirmed-no-purchase')throw Error('Explicit confirmation that no purchase occurred is required.');
 return {...state,phase:'IDLE',candidate:null,stopBeforePurchase:true};
}
