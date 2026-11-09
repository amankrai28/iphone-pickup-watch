import {targetInterval,CLOUD_MAX_AGE_MS} from './config.mjs';
import {currentOptions} from './apple.mjs';
export function refreshHealth(state,now=Date.now()){
 const recent=(state.recentChecks||[]).slice(0,12),gaps=[];
 for(let index=0;index+1<recent.length;index++){
  const a=Date.parse(recent[index].startedAt||recent[index].at),b=Date.parse(recent[index+1].startedAt||recent[index+1].at);
  if(Number.isFinite(a)&&Number.isFinite(b)&&a>=b)gaps.push(a-b);
 }
 const options=currentOptions(state.lastResult,now),verified=Date.parse(state.lastVerifiedAt||''),since=Date.parse(state.cloudHealthySince||'');
 const current=options.length===8&&options.every(option=>option.status!=='UNKNOWN')&&state.sourceHealth==='healthy'&&Number.isFinite(verified)&&now-verified<=CLOUD_MAX_AGE_MS;
 return {targetMs:targetInterval(state,now),sourceMode:state.sourceMode||'cloud',current:Boolean(current),targetMetRecently:Boolean(state.enabled&&current&&state.cloudHealthySamples>=6),consecutiveFresh:state.cloudHealthySamples||0,healthyForMs:current&&Number.isFinite(since)?Math.max(0,now-since):0,lastGapMs:gaps[0]??null,longestRecentGapMs:gaps.length?Math.max(...gaps):null,sampleSize:recent.length,fullyVerifiedSamples:recent.filter(entry=>entry.healthy).length,freshAgeMs:Number.isFinite(verified)?Math.max(0,now-verified):null};
}
