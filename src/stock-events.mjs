import {products,stores,currentOptions} from './apple.mjs';
import {CLOUD_MAX_AGE_MS} from './config.mjs';
export const EVENT_RETENTION_MS=7*24*60*60*1000;
export const EVENT_LIMIT=80;
export const EVENT_BYTE_LIMIT=48*1024;
const pair=o=>`${o.storeId}:${o.part}`;
const terms=o=>`${pair(o)}:${o.pickupDate}:${o.price}`;
const time=value=>Date.parse(value||'');
const iso=value=>new Date(value).toISOString();
// Private compact observation journal, not a restock or continuous-availability claim.
// No browser sessions, payment data, cookies or capability URLs are retained.
export function recordStockEvents(previous,options,now=Date.now()){
 const j=structuredClone(previous||{version:1,startedAt:iso(now),pairs:{},events:[]});
 j.pairs ||= {};j.events ||= [];
 const supplied=currentOptions(options,now);
 for(const p of products)for(const s of stores){
  const id=`${s.id}:${p.part}`,o=supplied.find(o=>o.storeId===s.id&&o.part===p.part);
  const state=j.pairs[id]||{},observed=time(o?.checkedAt);
  // An absent pair, stale observation, or replay is not a new negative.
  const status=o&&Number.isFinite(observed)&&observed<=now&&now-observed<=CLOUD_MAX_AGE_MS?o.status:'UNKNOWN';
  const at=Number.isFinite(observed)&&status!=='UNKNOWN'?observed:now;
  if(Number.isFinite(time(state.lastObservationAt))&&at<=time(state.lastObservationAt))continue;
  let active=j.events.find(e=>e.id===state.activeEventId&&e.closedAt===null);
  if(active&&((Number.isFinite(time(state.lastObservationAt))&&at-time(state.lastObservationAt)>CLOUD_MAX_AGE_MS)||status==='UNKNOWN')){
   active.continuityUncertain=true;active.unknownObservations+=(status==='UNKNOWN'?1:0);
   active.firstUnknownAt ||=iso(at);active.lastUnknownAt=iso(at);
  }
  if(active&&status==='AVAILABLE'&&active.terms!==terms(o)){
   active.closedAt=iso(at);active.closeReason='qualifying-terms-changed';active=null;delete state.activeEventId;
  }
  if(status==='AVAILABLE'){
   if(!active){
    active={id:`${id}:${iso(at)}`,terms:terms(o),store:s.name,storeId:s.id,color:p.color,part:p.part,pickupDate:o.pickupDate,price:o.price,firstAvailableAt:iso(at),lastAvailableAt:iso(at),previousUnavailableAt:state.lastUnavailableAt||null,firstUnavailableAt:null,closedAt:null,closeReason:null,availableObservations:0,unknownObservations:0,continuityUncertain:false,firstUnknownAt:null,lastUnknownAt:null};
    j.events.unshift(active);state.activeEventId=active.id;
   }
   active.lastAvailableAt=iso(at);active.availableObservations++;
  }else if(status==='NOT AVAILABLE'){
   state.lastUnavailableAt=iso(at);
   if(active){active.firstUnavailableAt=iso(at);active.closedAt=iso(at);active.closeReason='confirmed-not-available';active.endReason=String(o?.reason||'No qualifying pickup').slice(0,500);delete state.activeEventId;}
  }
  state.lastObservationAt=iso(at);state.lastStatus=status;j.pairs[id]=state;
 }
 // Retention applies even to a never-confirmed-closed episode. It cannot grow forever.
 j.updatedAt=iso(now);
 const cutoff=now-EVENT_RETENTION_MS;
 j.events=j.events.filter(e=>time(e.lastAvailableAt)>=cutoff).slice(0,EVENT_LIMIT);
 // Leave ample room for the rest of the existing Durable Object state.
 while(j.events.length&&new TextEncoder().encode(JSON.stringify(j)).length>EVENT_BYTE_LIMIT)j.events.pop();
 const retained=new Set(j.events.map(e=>e.id));
 for(const state of Object.values(j.pairs))if(!retained.has(state.activeEventId))delete state.activeEventId;
 return j;
}
export function summarizeStockEvents(journal){
 return {startedAt:journal?.startedAt||null,retentionDays:7,limit:EVENT_LIMIT,events:(journal?.events||[]).map(e=>({
  ...e,
  observedSpanMs:Math.max(0,time(e.lastAvailableAt)-time(e.firstAvailableAt)),
  qualifyingAvailabilityEndedAfter:e.closeReason==='confirmed-not-available'?e.lastAvailableAt:null,
  qualifyingAvailabilityEndedBy:e.firstUnavailableAt,
  // Without an immediately preceding negative, the true start is left-censored.
  maximumEpisodeSpanMs:e.previousUnavailableAt&&e.firstUnavailableAt&&!e.continuityUncertain?Math.max(0,time(e.firstUnavailableAt)-time(e.previousUnavailableAt)):null,
  interpretation:e.continuityUncertain?'Visibility gaps occurred; separate stock episodes may have been merged. Do not infer continuous stock.':'Sampled qualifying pickup only; NOT AVAILABLE can mean disabled pickup or price disqualification, not sold-out inventory. Brief changes between checks remain possible.'
 }))};
}
