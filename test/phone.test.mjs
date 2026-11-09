import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {serviceWorker,clientScript,phoneAssets} from '../src/phone.mjs';
const origin='https://watch.test',base='/setup/test-private-setup-only/';
function runtime(){
 const handlers={},tables=new Map(),shown=[],opened=[],receipts=[],windows=[],launch={reject:false},lifecycle={skipped:0,claimed:0,assets:[]};
 const caches={open:async name=>{if(!tables.has(name))tables.set(name,new Map());const m=tables.get(name);return {put:async(k,v)=>m.set(typeof k==='string'?k:k.url,v),match:async(k,opts={})=>{const key=typeof k==='string'?k:k.url;if(m.has(key))return m.get(key).clone();if(opts.ignoreSearch){const hit=[...m.keys()].find(x=>new URL(x,origin).pathname===new URL(key,origin).pathname);if(hit)return m.get(hit).clone();}return undefined;},addAll:async assets=>lifecycle.assets.push(...assets)};}};
 const self={location:{origin},skipWaiting:async()=>{lifecycle.skipped++;},clients:{claim:async()=>{lifecycle.claimed++;},matchAll:async()=>windows,openWindow:async u=>{opened.push(u);if(launch.reject&&u.startsWith('https://www.apple.com/'))throw Error('External launch refused');return null;}},registration:{showNotification:async(title,data)=>shown.push({title,data})},addEventListener:(kind,fn)=>handlers[kind]=fn};
 const net={fail:false};const fetcher=async request=>{if(net.fail)throw Error('Offline');if(typeof request==='string'&&request.includes('/api/received')){receipts.push(request);return new Response('{}');}return new Response('<h1>iPhone Pickup</h1>',{headers:{'Content-Type':'text/html'}});};
 vm.runInNewContext(serviceWorker,{self,caches,Response,URL,fetch:fetcher,encodeURIComponent});
 const event=async(type,data={})=>{let p;handlers[type]({...data,waitUntil:x=>p=x,respondWith:x=>p=x});return p;};
 return {event,shown,opened,receipts,net,windows,launch,lifecycle};
}
test('public shortcut roots render recovery without exposing private setup',async()=>{for(const path of ['/','/iphone-pickup']){const r=phoneAssets(new Request(origin+path),{SETUP_TOKEN:'test-private-setup-only'});assert.equal(r.status,200);const h=await r.text();assert.match(h,/Reopen your private setup link/);assert.equal(h.includes('test-private-setup-only'),false);}new vm.Script(clientScript);});
test('root shortcut recovers the private starting page and offline shell remains visible',async()=>{const r=runtime();await r.event('message',{data:{type:'REMEMBER_START'},source:{url:origin+base}});const root=await r.event('fetch',{request:{url:origin+'/',method:'GET',mode:'navigate'}});assert.equal(root.status,302);assert.equal(root.headers.get('location'),origin+base);await r.event('fetch',{request:{url:origin+base,method:'GET',mode:'navigate'}});r.net.fail=true;const cached=await r.event('fetch',{request:{url:origin+base+'?alert=old',method:'GET',mode:'navigate'}});assert.match(await cached.text(),/iPhone Pickup/);});
test('legacy notifications retain the private details route and old-data recovery',async()=>{const r=runtime();await r.event('push',{data:{json:()=>({title:'AVAILABLE',body:'fixture',url:'https://www.apple.com/xc/product/MK1E4LL/A',id:'fixture-id',receipt:base+'api/received'})}});assert.equal(r.shown.length,1);assert.equal(r.shown[0].data.data.target,base+'?alert=fixture-id');assert.equal(r.receipts[0],base+'api/received');await r.event('notificationclick',{notification:{close(){},data:r.shown[0].data.data}});assert.equal(r.opened[0],origin+base+'?alert=fixture-id');await r.event('notificationclick',{notification:{close(){},data:{url:'https://www.apple.com/shop/buy-iphone/iphone-duo/old'}}});assert.equal(r.opened[1],origin+base);});
test('external messages cannot replace the saved private launch route; offline has useful recovery',async()=>{const r=runtime();await r.event('message',{data:{type:'REMEMBER_START'},source:{url:'https://evil.test'+base}});r.net.fail=true;const page=await r.event('fetch',{request:{url:origin+'/',method:'GET',mode:'navigate'}});assert.equal(page.status,503);assert.match(await page.text(),/availability is UNKNOWN/);});

