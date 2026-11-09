import {STOCK_MAX_AGE_MS, PRICE_MAX_AGE_MS} from './config.mjs';
export const products = [
  {color:'Night Sky',capacityGb:256,part:'MK1F4LL/A',slug:'night-sky',tone:'black'},
  {color:'Star White',capacityGb:256,part:'MK1E4LL/A',slug:'star-white',tone:'white'},
]         ;
export const stores = [
  {name:'Holyoke',id:'R191',city:'Holyoke, MA',address:'50 Holyoke Street, Holyoke, MA 01040'},
  {name:'Evergreen Walk',id:'R613',city:'South Windsor, CT',address:'401 Evergreen Walk, South Windsor, CT 06074'},
  {name:'Westfarms',id:'R025',city:'Farmington, CT',address:'500 Westfarms Mall, Farmington, CT 06032'},
  {name:'New Haven',id:'R446',city:'New Haven, CT',address:'65 Broadway, New Haven, CT 06511'},
]         ;
export const orderUrl = (p                        ) => `https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-${p.slug}-unlocked`;
export const appOrderUrl = p => `https://www.apple.com/xc/product/${p.part}`;
export const sourceUrl = (p                        ) => `https://www.apple.com/shop/retail/pickup-message?pl=true&location=01040&parts.0=${encodeURIComponent(p.part)}`;
export const batchSourceUrl = () => 'https://www.apple.com/shop/retail/pickup-message?pl=true&location=01040&'+products.map((p,i)=>`parts.${i}=${encodeURIComponent(p.part)}`).join('&');
export function dates(now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const next = new Date(today+'T12:00:00Z'); next.setUTCDate(next.getUTCDate()+1);
  return [today, next.toISOString().slice(0,10)];
}
                                                                                           
                                                                                                                                                                                                                                                                                                                       
// Only exact-part pickup signals count. Store-level availableNow is never read.
export function parseStore(s    ,p                        ,store                      ,price           ,now = new Date(),observation=null)        {
 const a = s?.partsAvailability?.[p.part], reg = a?.messageTypes?.regular;
 const quote = String(a?.pickupSearchQuote||'').replace(/<[^>]*>/g,'').trim();
 // lastFetched belongs to store metadata, not the part-level stock observation.
 // Live scans supply the response Date/Age evidence; legacy callers remain conservative.
 const storeStamp=s?.retailStore?.lastFetched;
 const stamp = observation?Date.parse(observation.responseTimestamp):storeStamp;
 const maxAgeMs=Math.min(STOCK_MAX_AGE_MS,observation?.maxAgeMs||STOCK_MAX_AGE_MS);
 const validStamp=typeof stamp==='number'&&Number.isFinite(new Date(stamp).getTime());
 const result        = {store:store.name,storeId:store.id,city:store.city,address:store.address,color:p.color,capacityGb:p.capacityGb,part:p.part,identity:{requestedPart:p.part,reportedPart:typeof a?.partNumber==='string'?a.partNumber.slice(0,40):null,reportedTitle:typeof reg?.storePickupProductTitle==='string'?reg.storePickupProductTitle.slice(0,160):null,verified:a?.partNumber===p.part&&reg?.storePickupProductTitle===`iPhone Duo 256GB ${p.color}`},status:'UNKNOWN',quote,pickupDate:null,price:price?.price??null,reasonCode:'unverified',reason:'Exact-part pickup could not be verified.',source:sourceUrl(p),order:orderUrl(p),checkedAt:now.toISOString(),appleTimestamp:typeof storeStamp==='number'&&Number.isFinite(new Date(storeStamp).getTime())?new Date(storeStamp).toISOString():null,evidenceTimestamp:validStamp?new Date(stamp).toISOString():null,evidenceSource:observation?'http-response':'legacy-store-timestamp',expiresAt:validStamp?new Date(Math.min(stamp+maxAgeMs,now.getTime()+maxAgeMs)).toISOString():null,selectable:typeof reg?.storeSelectionEnabled==='boolean'?reg.storeSelectionEnabled:null};
 if (!s || s.storeNumber!==store.id || a?.partNumber!==p.part || reg?.storePickupProductTitle!==`iPhone Duo 256GB ${p.color}`) return result;
 if(!validStamp||now.getTime()-stamp>maxAgeMs||stamp-now.getTime()>60000) return {...result,reasonCode:'stale_data',reason:'Apple returned missing or stale timing; availability is unknown.'};
 if(reg.storeSelectionEnabled===false && /currently unavailable|not available|unavailable for pickup/i.test(quote)) return {...result,status:'NOT AVAILABLE',reason:'Apple reports unavailable and pickup selection is disabled.'};
 if(reg.storeSelectionEnabled===false) return {...result,status:'NOT AVAILABLE',reason:'Pickup selection is disabled; no orderable date is offered.'};
 const match=quote.match(/^Available\s+(Today|Tomorrow)\b/i);
 if(reg.storeSelectionEnabled!==true || !match || a.storePickEligible!==true) return {...result,reason:'No verified, selectable pickup today or tomorrow.'};
 const pickupDate=dates(new Date(stamp))[match[1].toLowerCase()==='today'?0:1];
 if(!dates(now).includes(pickupDate))return {...result,reason:'Pickup falls outside today or tomorrow in New York.'};
 const priceTime=Date.parse(price?.checkedAt),priceAge=now.getTime()-priceTime;
 if(!price?.verified || !Number.isFinite(price.price) || price.price<=0 || !Number.isFinite(priceAge) || priceAge<0 || priceAge>PRICE_MAX_AGE_MS) return {...result,pickupDate,reason:'Pickup appears selectable, but the unlocked price and configuration still need fresh verification.'};
 if(price.price>1999) return {...result,pickupDate,status:'NOT AVAILABLE',reason:'Device price exceeds $1,999 before tax.'};
 return {...result,status:'AVAILABLE',pickupDate,expiresAt:new Date(Math.min(Date.parse(result.expiresAt),priceTime+PRICE_MAX_AGE_MS)).toISOString(),reason:'Unlocked outright; connect to any carrier later. No carrier activation, plan or financing required. Sales tax extra. Select the pickup time on Apple; no time slot is exposed here.'};
}
// The dashboard and sender must expire the evidence itself, not just the last request time.
export function currentOptions(options,nowMs=Date.now()){
 return (options||[]).map(o=>{
  if(o.status==='UNKNOWN')return o;
 const expiry=Date.parse(o.expiresAt),stamp=Date.parse(o.evidenceTimestamp||o.appleTimestamp),checked=Date.parse(o.checkedAt);
  if(!Number.isFinite(expiry)||!Number.isFinite(stamp)||!Number.isFinite(checked)||expiry<nowMs||stamp>nowMs+60000||checked>nowMs+60000||o.pickupDate&&!dates(new Date(nowMs)).includes(o.pickupDate))return {...o,status:'UNKNOWN',reasonCode:'stale_data',reason:'The evidence has expired. Waiting for a fresh verified check.'};
  return o;
 });
}
export function parsePrice(html       ,p                        ,now=new Date())       {
 for(const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
  try {
   const visit=(node    )            =>{
    if(!node||typeof node!=='object')return null;
    if(node.sku===p.part+'+unlocked' && node.priceCurrency==='USD' && Number.isFinite(Number(node.price)) && Number(node.price)>0)return Number(node.price);
    for(const value of Object.values(node)){if(typeof value==='object'){const r=visit(value);if(r!==null)return r;}}return null;
   };
   const price=visit(JSON.parse(m[1]));
   if(price!==null && html.includes('Connect to any carrier later')) return {price,verified:true,checkedAt:now.toISOString(),reason:'Exact unlocked SKU and USD device price verified on Apple product page.'};
  }catch{}
 }
 return {price:null,verified:false,checkedAt:now.toISOString(),reason:'Unable to verify exact unlocked price on Apple.'};
}
