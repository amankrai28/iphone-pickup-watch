// Local Miniflare fixture ONLY. Not imported/exported by the production Worker.
import {DurableObject} from 'cloudflare:workers';
import {CheckoutCoordinator} from '../src/checkout-coordinator.mjs';
export class Fixture extends DurableObject{
 async fetch(request){
  const body=request.method==='POST'?await request.json():{},now=Date.parse('2026-10-29T13:30:03Z');
  const coordinator=new CheckoutCoordinator(this.ctx.storage,{now:()=>now,adapter:{mode:'rehearsal-only',canSubmit:false,runReview:async command=>({kind:'STOPPED',noSubmissionConfirmed:true})}});
  const path=new URL(request.url).pathname;
  if(path==='/reserve')return Response.json(await coordinator.reserve(body.eventId,body.option));
  if(path==='/dispatch')return Response.json(await coordinator.dispatch(body.attemptId));
  if(path==='/finish')return Response.json({finished:await coordinator.finishNoPurchase(body.attemptId)});
  return Response.json(await coordinator.status());
 }
}
export default{fetch(request,env){return env.FIXTURE.getByName('one-global-attempt').fetch(request);}};
