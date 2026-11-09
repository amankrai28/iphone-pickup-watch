import test from 'node:test';
import assert from 'node:assert/strict';
import {AppleSession,parseCookie,cookieHeader} from '../src/apple-session.mjs';
import {products,orderUrl,batchSourceUrl} from '../src/apple.mjs';
class Storage{data=new Map();async get(key){return structuredClone(this.data.get(key));}async put(key,value){this.data.set(key,structuredClone(value));}}
const now=Date.parse('2026-10-28T14:00:00Z'),options={headers:{'User-Agent':'iPhonePickupWatch/2.0',Accept:'application/json'},signal:AbortSignal.timeout(10000)};
test('cookie matching enforces origin, path, secure transport and server expiry',()=>{
 const cookie=parseCookie('dssid2=opaque; Domain=.apple.com; Path=/shop; Secure; Max-Age=60; HttpOnly',orderUrl(products[0]),now);
 assert.equal(cookieHeader([cookie],batchSourceUrl(),now),'dssid2=opaque');
 assert.equal(cookieHeader([cookie],'https://evil.test/shop',now),'');assert.equal(cookieHeader([cookie],'http://www.apple.com/shop',now),'');assert.equal(cookieHeader([cookie],'https://www.apple.com/shopping',now),'');assert.equal(cookieHeader([cookie],batchSourceUrl(),now+60000),'');
 assert.equal(parseCookie('a=x; Domain=evil.test',batchSourceUrl(),now),null);assert.equal(parseCookie('cf_clearance=challenge; Path=/',batchSourceUrl(),now),null);assert.equal(parseCookie('_abck=challenge; Path=/',batchSourceUrl(),now),null);
});
test('one ordinary bootstrap persists across restarts; subsequent requests retain the shopping session',async()=>{
 const storage=new Storage(),calls=[];
 const fetcher=async(url,request)=>{calls.push({url,cookie:request.headers.get('Cookie'),redirect:request.redirect});return new Response('<html>public Apple page</html>',{headers:{Date:new Date(now).toUTCString(),...(url===orderUrl(products[0])?{'Set-Cookie':'dssid2=opaque; Path=/shop; Secure; HttpOnly'}:{})}});};
 await new AppleSession(storage,{fetcher,now:()=>now}).fetch(batchSourceUrl(),options);
 await new AppleSession(storage,{fetcher,now:()=>now+10000}).fetch(batchSourceUrl(),options);
 assert.deepEqual(calls.map(call=>call.url),[orderUrl(products[0]),batchSourceUrl(),batchSourceUrl()]);assert.equal(calls[0].cookie,null);assert.equal(calls[1].cookie,'dssid2=opaque');assert.equal(calls[2].cookie,'dssid2=opaque');assert.ok(calls.every(call=>call.redirect==='manual'));
 const diagnostics=await new AppleSession(storage,{fetcher,now:()=>now}).diagnostics();assert.equal(diagnostics.ready,true);assert.equal(diagnostics.cookieCount,1);assert.equal(JSON.stringify(diagnostics).includes('opaque'),false);
});
test('a rejected inventory response cannot reset cookies or trigger another bootstrap',async()=>{
 const storage=new Storage(),calls=[];let blocked=false;
 const fetcher=async(url,request)=>{calls.push(url);if(url===orderUrl(products[0]))return new Response('page',{headers:{Date:new Date(now).toUTCString(),'Set-Cookie':'dssid2=original; Path=/shop; Secure'}});assert.equal(request.headers.get('Cookie'),'dssid2=original');return blocked?new Response('blocked',{status:541,headers:{'Set-Cookie':'dssid2=replacement; Path=/shop'}}):new Response('inventory');};
 const session=new AppleSession(storage,{fetcher,now:()=>now});await session.fetch(batchSourceUrl(),options);blocked=true;const rejected=await session.fetch(batchSourceUrl(),options);assert.equal(rejected.status,541);await rejected.body.cancel();
 await new AppleSession(storage,{fetcher,now:()=>now+120000}).fetch(batchSourceUrl(),options);assert.equal(calls.filter(url=>url===orderUrl(products[0])).length,1);
});
test('session credentials are never sent to another host or arbitrary Apple paths',async()=>{
 const storage=new Storage(),calls=[];const session=new AppleSession(storage,{fetcher:async(url)=>{calls.push(url);return new Response('page');},now:()=>now});
 await assert.rejects(session.raw('https://evil.test/',options),/Unexpected/);await assert.rejects(session.raw('https://www.apple.com/shop/bag',options),/Unexpected/);assert.equal(calls.length,0);
});
test('parallel cookie updates merge instead of overwriting the other response',async()=>{
 const storage=new Storage(),session=new AppleSession(storage,{now:()=>now,fetcher:async url=>new Response('page',{headers:{'Set-Cookie':(url.includes('night-sky')?'as_black=one':'as_white=two')+'; Path=/shop; Secure'}})});
 await Promise.all(products.map(product=>session.raw(orderUrl(product),options)));
 const state=await session.state();assert.equal(state.cookies.length,2);assert.match(cookieHeader(state.cookies,batchSourceUrl(),now),/as_black=one/);assert.match(cookieHeader(state.cookies,batchSourceUrl(),now),/as_white=two/);
});
