import {read,UpstreamError,retryDelay} from './apple-http.mjs';
import {AppleSession} from './apple-session.mjs';
import {GoogleSource} from './google-source.mjs';
import {products, stores, batchSourceUrl, orderUrl, appOrderUrl, parsePrice, parseStore, currentOptions, dates} from './apple.mjs';
import {publishPush} from './push.mjs';
import {recordStockEvents} from './stock-events.mjs';
import {CheckoutCoordinator} from './checkout-coordinator.mjs';
import {replaySourceFrames} from './native-source.mjs';
import {INTERVAL, targetInterval, ERROR_RETRY_MS, PRICE_MAX_AGE_MS, STOCK_MAX_AGE_MS, WATCHDOG_MS, RECOVERY_INTERVAL_MS, MAX_RECOVERY_INTERVAL_MS, SPEED_RECOVERY_MS, NATIVE_MAX_AGE_MS, CLOUD_POLICY_VERSION, CLOUD_REJECT_BASE_MS, CLOUD_REJECT_MAX_MS, CLOUD_MAX_AGE_MS, CLOUD_FETCH_BUDGET_MS} from './config.mjs';
export {INTERVAL} from './config.mjs';
export const BLOCK_COOLDOWN = 20*60*1000;
const initial=()=>({enabled:false,pacingVersion:CLOUD_POLICY_VERSION,serverNotBefore:0,sourceMode:'cloud',nativeLease:null,nativeLastSeenAt:null,nativeReceipt:null,checks:0,failures:0,transientFailures:0,lastCheck:null,lastAttemptAt:null,checkInProgress:false,lastResult:[],lastError:null,failureKind:null,nextCheck:null,activeKeys:[],prices:{},lastNotification:null,notificationError:null,notificationRetryAt:0,lastVerifiedAt:null,healthyChecks:0,healthyStreak:0,blockedFailures:0,cooldownUntil:0,sourceHealth:'unknown',source:null,recentChecks:[]});
export const keyFor=o=>`${o.storeId}:${o.part}:${o.pickupDate}:${o.price}`;
const clock=s=>new Date(s).toLocaleString('en-US',{timeZone:'America/New_York',month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'})+' ET';
const day=s=>new Date(s+'T12:00:00Z').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'America/New_York'});
export function stockMessage(options){
 const unique=options.filter(o=>o.status==='AVAILABLE'&&products.some(p=>p.part===o.part&&p.color===o.color)&&(o.capacityGb===undefined||o.capacityGb===256));
 if(!unique.length)throw Error('No verified qualifying option to notify.');
 return {variants:unique.map(o=>({store:o.store,storeId:o.storeId,color:o.color,capacityGb:256,part:o.part,appUrl:appOrderUrl(o),webUrl:o.order,pickupDate:o.pickupDate,price:o.price,quote:o.quote,checkedAt:o.checkedAt,evidenceTimestamp:o.evidenceTimestamp,identity:o.identity})),title:'AVAILABLE — iPhone Duo pickup',priority:5,tags:['iphone','bell'],click:appOrderUrl(unique[0]),
  message:unique.map(o=>`Apple ${o.store} — ${o.address}\niPhone Duo 256GB ${o.color} · $${o.price} before tax\nPickup ${day(o.pickupDate)} · Apple says: ${o.quote}\nVerified ${clock(o.checkedAt)}\n${appOrderUrl(o)}`).join('\n\n')+'\n\nUnlocked outright; connect to any carrier later. No carrier plan, activation or financing required. Tap this stock alert to open the matching Apple Store product link directly; iOS may open the app or website. Select the pickup store and time and complete checkout on Apple. Stock is not reserved.',
  actions:[...new Map(unique.map(o=>[o.part,{action:'view',label:`Order ${o.color}`,url:appOrderUrl(o)}])).values()]};
}
export async function scan(fetcher,nowMs,priceCache={},now=()=>nowMs,{maxAgeMs=STOCK_MAX_AGE_MS,parallelPrices=false}={}){
 const prices={...priceCache},errors=[];let source=null,retryMs=INTERVAL,serverRetryMs=0,hardStop=false,blocked=false,failureKind=null;
 const note=e=>{errors.push(e.message);retryMs=Math.max(retryMs,e.retryMs||ERROR_RETRY_MS);serverRetryMs=Math.max(serverRetryMs,e.serverRetryMs||0);hardStop ||=e.hardStop||false;blocked ||=e.kind==='blocked';failureKind=e.kind||'network';};
 let data;
 try{
  const r=await read(fetcher,batchSourceUrl(),nowMs,true,now,maxAgeMs);data=r.value;source=r.meta;
  if(!Array.isArray(data?.body?.stores))throw new UpstreamError('Apple pickup response has no store list.',{kind:'invalid_response'});
 }catch(e){note(e);source={url:batchSourceUrl(),httpStatus:e.httpStatus||null,kind:e.kind||'network',checkedAt:new Date(nowMs).toISOString(),...e.sourceMeta};
  return {options:products.flatMap(p=>stores.map(s=>({...parseStore(null,p,s,null,new Date(now())),reason:'UNKNOWN — '+e.message}))),retryMs,serverRetryMs,hardStop,blocked,errors,prices,source,failureKind,dataIssue:false,healthy:false,dates:dates(new Date(now()))};
 }
 const options=[],priceErrors=new Map();
 const rowsFor=p=>stores.map(store=>data.body.stores.find(row=>row?.storeNumber===store.id));
 const verifyPrice=async p=>{
  const rows=rowsFor(p);let price=prices[p.part]||null;
  const candidate=rows.some((row,i)=>parseStore(row,p,stores[i],null,new Date(now()),source).pickupDate!==null);
  const priceAge=now()-Date.parse(price?.checkedAt);
  if(!candidate||price?.verified&&Number.isFinite(priceAge)&&priceAge>=0&&priceAge<=PRICE_MAX_AGE_MS)return;
  if(blocked||hardStop){prices[p.part]=null;priceErrors.set(p.part,'Price verification deferred until Apple requests recover.');return;}
  try{
   const response=await read(fetcher,orderUrl(p),now(),false,now,maxAgeMs);
   price=response.meta.fresh?parsePrice(response.value,p,new Date(now())):null;prices[p.part]=price;
   if(!price)priceErrors.set(p.part,'Apple product response timing could not be verified.');
  }catch(error){note(error);prices[p.part]=null;priceErrors.set(p.part,error.message);}
 };
 // Native price checks share one eight-second attempt budget. A slow color
 // cannot prevent the other accepted color from being verified in that cycle.
 if(parallelPrices)await Promise.all(products.map(verifyPrice));else for(const p of products)await verifyPrice(p);
 for(const p of products){
  const rows=rowsFor(p),price=prices[p.part]||null,priceError=priceErrors.get(p.part);
  options.push(...stores.map((store,i)=>{const option=parseStore(rows[i],p,store,price,new Date(now()),source);return priceError&&option.status==='UNKNOWN'?{...option,reason:'UNKNOWN — '+priceError}:option;}));
 }
 const verifiedOptions=currentOptions(options,now()),unknown=verifiedOptions.filter(o=>o.status==='UNKNOWN');
 const dataIssue=unknown.length>0&&!errors.length;
 if(dataIssue)failureKind=unknown.every(o=>o.reasonCode==='stale_data')?'stale_data':'incomplete_data';
 if(unknown.length&&!errors.length)errors.push('Apple returned incomplete, stale or unverified data for '+unknown.length+' of 8 store/color checks.');
 return {options:verifiedOptions,retryMs,serverRetryMs,hardStop,blocked,errors,prices,source,failureKind,dataIssue,healthy:unknown.length===0&&!errors.length,dates:dates(new Date(now()))};
}
export class MonitorEngine {
 constructor(storage,env,{fetcher=(url,options)=>fetch(url,options),now=()=>Date.now(),sourceClient,checkoutCoordinator}={}){this.storage=storage;this.env=env;this.fetcher=fetcher;this.now=now;this.queue=Promise.resolve();this.checkout=checkoutCoordinator||new CheckoutCoordinator(storage,{now});this.sourceClient=sourceClient||(env.GOOGLE_COLLECTOR_CONFIG?new GoogleSource(env.GOOGLE_COLLECTOR_CONFIG,{fetcher,now}):new AppleSession(storage,{fetcher,now}));}
 serial(action){const task=this.queue.then(action);this.queue=task.catch(()=>{});return task;}
 async state(){const stored=await this.storage.get('state'),s={...initial(),...stored};if(stored&&!stored.pacingVersion)s.pacingVersion=0;if(!s.pollIntervalMs)s.pollIntervalMs=s.sourceHealth==='blocked'?RECOVERY_INTERVAL_MS:INTERVAL;if(s.sourceMode==='cloud'&&s.pacingVersion>=CLOUD_POLICY_VERSION)s.pollIntervalMs=targetInterval(s,this.now());return s;}
 async save(state){await this.storage.put('state',state);}
 async setIntervalPilot(input){return this.serial(async()=>{
  if(!input||![10000,15000].includes(input.intervalMs)||input.intervalMs===15000&&(!Number.isInteger(input.durationMs)||input.durationMs<5*60000||input.durationMs>30*60000))throw Object.assign(Error('Pilot requires 15000ms for 5–30 minutes, or 10000ms to end it.'),{status:400});
  const s=await this.state(),now=this.now();
  if(s.sourceMode!=='cloud')throw Object.assign(Error('Interval pilot requires the existing cloud collector.'),{status:409});
  s.intervalPilot=input.intervalMs===15000?{intervalMs:15000,startedAt:now,endsAt:now+input.durationMs}:{...s.intervalPilot,endsAt:now,endedAt:now};
  s.pollIntervalMs=targetInterval(s,now);
  if(s.enabled){s.nextCheck=Math.max(now+500,s.nextCheck||0,s.cooldownUntil||0,s.serverNotBefore||0,Date.parse(s.lastAttemptAt||s.lastCheck||'')+s.pollIntervalMs||0);await this.storage.setAlarm(s.nextCheck);}
  await this.save(s);return {targetIntervalMs:s.pollIntervalMs,intervalPilot:s.intervalPilot,nextCheck:s.nextCheck,enabled:s.enabled};
 });}
 migrateCloudPolicy(s){
  if(s.sourceMode!=='cloud'||s.pacingVersion>=CLOUD_POLICY_VERSION)return;
  const previousNextCheck=s.nextCheck;
  // Only shorten an old client-imposed wait when the captured response proves
  // what Retry-After actually said. Unknown older waits are retained.
  if(!s.checkInProgress&&s.sourceHealth==='blocked'&&s.source?.headers&&Number.isFinite(Date.parse(s.source.checkedAt))){
   const checked=Date.parse(s.source.checkedAt),reported=s.source.headers['retry-after'];
   s.serverNotBefore=reported?checked+retryDelay(reported,checked):0;
   const ownDelay=Math.min(CLOUD_REJECT_MAX_MS,CLOUD_REJECT_BASE_MS*2**Math.min(3,Math.max(0,(s.blockedFailures||1)-1)));
   s.nextCheck=Math.max(this.now()+1000,checked+ownDelay,s.serverNotBefore);s.cooldownUntil=s.nextCheck;
  }
  s.pollIntervalMs=INTERVAL;s.pacingVersion=CLOUD_POLICY_VERSION;
  s.pacingMigration={at:new Date(this.now()).toISOString(),previousNextCheck,nextCheck:s.nextCheck,serverNotBefore:s.serverNotBefore||0};
 }

