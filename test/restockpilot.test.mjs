import test from 'node:test';
import strict from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalog, inventoryInput, settingsInput, forecast, allocate, sampleAdvice, validateAdvice, reviewedCart, verifiedPayment, money } from '../lib/domain.mjs';
import { createApp } from '../server.mjs';
import { PayPal } from '../lib/providers.mjs';
import { advise, analysisPayload } from '../lib/stream.mjs';
const settings={budget:20000,horizon:7,uplift:0,note:''};
const signals=forecast(catalog,settings);
const plan={settings,rows:allocate(signals,sampleAdvice(signals),settings.budget)};
test('AI receives explicit dollar amounts rather than ambiguous internal cents',()=>{
  const input=JSON.parse(analysisPayload(signals,settings,'test').input[0].content);
  strict.equal(input.budgetUSD,'200.00');strict.equal(input.products[0].unitPriceUSD,'2.50');
  strict.equal(input.products[0].price,undefined);strict.equal(input.preferences.budget,undefined);
  strict.equal(input.fullTargetCostUSD,money(signals.reduce((sum,row)=>sum+row.price*row.needed,0)));
});
test('Forecast responds to demand, handles zero sales and separates lead-time stockouts',()=>{
  strict.equal(signals[0].risk,'critical');strict.equal(signals[5].risk,'healthy');
  strict.ok(forecast(catalog,{...settings,uplift:50})[0].needed>signals[0].needed);
  const zero=forecast([{...catalog[0],sales:Array(14).fill(0)}],settings)[0];strict.equal(zero.cover,null);strict.equal(zero.needed,0);
});
test('Allocation stays inside budget and target for many budgets and demand levels',()=>{
  for(const uplift of [-50,0,25,100])for(let budget=100;budget<=100000;budget+=137){
    const s=forecast(catalog,{...settings,uplift}),rows=allocate(s,sampleAdvice(s),budget);
    strict.ok(rows.reduce((sum,r)=>sum+r.price*r.quantity,0)<=budget);
    strict.ok(rows.every(r=>Number.isInteger(r.quantity)&&r.quantity>=0&&r.quantity<=r.needed));
  }
});
test('Inventory rejects missing products, duplicates and malformed sales; prices stay trusted',()=>{
  strict.throws(()=>inventoryInput(catalog.slice(1)));
  strict.throws(()=>inventoryInput(catalog.map(()=>catalog[0])));
  strict.throws(()=>inventoryInput(catalog.map(r=>({...r,sales:[1]}))));
  const parsed=inventoryInput(catalog.map(r=>({...r,price:1,stock:10})));strict.equal(parsed[0].price,250);
  strict.throws(()=>settingsInput({...settings,budget:0}));strict.throws(()=>settingsInput({...settings,uplift:101}));
});
test('AI cannot invent or duplicate products; all priorities must be explained',()=>{
  const advice=sampleAdvice(signals);strict.equal(validateAdvice(advice),advice);
  strict.throws(()=>validateAdvice({...advice,priorities:advice.priorities.slice(1)}));
  strict.throws(()=>validateAdvice({...advice,priorities:advice.priorities.map(()=>advice.priorities[0])}));
  strict.throws(()=>validateAdvice({...advice,priorities:advice.priorities.map(r=>({...r,sku:'INVENTED'}))}));
});
test('Reviewed cart ignores client prices and rejects overspend, fractions, duplicates and excessive quantities',()=>{
  strict.equal(reviewedCart([{sku:'OAT-01',quantity:1,price:1}],plan).total,250);
  for(const items of [[],[{sku:'unknown',quantity:1}],[{sku:'OAT-01',quantity:.5}],[{sku:'OAT-01',quantity:5000}],[{sku:'OAT-01',quantity:1},{sku:'OAT-01',quantity:1}]]) strict.throws(()=>reviewedCart(items,plan));
  strict.throws(()=>reviewedCart([{sku:'OAT-01',quantity:2}],{...plan,settings:{...settings,budget:250}}));
});
function responseFor(order,status='COMPLETED',captureStatus='COMPLETED') {return {id:order.paypalId,status,purchase_units:[{custom_id:order.id,amount:{currency_code:'USD',value:money(order.total)},payments:status==='COMPLETED'?{captures:[{id:'CAPTURE123456',status:captureStatus,amount:{currency_code:'USD',value:money(order.total)}}]}:undefined}]};}
test('Payment needs matching order, custom reference, currency, total and completed capture',()=>{
  const order={id:'local',paypalId:'PP1234567890',total:250};
  strict.equal(verifiedPayment(responseFor(order),order).state,'paid');
  strict.equal(verifiedPayment(responseFor(order,'APPROVED'),order).state,'approved');
  strict.equal(verifiedPayment(responseFor(order,'COMPLETED','PENDING'),order).state,'pending');
  const wrong=responseFor(order);wrong.purchase_units[0].payments.captures[0].amount.value='0.01';strict.notEqual(verifiedPayment(wrong,order).state,'paid');
  for(const field of ['id','total','paypalId']) strict.throws(()=>verifiedPayment(responseFor({...order,[field]:'different'}),order));
});
async function fixture(t,{failCreate=false,failCapture=false}={}) {
  const dir=await mkdtemp(join(tmpdir(),'restockpilot-test-'));let creates=0,captures=0,order;
  const paypal={token:async()=>'token',create:async(o)=>{creates++;order={...o,paypalId:'PP1234567890'};if(failCreate)throw new Error('timeout');return{paypalId:order.paypalId,checkoutUrl:'https://www.sandbox.paypal.com/checkoutnow?token=PP1234567890'};},details:async()=>responseFor(order,captures?'COMPLETED':'APPROVED'),capture:async()=>{captures++;if(failCapture)throw new Error('timeout');return{};}};
  const chatgpt={state:()=>({sharing:false,profiles:[]}),models:async()=>[{slug:'test'}],accessToken:async()=>'private'};
  const app=await createApp({dataDir:dir,paypal,chatgpt,env:{},adviceFn:async(s)=>sampleAdvice(s)});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${app.address().port}`;
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));await rm(dir,{recursive:true,force:true});});
  const call=async(path,value,headers={})=>{const res=await fetch(origin+path,{...(value===undefined?{}:{method:'POST',body:JSON.stringify(value),headers:{'Content-Type':'application/json',...headers}})});return{status:res.status,data:await res.json()};};
  return{call,origin,counts:()=>({creates,captures}),plan:async()=> (await call('/api/plans',{...settings,source:'preview'})).data};
}
test('Server seals approved carts and duplicate/concurrent submissions create just one order',async t=>{
  const f=await fixture(t),p=await f.plan();
  strict.equal((await f.call('/api/orders',{planId:p.id,items:[{sku:'OAT-01',quantity:1}]})).status,400);
  const payload={planId:p.id,items:[{sku:'OAT-01',quantity:1,price:1}],approved:true};
  const results=await Promise.all([f.call('/api/orders',payload),f.call('/api/orders',payload)]);
  strict.equal(results[0].data.total,250);strict.equal(results[0].data.id,results[1].data.id);strict.equal(f.counts().creates,1);
});
test('Stale inventory prevents checkout while existing orders remain recoverable',async t=>{
  const f=await fixture(t),p=await f.plan();await f.call('/api/inventory',{rows:catalog});
  strict.equal((await f.call('/api/orders',{planId:p.id,items:[{sku:'OAT-01',quantity:1}],approved:true})).status,409);
  strict.equal(f.counts().creates,0);
});
test('Unknown create outcome is persisted and replay cannot duplicate it',async t=>{
  const f=await fixture(t,{failCreate:true}),p=await f.plan(),payload={planId:p.id,items:[{sku:'OAT-01',quantity:1}],approved:true};
  strict.equal((await f.call('/api/orders',payload)).status,500);
  strict.equal((await f.call('/api/orders',payload)).data.state,'needs-reconciliation');strict.equal(f.counts().creates,1);
});
test('Capture is verified and repeated requests never charge twice',async t=>{
  const f=await fixture(t),p=await f.plan();const order=(await f.call('/api/orders',{planId:p.id,items:[{sku:'OAT-01',quantity:1}],approved:true})).data;
  const path=`/api/orders/${order.id}/capture`;
  strict.equal((await f.call(path,{approved:false})).status,400);
  strict.equal((await f.call(path,{approved:true})).data.state,'paid');
  strict.equal((await f.call(path,{approved:true})).data.state,'paid');strict.equal(f.counts().captures,1);
});
test('Timed-out capture reconciles via authenticated GET without another capture',async t=>{
  const f=await fixture(t,{failCapture:true}),p=await f.plan();const order=(await f.call('/api/orders',{planId:p.id,items:[{sku:'OAT-01',quantity:1}],approved:true})).data;
  strict.equal((await f.call(`/api/orders/${order.id}/capture`,{approved:true})).status,500);
  strict.equal((await f.call(`/api/orders/${order.id}/refresh`,{})).data.state,'paid');strict.equal(f.counts().captures,1);
});
test('HTTP blocks cross-origin writes, hidden files and client-supplied payment status',async t=>{
  const f=await fixture(t);
  strict.equal((await f.call('/api/plans',{...settings,source:'preview'},{Origin:'https://evil.example'})).status,403);
  strict.equal((await f.call('/.env')).status,404);strict.equal((await f.call('/data/store.json')).status,404);
  strict.equal((await f.call('/api/orders/fake/refresh',{paid:true})).status,404);
});
test('PayPal uses sandbox, server prices and stable create/capture idempotency keys',async()=>{
  const calls=[];const paypal=new PayPal({PAYPAL_CLIENT_ID:'test',PAYPAL_CLIENT_SECRET:'secret'},async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/token')?{access_token:'test'}:{id:'PP1234567890',links:[{rel:'payer-action',href:'https://www.sandbox.paypal.com/checkoutnow?token=PP1234567890'}]});});
  const order={id:'abc',total:250,items:[{name:'Oat',sku:'OAT-01',unit:'1 L',price:250,quantity:1}],paypalId:'PP1234567890'};
  await paypal.create(order,'http://127.0.0.1:4318');await paypal.capture(order);
  strict.ok(calls.every(c=>c.url.startsWith('https://api-m.sandbox.paypal.com/')));
  const writes=calls.filter(c=>c.url.includes('/v2/'));strict.equal(writes[0].options.headers['PayPal-Request-Id'],'create-abc');strict.equal(writes[1].options.headers['PayPal-Request-Id'],'capture-abc');
  strict.equal(JSON.parse(writes[0].options.body).purchase_units[0].amount.value,'2.50');
});
test('PayPal rejects approval URLs outside the sandbox',async()=>{
  const paypal=new PayPal({},async()=>Response.json({id:'PP1234567890',links:[{rel:'approve',href:'https://evil.example/pay'}]}));
  await strict.rejects(paypal.create({id:'x',total:100,items:[]},'http://127.0.0.1:4318','token'),/safe sandbox/);
});
test('ChatGPT SSE accepts text events only after completion and rejects truncated streams',async()=>{
  const output=JSON.stringify(sampleAdvice(signals));
  const events=[{type:'response.output_text.delta',delta:output},{type:'response.completed',response:{status:'completed',output:[]}}];
  const fetcher=async()=>new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''));
  strict.equal((await advise(signals,settings,'test','private',fetcher)).priorities.length,6);
  await strict.rejects(advise(signals,settings,'test','private',async()=>new Response(`data: ${JSON.stringify(events[0])}\n\n`)),/stopped/);
  await strict.rejects(advise(signals,settings,'test','private',async()=>new Response('',{status:429})),/usage limit/);
});
