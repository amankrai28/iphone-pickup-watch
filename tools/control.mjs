// Usage: PICKUP_ADMIN_TOKEN=<secret> node tools/control.mjs <worker origin> status|test|start|pause
const [origin,command]=process.argv.slice(2);
if(!origin||!['status','test','start','pause'].includes(command)||!process.env.PICKUP_ADMIN_TOKEN){console.error('Provide the Worker HTTPS origin, command, and PICKUP_ADMIN_TOKEN environment variable.');process.exit(1);}
const target=new URL(origin);if(target.protocol!=='https:'&&target.hostname!=='localhost')throw Error('HTTPS is required.');
const r=await fetch(new URL('/'+command,target),{method:command==='status'?'GET':'POST',headers:{Authorization:'Bearer '+process.env.PICKUP_ADMIN_TOKEN,'User-Agent':'iPhonePickupWatch-Control/1.0'},signal:AbortSignal.timeout(30000)});
const body=await r.text();if(!r.ok){console.error('Control request failed: HTTP '+r.status);process.exit(1);}console.log(body);