 async start(){return this.serial(async()=>{
  if(this.env.PUSH_MODE==='webpush'){if(!this.env.VAPID_PUBLIC_KEY||!this.env.VAPID_PRIVATE_KEY||!this.env.SETUP_TOKEN)throw Error('Configure phone push first.');}
  else if(!this.env.NTFY_TOPIC||!/^[A-Za-z0-9_-]{20,64}$/.test(this.env.NTFY_TOPIC))throw Error('Configure a random ntfy topic of 20–64 characters before starting.');
  const s=await this.state();this.migrateCloudPolicy(s);s.enabled=true;s.nextCheck=Math.max(this.now()+1000,s.cooldownUntil||0,s.serverNotBefore||0,s.nextCheck||0,s.lastAttemptAt?Date.parse(s.lastAttemptAt)+s.pollIntervalMs:s.lastCheck?Date.parse(s.lastCheck)+s.pollIntervalMs:0);
  await this.save(s);await this.storage.setAlarm(s.nextCheck);return s;
 });}
 async stop(){return this.serial(async()=>{const s=await this.state();s.enabled=false;s.nextCheck=null;await this.save(s);await this.storage.deleteAlarm();return s;});}
 async publish(message){
  if(this.env.PUSH_MODE==='webpush')return publishPush(this.storage,this.env,message,this.now());
  const headers={'Content-Type':'application/json'};
  if(this.env.NTFY_TOKEN)headers.Authorization='Bearer '+this.env.NTFY_TOKEN;
  const r=await this.fetcher('https://ntfy.sh/',{method:'POST',headers,body:JSON.stringify({...message,topic:this.env.NTFY_TOPIC}),signal:AbortSignal.timeout(10000)});
  if(!r.ok){const err=new Error(`Notification delivery failed: HTTP ${r.status}`);err.retryMs=Math.max(60000,retryDelay(r.headers.get('Retry-After'),this.now()));throw err;}
  const d=await r.json();if(d.event!=='message'||!d.id)throw Error('Notification service did not confirm the message.');return {id:d.id,acceptedAt:new Date(this.now()).toISOString()};
 }
 async testNotification(){return this.serial(async()=>{
  if(this.env.PUSH_MODE!=='webpush'&&!this.env.NTFY_TOPIC)throw Error('Configure notifications first.');
  return this.publish({title:'TEST — iPhone pickup monitor',message:'This is a delivery test, not a stock alert. The background monitor checks both 256GB colors at Holyoke, Evergreen Walk, Westfarms and New Haven for selectable pickup today OR tomorrow.',priority:4,tags:['test_tube'],click:orderUrl(products[0])});
 });}
 nativeSchedule(s){return Math.max(this.now()+INTERVAL,(s.nativeLease?.expiresAt||0)+1000,s.nextCheck||0);}
 async nativeActivate(){return this.serial(async()=>{
  const s=await this.state();
  if(s.sourceMode!=='native'){
   s.sourceMode='native';s.nativeActivatedAt=new Date(this.now()).toISOString();s.nativeLease=null;
   // Migration changes the collector, never an outstanding source cooldown.
   s.nextCheck=Math.max(this.now()+1000,s.nextCheck||0,s.cooldownUntil||0);s.pollIntervalMs=INTERVAL;
  }
  s.enabled=true;await this.save(s);await this.storage.setAlarm(this.nativeSchedule(s));
  return {mode:s.sourceMode,enabled:s.enabled,notBefore:s.nextCheck,cooldownUntil:s.cooldownUntil,intervalMs:INTERVAL};
 });}
 async nativeClaim(){return this.serial(async()=>{
  const s=await this.state(),now=this.now();
  if(s.sourceMode!=='native')throw Object.assign(Error('Native collector is not activated.'),{status:409});
  s.nativeLastSeenAt=new Date(now).toISOString();
  if(!s.enabled){await this.save(s);return {eligible:false,paused:true,notBefore:now+60000};}
  const notBefore=Math.max(s.cooldownUntil||0,s.nextCheck||0,s.nativeLease?.expiresAt||0);
  if(notBefore>now){await this.save(s);return {eligible:false,notBefore,sourceHealth:s.sourceHealth,intervalMs:s.pollIntervalMs};}
  const lease={id:crypto.randomUUID(),startedAt:now,expiresAt:now+WATCHDOG_MS};
  s.nativeLease=lease;s.checkInProgress=true;s.lastAttemptAt=new Date(now).toISOString();s.nextCheck=now+INTERVAL;
  await this.save(s);await this.storage.setAlarm(lease.expiresAt+1000);
  return {eligible:true,lease,prices:s.prices,intervalMs:s.pollIntervalMs};
 });}
 async nativeReport(body){return this.serial(async()=>{
  const s=await this.state();
  if(s.sourceMode!=='native')throw Object.assign(Error('Native collector is not activated.'),{status:409});
  if(typeof body?.id!=='string')throw Object.assign(Error('Native lease is required.'),{status:400});
  if(s.nativeReceipt?.id===body.id)return {...s.nativeReceipt,duplicate:true};
  if(!s.nativeLease||s.nativeLease.id!==body.id||s.nativeLease.expiresAt<this.now())throw Object.assign(Error('Native lease expired or does not match.'),{status:409});
  let replay;try{replay=replaySourceFrames(body.frames);}catch(e){throw Object.assign(e,{status:400});}
  const result=await scan(replay,s.nativeLease.startedAt,s.prices,this.now,{maxAgeMs:NATIVE_MAX_AGE_MS,parallelPrices:true});
  result.source={...result.source,transport:'native-mac'};
  await this.applyResult(s,result,s.nativeLease.startedAt);
  s.nativeLease=null;s.checkInProgress=false;s.nativeLastSeenAt=new Date(this.now()).toISOString();
  s.nativeReceipt={id:body.id,acceptedAt:s.nativeLastSeenAt,notBefore:s.nextCheck,healthy:result.healthy,httpStatus:result.source?.httpStatus||null,known:result.options.filter(o=>o.status!=='UNKNOWN').length,intervalMs:s.pollIntervalMs,cooldownUntil:s.cooldownUntil,enabled:s.enabled};
  await this.save(s);if(s.enabled)await this.storage.setAlarm(this.nativeSchedule(s));
  return s.nativeReceipt;
 });}
 async nativeWatchdog(s){
  if(s.nativeLease&&s.nativeLease.expiresAt<this.now()){
   s.nativeLease=null;s.checkInProgress=false;s.sourceHealth='degraded';s.failureKind='native_timeout';
   s.lastError='Native collector did not complete its reserved check. Availability is UNKNOWN.';
   s.lastResult=products.flatMap(p=>stores.map(store=>parseStore(null,p,store,null,new Date(this.now()))));
  }
  // A missing Mac never causes a second cloud collector to hit Apple.
  await this.save(s);await this.storage.setAlarm(this.nativeSchedule(s));
 }
 async applyResult(s,result,startedAt=this.now()){
   if(s.sourceMode==='cloud'){
    const previous=s.recentChecks?.[0],gap=startedAt-Date.parse(previous?.startedAt||previous?.at||'');
    const follows=previous?.healthy&&Number.isFinite(gap)&&gap>=0&&gap<=targetInterval(s,this.now())+2000;
    if(result.healthy){
     if(!follows||!s.cloudHealthySince){s.cloudHealthySince=new Date(startedAt).toISOString();s.cloudHealthySamples=1;}
     else s.cloudHealthySamples=(s.cloudHealthySamples||0)+1;
    }else{s.cloudHealthySince=null;s.cloudHealthySamples=0;}
   }
   s.stockEvents=recordStockEvents(s.stockEvents,result.options,this.now());
   // The production coordinator is observe-only and has no browser/submitter.
   // Persist the event independently of push delivery; errors cannot suppress alerts.
   try{await this.checkout.offer(result.options,s.stockEvents);s.checkoutCoordinationError=null;}
   catch{s.checkoutCoordinationError='Checkout event recording failed; purchasing remains disabled.';}
   s.checks++;s.lastCheck=new Date(this.now()).toISOString();s.lastResult=result.options;s.prices=result.prices;
   s.lastError=result.errors.length?result.errors.join('; '):null;s.source=result.source;s.failureKind=result.failureKind;
   s.failures=result.healthy?0:s.failures+1;
   s.transientFailures=result.healthy||result.dataIssue?0:s.transientFailures+1;
   s.healthyStreak=result.healthy?s.healthyStreak+1:0;
   if(result.healthy){s.lastVerifiedAt=s.lastCheck;s.healthyChecks++;if(s.healthyStreak>=3)s.blockedFailures=0;}
   let delay;
   if(s.sourceMode==='cloud'){
    s.pollIntervalMs=targetInterval(s,this.now());
    s.serverNotBefore=result.serverRetryMs?this.now()+result.serverRetryMs:0;
    if(result.blocked||result.failureKind==='rate_limited'){
     s.blockedFailures++;s.lastRateLimitAt=s.lastCheck;
     const fallback=Math.min(CLOUD_REJECT_MAX_MS,CLOUD_REJECT_BASE_MS*2**Math.min(3,s.blockedFailures-1));
     delay=Math.max(CLOUD_REJECT_BASE_MS,result.serverRetryMs||fallback);s.cooldownUntil=this.now()+delay;
    }else{delay=s.pollIntervalMs;s.cooldownUntil=s.serverNotBefore;}
   }else{
   if(result.healthy){
    s.rateStableSince ||=this.now();s.rateStableChecks=(s.rateStableChecks||0)+1;
    if(s.pollIntervalMs>INTERVAL&&s.rateStableChecks>=60&&this.now()-s.rateStableSince>=SPEED_RECOVERY_MS){s.pollIntervalMs=Math.max(INTERVAL,Math.ceil(s.pollIntervalMs*.75/1000)*1000);s.rateStableSince=this.now();s.rateStableChecks=0;}
   }else{s.rateStableSince=null;s.rateStableChecks=0;}
   if(result.blocked||result.failureKind==='rate_limited'){
    s.pollIntervalMs=Math.min(MAX_RECOVERY_INTERVAL_MS,Math.max(RECOVERY_INTERVAL_MS,s.pollIntervalMs*2));s.lastRateLimitAt=s.lastCheck;
   }
   // Stale HTTP 200 data is not an access block: probe steadily instead of compounding to 15 minutes.
   delay=Math.max(s.pollIntervalMs,result.retryMs,result.dataIssue?ERROR_RETRY_MS:result.errors.length?Math.min(900000,ERROR_RETRY_MS*2**Math.min(4,s.transientFailures-1)):0);
   // Native transient failures keep the ten-second cadence. Explicit server
   // Retry-After, rate limits, blocks and access denial still take precedence.
   if(s.sourceMode==='native'&&!result.blocked&&!result.hardStop&&result.failureKind!=='rate_limited')delay=Math.max(s.pollIntervalMs,result.serverRetryMs||0);
   if(result.blocked){s.blockedFailures++;delay=Math.max(delay,Math.min(60*60*1000,BLOCK_COOLDOWN*2**Math.min(2,s.blockedFailures-1)));s.cooldownUntil=this.now()+delay;}
   else if((s.cooldownUntil||0)<=this.now())s.cooldownUntil=0;
   }
   s.sourceHealth=result.blocked?'blocked':result.healthy?'healthy':result.hardStop?'denied':'degraded';
   s.recentChecks=[{at:s.lastCheck,startedAt:new Date(startedAt).toISOString(),durationMs:this.now()-startedAt,transport:result.source?.transport||(s.sourceMode==='native'?'native-mac':'cloud'),healthy:result.healthy,httpStatus:result.source?.httpStatus||null,known:result.options.filter(o=>o.status!=='UNKNOWN').length,error:s.lastError},...(s.recentChecks||[])].slice(0,60);
   const known=new Set(s.activeKeys);
   const available=currentOptions(result.options,this.now()).filter(o=>o.status==='AVAILABLE');
   // UNKNOWN does not reset duplicate suppression; only confirmed negatives do.
   for(const o of result.options){if(o.status==='NOT AVAILABLE')for(const key of known){if(key.startsWith(`${o.storeId}:${o.part}:`))known.delete(key);}}
   const fresh=available.filter(o=>!known.has(keyFor(o)));
   if(fresh.length&&this.now()>=(s.notificationRetryAt||0)){
    try{
     const receipt=await this.publish(stockMessage(fresh));
     for(const o of fresh)known.add(keyFor(o));
     s.lastNotification={...receipt,options:fresh.map(o=>({store:o.store,color:o.color,capacityGb:o.capacityGb,part:o.part,pickupDate:o.pickupDate,order:o.order}))};s.notificationError=null;s.notificationRetryAt=0;
    }catch(e){s.notificationError=e.message;s.notificationRetryAt=this.now()+Math.max(ERROR_RETRY_MS,e.retryMs||0);}
   }
   const allowedDates=dates(new Date(this.now()));
   s.activeKeys=[...known].filter(k=>allowedDates.some(d=>k.includes(':'+d+':')));
   if(result.hardStop){s.enabled=false;s.nextCheck=null;s.lastError='Apple denied access (HTTP 403); monitoring paused. Availability is UNKNOWN.';await this.storage.deleteAlarm();}
   else if(s.sourceMode==='cloud'){s.nextCheck=result.blocked||result.failureKind==='rate_limited'?this.now()+delay:Math.max(this.now()+500,startedAt+delay,s.serverNotBefore||0);}
   else{s.nextCheck=result.healthy?Math.max(this.now()+1000,startedAt+delay):this.now()+delay;}
 }
 async alarm(){return this.serial(async()=>{
  let s=await this.state();if(!s.enabled)return;this.migrateCloudPolicy(s);
  if(s.sourceMode==='native')return this.nativeWatchdog(s);
  // Once Google is selected, a missing secret must fail closed instead of
  // silently creating a different Apple collector after a deployment.
  if(s.sourceSession?.kind==='google'&&this.sourceClient instanceof AppleSession)this.sourceClient=new GoogleSource(undefined,{fetcher:this.fetcher,now:this.now});
  const lastAttempt=Date.parse(s.lastAttemptAt||s.lastCheck||'');
  const notBefore=Math.max(s.cooldownUntil||0,s.serverNotBefore||0,Number.isFinite(lastAttempt)?lastAttempt+s.pollIntervalMs:0,s.nextCheck||0);
  if(notBefore>this.now()){s.nextCheck=notBefore;await this.save(s);await this.storage.setAlarm(notBefore);return;}
  // A fallback alarm survives an unexpected restart during network I/O.
  const startedAt=this.now();s.lastAttemptAt=new Date(startedAt).toISOString();s.checkInProgress=true;s.nextCheck=this.now()+WATCHDOG_MS;
  await this.storage.setAlarm(s.nextCheck);await this.save(s);
  try{
   const budget=AbortSignal.timeout(CLOUD_FETCH_BUDGET_MS);
   const priceCache=this.sourceClient.collect?Object.fromEntries(Object.entries(s.prices).filter(([,price])=>price?.verified&&this.now()>=Date.parse(price.checkedAt)&&this.now()-Date.parse(price.checkedAt)<PRICE_MAX_AGE_MS-20000)):s.prices;
   let replay=null,collectionError=null;
   if(this.sourceClient.collect)try{replay=await this.sourceClient.collect(priceCache,{signal:budget});}catch(error){collectionError=error;}
   const cloudFetch=(url,options)=>{if(collectionError)throw collectionError;return replay?replay(url):this.sourceClient.fetch(url,{...options,signal:AbortSignal.any([options.signal,budget])});};
   const result=await scan(cloudFetch,this.now(),priceCache,this.now,{maxAgeMs:CLOUD_MAX_AGE_MS,parallelPrices:true});
   s.sourceSession=await this.sourceClient.diagnostics();
   if(s.sourceSession.kind==='google')result.source={...result.source,transport:'google'};
   await this.applyResult(s,result,startedAt);
  }catch(e){s.lastError=e.message;s.failureKind='internal_error';s.sourceHealth='degraded';s.lastResult=products.flatMap(p=>stores.map(store=>parseStore(null,p,store,null,new Date(this.now()))));s.nextCheck=this.now()+ERROR_RETRY_MS;}
  finally{s.checkInProgress=false;await this.save(s);if(s.enabled)await this.storage.setAlarm(s.nextCheck||this.now()+60000);}
 });}
}
