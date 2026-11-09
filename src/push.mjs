import {sendPushNotification,isPushServiceEndpoint} from '@mmmike/web-push/send';
import {INTERVAL,targetInterval} from './config.mjs';
import {currentOptions} from './apple.mjs';
import {refreshHealth} from './health.mjs';
import {summarizeStockEvents} from './stock-events.mjs';
export function pushServiceName(endpoint){
 const host=new URL(endpoint).hostname;
 if(host.endsWith('.push.apple.com'))return 'Apple';
 if(host==='fcm.googleapis.com')return 'Google';
 if(host.endsWith('.push.services.mozilla.com'))return 'Mozilla';
 if(host.endsWith('.notify.windows.com'))return 'Microsoft';
 return 'Browser';
}
// Never return a capability endpoint, subscription key, raw provider body or VAPID secret.
export function safePushError(error,endpoint){
 const provider=pushServiceName(endpoint);
 const status=Number.isInteger(error?.statusCode)?error.statusCode:null;
 let reason=null;
 try{const value=JSON.parse(error.body).reason;if(typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value))reason=value;}catch{}
 if(status)return provider+' push returned HTTP '+status+(reason?' ('+reason+')':'')+'.';
 const message=String(error?.message||'');
 if(/^VAPID (keys are not a valid P-256 key pair|public key must be a 65-byte uncompressed P-256 point|private key must be a 32-byte P-256 scalar|subject must be a 'mailto:' or 'https:\/\/' URI)$/.test(message))return 'Server configuration error: '+message+'.';
 const kind=/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error?.name||'')?error.name:'Error';
 return provider+' push failed before acceptance ('+kind+').';
}
export async function validateSubscription(input){
 const sub={endpoint:input?.endpoint,keys:{p256dh:input?.keys?.p256dh,auth:input?.keys?.auth}};
 if(typeof sub.endpoint!=='string'||sub.endpoint.length>2048||!isPushServiceEndpoint(sub.endpoint))throw Error('Unsupported push endpoint.');
 const u=new URL(sub.endpoint);if(u.username||u.password||u.port||u.hash)throw Error('Invalid push endpoint.');
 const decode=s=>{if(typeof s!=='string'||!/^[A-Za-z0-9_-]+$/.test(s))throw Error('Invalid push key.');return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));};
 const pub=decode(sub.keys.p256dh),auth=decode(sub.keys.auth);
 if(pub.length!==65||pub[0]!==4||auth.length!==16)throw Error('Invalid push keys.');
 await crypto.subtle.importKey('raw',pub,{name:'ECDH',namedCurve:'P-256'},false,[]);
 return sub;
}
export async function registerPhone(storage,input){
 const sub=await validateSubscription(input);const existing=await storage.get('push:subscriptions')||[];
 const found=existing.find(x=>x.endpoint===sub.endpoint);
 if(!found&&existing.length>=2)throw Error('Two devices are already registered. Ask to remove an old device first.');
 await storage.put('push:subscriptions',[...existing.filter(x=>x.endpoint!==sub.endpoint),sub]);
 return {registered:true,devices:found?existing.length:existing.length+1};
}
// Stock history is independent of test notifications and survives notification dismissal.
export async function stockAlertHistory(storage,latest=[]){
 const saved=await storage.get('push:stockHistory')||[],recent=await storage.get('push:history')||[];
 const byId=new Map();for(const item of [...saved,...recent,...latest])if(item?.kind==='stock'&&typeof item.id==='string')byId.set(item.id,item);
 return [...byId.values()].sort((a,b)=>Date.parse(b.requestedAt)-Date.parse(a.requestedAt)).slice(0,80);
}
export async function publishPush(storage,env,message,now=Date.now(),send=sendPushNotification){
 const subscribers=await storage.get('push:subscriptions')||[];
 if(!subscribers.length)throw Error('Phone notifications are not connected. Open the private setup link on your iPhone.');
 const retryAt=await storage.get('push:retryAt')||0;
 if(retryAt>now){const e=new Error('Push delivery is backing off. Next retry after '+new Date(retryAt).toISOString()+'.');e.retryMs=retryAt-now;throw e;}
 const id=crypto.randomUUID();
 const payload={title:message.title,body:message.message,url:message.click,kind:message.title?.startsWith('TEST')?'test':'stock',id,receipt:'/setup/'+env.SETUP_TOKEN+'/api/received'};
 if(new TextEncoder().encode(JSON.stringify(payload)).length>3900)payload.body=payload.body.slice(0,1900)+'\nOpen the alert app for all stores and details.';
 const attempt={...(Array.isArray(message.variants)?{variants:message.variants.slice(0,8)}:{}),id,title:message.title,kind:message.title?.startsWith('TEST')?'test':'stock',summary:message.message,order:message.click,requestedAt:new Date(now).toISOString(),deliveryState:'sending',acceptedAt:null,receivedAt:null,error:null};
 await storage.put('push:lastMessage',attempt);
 let accepted=0,retryMs=60000,rateLimited=false;const gone=[],errors=[];
 for(const sub of subscribers){
  // Topic is optional. Safari rejected the previous collapse header with BadWebPushTopic.
  // The service worker's notification tag already coalesces displayed alerts.
  try{const ok=await send(sub,payload,{publicKey:env.VAPID_PUBLIC_KEY,privateKey:env.VAPID_PRIVATE_KEY,subject:env.VAPID_SUBJECT},{ttl:300,urgency:'high',timeoutMs:15000});
   if(ok)accepted++;else{gone.push(sub.endpoint);errors.push(pushServiceName(sub.endpoint)+' push registration expired. Reconnect notifications on that device.');}
  }catch(e){retryMs=Math.max(retryMs,e.retryAfterMs||0);rateLimited ||=e.statusCode===429;errors.push(safePushError(e,sub.endpoint));}
 }
 if(gone.length)await storage.put('push:subscriptions',subscribers.filter(s=>!gone.includes(s.endpoint)));
 const latest=await storage.get('push:lastMessage');
 const final={...attempt,deliveryState:accepted?'accepted':'failed',acceptedAt:accepted?new Date(now).toISOString():null,receivedAt:latest?.id===id?latest.receivedAt:null,error:errors.length?errors.join(' '):null,acceptedDevices:accepted};
 await storage.put('push:lastMessage',final);
 const saveHistory=async tx=>{const history=await tx.get('push:history')||[];await tx.put('push:stockHistory',await stockAlertHistory(tx,[final]));await tx.put('push:history',[final,...history.filter(item=>item.id!==id)].slice(0,20));};
 if(typeof storage.transaction==='function')await storage.transaction(saveHistory);else await saveHistory(storage);
 if(rateLimited)await storage.put('push:retryAt',now+retryMs);
 if(!accepted){const e=new Error(final.error||'Push service did not accept delivery.');e.retryMs=retryMs;throw e;}
 return {id,acceptedAt:final.acceptedAt,devices:accepted};
}
export async function phoneStatus(engine,storage,nowMs=Date.now()){
 const s=await engine.state(),subscribers=await storage.get('push:subscriptions')||[];
 const monitorHealth=!s.enabled?'paused':!Number.isFinite(s.nextCheck)||s.nextCheck+30000<nowMs?'overdue':s.checkInProgress?'checking':s.cooldownUntil>nowMs?'cooldown':s.sourceHealth==='healthy'?'healthy':'degraded';
 const options=currentOptions(s.lastResult,nowMs).map(o=>monitorHealth==='overdue'?{...o,status:'UNKNOWN',reasonCode:'overdue',reason:'The background check is overdue. Current availability is unknown.'}:o);
 return {stockEvents:summarizeStockEvents(s.stockEvents),refreshHealth:refreshHealth(s,nowMs),sourceSession:s.sourceSession||null,sourceDiagnostics:s.source?{httpStatus:s.source.httpStatus,checkedAt:s.source.checkedAt,stage:s.source.stage||'pickup',title:s.source.errorTitle||null,retryAfter:s.source.headers?.['retry-after']||null}:null,enabled:s.enabled,sourceMode:s.sourceMode,nativeLastSeenAt:s.nativeLastSeenAt,checks:s.checks,lastCheck:s.lastCheck,lastAttemptAt:s.lastAttemptAt,checkInProgress:s.checkInProgress,nextCheck:s.nextCheck,lastError:s.lastError,failureKind:s.failureKind,monitorHealth,sourceHealth:s.sourceHealth,lastVerifiedAt:s.lastVerifiedAt,healthyChecks:s.healthyChecks,healthyStreak:s.healthyStreak,cooldownUntil:s.cooldownUntil,intervalMs:s.pollIntervalMs||INTERVAL,targetIntervalMs:targetInterval(s,nowMs),intervalPilot:s.intervalPilot||null,lastRateLimitAt:s.lastRateLimitAt||null,serverTime:new Date(nowMs).toISOString(),recentChecks:s.recentChecks,notificationError:s.notificationError,notificationRetryAt:s.notificationRetryAt,options,lastStockAlert:s.lastNotification,history:await storage.get('push:history')||[],stockHistory:await stockAlertHistory(storage),devices:subscribers.length,pushServices:[...new Set(subscribers.map(s=>pushServiceName(s.endpoint)))],pushRetryAt:await storage.get('push:retryAt')||null,lastPush:await storage.get('push:lastMessage')||null};
}
