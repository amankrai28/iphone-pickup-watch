import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {scan} from '../src/monitor.mjs';
import {captureSourceFrames} from '../src/native-source.mjs';
import {NATIVE_MAX_AGE_MS,NATIVE_FETCH_BUDGET_MS} from '../src/config.mjs';

export const ORIGIN='https://your-worker.example.com';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const RUN=path.join(ROOT,'.native-runtime');

export async function atomicJson(file,value){
 await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const temporary=file+'.'+process.pid+'.tmp';
 const handle=await fs.open(temporary,'w',0o600);
 try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
 await fs.rename(temporary,file);
}
export async function readJson(file,fallback=null){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
export function apiClient(token,fetcher=fetch){
 return async(route,body)=>{
  if(!['/native/activate','/native/claim','/native/report','/status'].includes(route))throw Error('Unsupported control route.');
  const response=await fetcher(ORIGIN+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','User-Agent':'iPhonePickupWatch-Control/1.0'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(25000)});
  let data;try{data=await response.json();}catch{throw Error('Relay returned unreadable data.');}
  if(!response.ok)throw Object.assign(Error('Relay HTTP '+response.status),{status:response.status});
  return data;
 };
}

// One server-issued lease owns an Apple attempt. A lost request/restart cannot
// create a second source collector, reset a cooldown, or duplicate a stock push.
export async function nativeCycle({api,journal,fetcher=fetch,now=()=>Date.now(),sourceBudgetMs=NATIVE_FETCH_BUDGET_MS}){
 const pending=await journal.read();
 if(pending?.frames){
  try{const receipt=await api('/native/report',pending);await journal.clear();return {kind:'reported',...receipt};}
  catch(error){if(error.status!==409)throw error;await journal.clear();}
 }
 const claim=await api('/native/claim',{});
 if(!claim.eligible)return {kind:claim.paused?'paused':'waiting',...claim};
 await journal.write({id:claim.lease.id,startedAt:claim.lease.startedAt});
 const deadline=AbortSignal.timeout(sourceBudgetMs);
 const capture=captureSourceFrames((url,options)=>fetcher(url,{...options,signal:AbortSignal.any([options.signal,deadline])}));
 await scan(capture.fetcher,claim.lease.startedAt,claim.prices,now,{maxAgeMs:NATIVE_MAX_AGE_MS,parallelPrices:true});
 const report={id:claim.lease.id,frames:capture.frames};
 await journal.write(report);
 const receipt=await api('/native/report',report);
 await journal.clear();
 return {kind:'reported',...receipt};
}

async function main(){
 await fs.mkdir(RUN,{recursive:true,mode:0o700});
 const credentials=await readJson(path.join(ROOT,'.cloudflare-auth','watch-secrets.json'));
 if(!credentials?.ADMIN_TOKEN)throw Error('The owner control credential is missing.');
 const api=apiClient(credentials.ADMIN_TOKEN);
 const pendingPath=path.join(RUN,'pending.json');
 const journal={read:()=>readJson(pendingPath),write:value=>atomicJson(pendingPath,value),clear:()=>fs.rm(pendingPath,{force:true})};
 const lockPath=path.join(RUN,'collector.lock');
 try{const old=await readJson(lockPath);if(old?.pid){try{process.kill(old.pid,0);throw Error('The native collector is already running.');}catch(error){if(error.code!=='ESRCH')throw error;await fs.rm(lockPath,{force:true});}}else if(old)await fs.rm(lockPath,{force:true});}catch(error){if(error instanceof SyntaxError)await fs.rm(lockPath,{force:true});else if(error.code!=='ENOENT')throw error;}
 const lock=await fs.open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));await lock.close();
 let running=true,wake=null,consecutiveErrors=0,lastKind=null;
 const stop=()=>{running=false;wake?.();};process.on('SIGTERM',stop);process.on('SIGINT',stop);
 const log=async value=>{
  const file=path.join(RUN,'checks.ndjson');
  try{if((await fs.stat(file)).size>2*1024*1024)await fs.rename(file,file+'.1');}catch(error){if(error.code!=='ENOENT')throw error;}
  await fs.appendFile(file,JSON.stringify(value)+'\n',{mode:0o600});
 };
 try{
  while(running){
   const started=Date.now();let wait=10000;
   try{
    const result=await nativeCycle({api,journal});consecutiveErrors=0;
    const record={at:new Date().toISOString(),pid:process.pid,kind:result.kind,healthy:result.healthy??null,known:result.known??null,httpStatus:result.httpStatus??null,intervalMs:result.intervalMs??10000,nextCheck:result.notBefore??null,cooldownUntil:result.cooldownUntil??null,durationMs:Date.now()-started};
    await atomicJson(path.join(RUN,'status.json'),record);
    if(result.kind==='reported'||result.kind!==lastKind)await log(record);
    lastKind=result.kind;
    // A control call waking slightly early is harmless: the server will not
    // grant another Apple lease before the authoritative due time.
    wait=result.paused?60000:Math.max(250,Number(result.notBefore||Date.now()+10000)-Date.now());
   }catch(error){
    consecutiveErrors++;wait=Math.min(60000,5000*2**Math.min(4,consecutiveErrors-1));
    const record={at:new Date().toISOString(),pid:process.pid,kind:'relay_error',error:error.status?'Relay HTTP '+error.status:'The collector could not complete its control request.',nextCheck:Date.now()+wait,durationMs:Date.now()-started};
    await atomicJson(path.join(RUN,'status.json'),record);await log(record);
   }
   if(process.argv.includes('--once'))break;
   if(running)await new Promise(resolve=>{const timer=setTimeout(resolve,Math.min(wait,60000));wake=()=>{clearTimeout(timer);resolve();};}).finally(()=>{wake=null;});
  }
 }finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await fs.rm(lockPath,{force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
