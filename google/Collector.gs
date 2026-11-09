// Sole production source. Fixed public Apple URLs only; no Apple account,
// payment, notification credentials, proxy rotation or automatic fallback.
var PARTS=['MK1F4LL/A','MK1E4LL/A'];
var SLUGS=['night-sky','star-white'];
var STORES=['R191','R613','R025','R446'];
var INVENTORY='https://www.apple.com/shop/retail/pickup-message?pl=true&location=01040&parts.0=MK1F4LL%2FA&parts.1=MK1E4LL%2FA';
var UA='iPhonePickupWatch/2.0 (+https://your-worker.example.com)';
function doGet(){return ContentService.createTextOutput('Private stock collector.').setMimeType(ContentService.MimeType.TEXT);}
function output_(value){value.completedAt=Date.now();return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);}
function hex_(bytes){return bytes.map(function(b){return ('0'+(b&255).toString(16)).slice(-2);}).join('');}
function equal_(a,b){if(typeof a!=='string'||a.length!==b.length)return false;var mismatch=0;for(var i=0;i<a.length;i++)mismatch|=a.charCodeAt(i)^b.charCodeAt(i);return mismatch===0;}
function options_(json,deadline){return {method:'get',followRedirects:false,muteHttpExceptions:true,validateHttpsCertificates:true,timeoutSeconds:Math.max(1,Math.min(7,Math.floor((deadline-Date.now())/1000))),headers:{Accept:json?'application/json':'text/html','Cache-Control':'no-cache','User-Agent':UA}};}
function frame_(url,response){
 var all=response.getAllHeaders(),headers={},allowed=['date','age','cache-control','retry-after','content-type'];
 Object.keys(all).forEach(function(name){var k=name.toLowerCase();if(allowed.indexOf(k)>=0)headers[k]=String(all[name]).slice(0,1024);});
 var body=response.getContentText(),status=response.getResponseCode();
 if(body.length>2*1024*1024)throw new Error('Source response exceeds collector limit.');
 if(status!==200)body=body.slice(0,4096);
 else if(url===INVENTORY){
  var data=JSON.parse(body),rows=data&&data.body&&data.body.stores;
  if(Array.isArray(rows))body=JSON.stringify({body:{stores:rows.filter(function(r){return r&&STORES.indexOf(r.storeNumber)>=0;}).map(function(r){var parts={};PARTS.forEach(function(p){var a=r.partsAvailability&&r.partsAvailability[p],regular=a&&a.messageTypes&&a.messageTypes.regular;if(a)parts[p]={partNumber:a.partNumber,storePickEligible:a.storePickEligible,pickupSearchQuote:a.pickupSearchQuote,messageTypes:{regular:{storeSelectionEnabled:regular&&regular.storeSelectionEnabled,storePickupProductTitle:regular&&regular.storePickupProductTitle}}};});return {storeNumber:r.storeNumber,retailStore:{lastFetched:r.retailStore&&r.retailStore.lastFetched},partsAvailability:parts};})}});
 }else{
  body=(body.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi)||[]).join('\n')+'\n'+(body.indexOf('Connect to any carrier later')>=0?'Connect to any carrier later':'');
 }
 return {url:url,status:status,headers:headers,body:body};
}
function hasCandidate_(frame,part){
 try{return JSON.parse(frame.body).body.stores.some(function(r){var a=r.partsAvailability[part],regular=a&&a.messageTypes&&a.messageTypes.regular;return a&&a.partNumber===part&&a.storePickEligible===true&&regular&&regular.storeSelectionEnabled===true&&/^Available\s+(Today|Tomorrow)\b/i.test(String(a.pickupSearchQuote));});}catch(_){return false;}
}
function hold_(state,frames){
 var limited=frames.filter(function(f){return f.status===541||f.status===429;});
 if(limited.length){
  state.blocked=(state.blocked||0)+1;state.good=0;var delay=Math.min(300000,60000*Math.pow(2,Math.min(3,state.blocked-1)));
  limited.forEach(function(f){var value=f.headers['retry-after'],seconds=Number(value),at=Date.parse(value||'');if(value&&Number.isFinite(seconds))delay=Math.max(delay,seconds*1000);else if(Number.isFinite(at))delay=Math.max(delay,at-Date.now());});
  state.notBefore=Date.now()+delay;
 }else if(frames.some(function(f){return f.status===403;})){state.denied=true;state.notBefore=Date.now()+86400000;}
 else if(frames.every(function(f){return f.status===200;})){state.good=(state.good||0)+1;if(state.good>=3)state.blocked=0;}
}
function doPost(event){
 var id=null,lock=null,properties=PropertiesService.getScriptProperties(),state=null;
 try{
  var body=event&&event.postData&&event.postData.contents;if(typeof body!=='string'||body.length>4096)return output_({ok:false,id:id,code:'authentication'});
  var envelope=JSON.parse(body),secret=properties.getProperty('COLLECTOR_KEY');
  if(!/^[a-f0-9]{64}$/.test(secret||'')||typeof envelope.payload!=='string'||envelope.payload.length>2048)return output_({ok:false,id:id,code:'authentication'});
  var expected=hex_(Utilities.computeHmacSha256Signature(envelope.payload,secret,Utilities.Charset.UTF_8));
  if(!equal_(envelope.signature,expected))return output_({ok:false,id:id,code:'authentication'});
  var request=JSON.parse(envelope.payload);id=request.id;
  if(request.v!==1||typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)||!Number.isFinite(request.issuedAt)||Math.abs(Date.now()-request.issuedAt)>30000||!Array.isArray(request.neededPrices)||request.neededPrices.length>2||request.neededPrices.some(function(p){return PARTS.indexOf(p)<0;})||new Set(request.neededPrices).size!==request.neededPrices.length)return output_({ok:false,id:id,code:'request'});
  lock=LockService.getScriptLock();if(!lock.tryLock(1))return output_({ok:false,id:id,code:'wait',notBefore:Date.now()+10000});
  state=JSON.parse(properties.getProperty('COLLECTOR_STATE')||'{}');
  // The sole scheduler targets 10 seconds. RPC arrival times can vary by
  // several seconds, so the transport guard must not reject healthy cadence.
  var notBefore=Math.max(state.notBefore||0,(state.lastStart||0)+5000);
  if(state.denied||notBefore>Date.now()||state.lastId===id||(state.recentIds||[]).indexOf(id)>=0)return output_({ok:false,id:id,code:'wait',notBefore:Math.max(notBefore,Date.now()+1000)});
  var day=new Date().toISOString().slice(0,10);if(state.day!==day){state.day=day;state.calls=0;}
  if((state.calls||0)+3>18000)return output_({ok:false,id:id,code:'wait',notBefore:Date.now()+3600000});
  state.lastStart=Date.now();state.lastId=id;state.recentIds=[id].concat(state.recentIds||[]).slice(0,8);state.calls=(state.calls||0)+1;
  properties.setProperty('COLLECTOR_STATE',JSON.stringify(state));
  var deadline=Date.now()+6500,frames=[frame_(INVENTORY,UrlFetchApp.fetch(INVENTORY,options_(true,deadline)))];
  if(frames[0].status===200&&Date.now()<deadline-1500){
   var needed=request.neededPrices.filter(function(part){return hasCandidate_(frames[0],part);});
   if(needed.length){
    state.calls+=needed.length;properties.setProperty('COLLECTOR_STATE',JSON.stringify(state));
    var urls=needed.map(function(p){return 'https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-'+SLUGS[PARTS.indexOf(p)]+'-unlocked';});
    var responses=UrlFetchApp.fetchAll(urls.map(function(url){var opts=options_(false,deadline);opts.url=url;return opts;}));
    var priceFrames=responses.map(function(response,index){return frame_(urls[index],response);});frames=frames.concat(priceFrames);
   }
  }
  hold_(state,frames);properties.setProperty('COLLECTOR_STATE',JSON.stringify(state));
  return output_({ok:true,id:id,frames:frames});
 }catch(error){
  var quota=/quota|too many times|limit exceeded|too much computer time/i.test(String(error&&error.message));
  if(state&&quota){state.notBefore=Date.now()+3600000;try{properties.setProperty('COLLECTOR_STATE',JSON.stringify(state));}catch(_){}}
  var category=/timed out|timeout/i.test(String(error&&error.message))?'timeout':/JSON|Unexpected token/i.test(String(error&&error.message))?'invalid_json':'source_error';
  return output_({ok:false,id:id,code:quota?'wait':'source_error',errorCategory:category,notBefore:quota?Date.now()+3600000:0});
 }finally{if(lock&&lock.hasLock())lock.releaseLock();}
}