const stock=(url='https://www.apple.com/xc/product/MK1F4LL/A')=>({title:'AVAILABLE — iPhone Duo pickup',kind:'stock',body:'fixture',url,id:'fixture-stock',receipt:base+'api/received'});
const notify=async(r,p)=>{await r.event('push',{data:{json:()=>p}});return r.shown.at(-1).data.data;};
const tap=(r,data)=>r.event('notificationclick',{notification:{close(){},data}});
test('distinct stock alerts keep separate tags and tapping does not explicitly close the notification',async()=>{
 const r=runtime();const first=await notify(r,stock());await notify(r,{...stock(),id:'second-stock'});assert.notEqual(r.shown[0].data.tag,r.shown[1].data.tag);
 let closed=false;await r.event('notificationclick',{notification:{close(){closed=true;},data:first}});assert.equal(closed,false);assert.equal(r.opened[0],stock().url);
});
test('Home Screen app exposes saved history and explains platform retention and capacity scope',async()=>{
 const r=phoneAssets(new Request(origin+base),{SETUP_TOKEN:'test-private-setup-only'});const html=await r.text();assert.match(html,/href="#alert-history"/);assert.match(html,/latest 80 stock alerts/);assert.match(html,/iOS controls Notification Center retention/);assert.match(html,/monitor 256GB only/);
});
test('stock body taps open each exact Apple Store product link directly, not the dashboard',async()=>{
 for(const url of ['https://www.apple.com/xc/product/MK1F4LL/A','https://www.apple.com/xc/product/MK1E4LL/A']){
  const r=runtime(),data=await notify(r,stock(url));assert.equal(data.appleUrl,url);assert.equal(r.receipts[0],base+'api/received');await tap(r,data);assert.deepEqual(r.opened,[url]);
 }
});
test('direct link survives service-worker restart and does not hijack an open dashboard',async()=>{
 const first=runtime(),data=await notify(first,stock());const afterRestart=runtime();let navigated=false;
 afterRestart.windows.push({url:origin+base,navigate:async()=>{navigated=true;},focus:async()=>{}});await tap(afterRestart,JSON.parse(JSON.stringify(data)));
 assert.equal(afterRestart.opened[0],stock().url);assert.equal(navigated,false);
});
test('test notifications stay on the dashboard even when their payload contains an allowed Apple URL',async()=>{
 const r=runtime(),data=await notify(r,{...stock(),title:'TEST — iPhone pickup monitor',kind:'test'});assert.equal(data.appleUrl,null);await tap(r,data);assert.deepEqual(r.opened,[origin+base+'?alert=fixture-stock']);
});
test('stock routing refuses arbitrary URLs, extra parameters, wrong variants and custom schemes',async()=>{
 for(const url of ['https://evil.test/','https://www.apple.com.evil.test/xc/product/MK1F4LL/A','https://www.apple.com@evil.test/xc/product/MK1F4LL/A','http://www.apple.com/xc/product/MK1F4LL/A','https://www.apple.com/xc/product/WRONG/A','https://www.apple.com/xc/product/MK1F4LL/A?redirect=https://evil.test','https://www.apple.com/xc/product/MK1F4LL/A#other','itms-apps://www.apple.com/xc/product/MK1F4LL/A','javascript:alert(1)']){
  const r=runtime(),data=await notify(r,stock(url));assert.equal(data.appleUrl,null);await tap(r,data);assert.equal(r.opened[0],origin+base+'?alert=fixture-stock');
 }
});
test('click revalidates stored external targets and missing stock classification fails closed',async()=>{
 for(const data of [{kind:'stock',appleUrl:'https://evil.test/',target:base},{kind:'test',appleUrl:stock().url,target:base},{appleUrl:stock().url,target:base}]){const r=runtime();await tap(r,data);assert.deepEqual(r.opened,[origin+base]);}
});
test('a browser rejection of external launch falls back to the existing private alert page',async()=>{
 const r=runtime(),data=await notify(r,stock());r.launch.reject=true;await tap(r,data);assert.deepEqual(r.opened,[stock().url,origin+base+'?alert=fixture-stock']);
});
test('a null cross-origin openWindow result is accepted without opening a second dashboard window',async()=>{
 const r=runtime(),data=await notify(r,stock());await tap(r,data);assert.equal(r.opened.length,1);
});
test('service-worker and client asset version updates preserve the saved private-start cache',()=>{
 assert.match(serviceWorker,/iphone-pickup-shell-v13/);assert.match(serviceWorker,/iphone-pickup-device-v1/);assert.match(serviceWorker,/phone-client\.js\?v=13/);
});

test('install and activate adopt v13 immediately without losing the existing private launch route',async()=>{const r=runtime();await r.event('message',{data:{type:'REMEMBER_START'},source:{url:origin+base}});await r.event('install');await r.event('activate');assert.equal(r.lifecycle.skipped,1);assert.equal(r.lifecycle.claimed,1);assert.ok(r.lifecycle.assets.includes('/phone-client.js?v=13'));const page=await r.event('fetch',{request:{url:origin+'/',method:'GET',mode:'navigate'}});assert.equal(page.headers.get('location'),origin+base);});
