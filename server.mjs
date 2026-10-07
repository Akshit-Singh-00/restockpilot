import http from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AppError, assert, catalog, inventoryInput, settingsInput, forecast, sampleAdvice, validateAdvice, allocate, reviewedCart, verifiedPayment } from './lib/domain.mjs';
import { ChatGPTConnection } from './lib/chatgpt.mjs';
import { PayPal } from './lib/providers.mjs';
import { advise } from './lib/stream.mjs';
const root = dirname(fileURLToPath(import.meta.url));
async function body(req) {
  assert(req.headers['content-type']?.startsWith('application/json'),'Send JSON.',415);
  let raw=''; for await (const chunk of req) { raw+=chunk; assert(Buffer.byteLength(raw)<=64000,'Request is too large.',413); }
  try { return JSON.parse(raw); } catch { throw new AppError('Invalid JSON.'); }
}
export async function createApp({env=process.env,dataDir=resolve(root,'data'),paypal=new PayPal(env),chatgpt,adviceFn=advise}={}) {
  await mkdir(dataDir,{recursive:true});
  chatgpt ||= await new ChatGPTConnection(dataDir).init();
  const file=resolve(dataDir,'store.json');
  let db;
  try { db=JSON.parse(await readFile(file,'utf8')); } catch(e) { if(e.code!=='ENOENT') throw e; db={inventory:structuredClone(catalog),revision:1,plans:[],orders:[]}; }
  let queue=Promise.resolve();
  function serial(fn) { const task=queue.then(fn); queue=task.catch(()=>{}); return task; }
  async function save() { await writeFile(`${file}.tmp`,JSON.stringify(db,null,2),{mode:0o600}); await rename(`${file}.tmp`,file); }
  const event=(order,message)=>order.history.push({at:new Date().toISOString(),message});
  async function api(req,res,path,origin) {
    if(req.method==='GET') {
      if(path==='/api/state') return {inventory:db.inventory,revision:db.revision,plans:db.plans,orders:db.orders,chatgpt:chatgpt.state(),paypalReady:Boolean(env.PAYPAL_CLIENT_ID&&env.PAYPAL_CLIENT_SECRET)};
      if(path==='/api/models') return chatgpt.models();
      throw new AppError('Not found.',404);
    }
    assert(req.method==='POST','Method not allowed.',405);
    const input=await body(req);
    if(path==='/api/auth/start') {
      const result=await serial(()=>chatgpt.begin(res.socket.localPort,input.profileId));
      res.setHeader('Set-Cookie',`restock_oauth=${result.cookie}; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=600`);
      return {url:result.url};
    }
    if(path==='/api/auth/logout') return serial(()=>chatgpt.signOut());
    if(path==='/api/plans') {
      const settings=settingsInput(input);
      assert(['preview','chatgpt'].includes(input.source),'Select preview or ChatGPT.');
      const revision=db.revision, signals=forecast(structuredClone(db.inventory),settings);
      let advice;
      if(input.source==='chatgpt') {
        assert((await chatgpt.models()).some(m=>m.slug===input.model),'Select an available ChatGPT model.');
        advice=validateAdvice(await adviceFn(signals,settings,input.model,await chatgpt.accessToken()));
      } else advice=sampleAdvice(signals);
      return serial(async()=>{
        assert(revision===db.revision,'Inventory changed while planning. Generate a fresh plan.',409);
        const plan={id:randomUUID(),createdAt:new Date().toISOString(),revision,source:input.source,model:input.source==='chatgpt'?input.model:null,settings,advice,rows:allocate(signals,advice,settings.budget)};
        db.plans.push(plan); await save(); return plan;
      });
    }
    return serial(async()=>{
      if(path==='/api/inventory') { db.inventory=inventoryInput(input.rows); db.revision++; await save(); return {revision:db.revision}; }
      if(path==='/api/orders') {
        assert(input.approved===true,'Review and approve the cart first.');
        const plan=db.plans.find(p=>p.id===input.planId);
        assert(plan,'Plan not found.',404);
        const existing=db.orders.find(o=>o.planId===plan.id);
        if(existing) return existing;
        assert(plan.revision===db.revision,'Inventory changed. Create a fresh plan before checkout.',409);
        assert(Date.now()-Date.parse(plan.createdAt)<24*60*60*1000,'This plan is older than 24 hours. Generate a fresh plan.',409);
        const cart=reviewedCart(input.items,plan);
        const token=await paypal.token();
        const order={id:randomUUID(),planId:plan.id,source:plan.source,...cart,state:'creating',createdAt:new Date().toISOString(),history:[]};
        event(order,'Owner approved the exact cart and sandbox total.'); db.orders.push(order); await save();
        try { Object.assign(order,await paypal.create(order,origin,token)); order.state='awaiting-approval'; event(order,'PayPal sandbox order created. Buyer approval is required.'); await save(); }
        catch(e) { order.state='needs-reconciliation'; event(order,'Creation outcome uncertain. Check PayPal before creating any replacement.'); await save(); throw e; }
        return order;
      }
      const match=path.match(/^\/api\/orders\/([a-f0-9-]+)\/(refresh|capture)$/);
      assert(match,'Not found.',404);
      const order=db.orders.find(o=>o.id===match[1]); assert(order?.paypalId,'No saved PayPal order exists.',404);
      const current=verifiedPayment(await paypal.details(order.paypalId),order);
      Object.assign(order,current); await save();
      if(match[2]==='capture' && order.state!=='paid') {
        assert(input.approved===true,'Approve capturing this sandbox payment.');
        assert(order.state==='approved','Approve this order in PayPal before capture.',409);
        // Persist before network I/O. Never automatically retry an ambiguous capture.
        assert(!order.captureAttemptedAt,'A capture was already attempted. Refresh or reconcile in PayPal before any further action.',409);
        order.captureAttemptedAt=new Date().toISOString(); order.state='capturing'; event(order,'Capture requested with a stable idempotency key.'); await save();
        try { await paypal.capture(order); Object.assign(order,verifiedPayment(await paypal.details(order.paypalId),order)); }
        catch(e) { order.state='needs-reconciliation'; event(order,'Capture outcome uncertain; refresh from PayPal to reconcile.'); await save(); throw e; }
      }
      event(order,order.state==='paid'?'PayPal confirmed a completed capture for the exact USD total.':`PayPal status checked: ${order.paypalStatus}.`); await save(); return order;
    });
  }
  return http.createServer(async(req,res)=>{
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('Cache-Control','no-store');
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    try {
      const hosts=[`127.0.0.1:${res.socket.localPort}`,`localhost:${res.socket.localPort}`];
      assert(['127.0.0.1','::1'].includes(res.socket.localAddress)&&hosts.includes(req.headers.host),'Local access only.',403);
      const url=new URL(req.url,`http://${req.headers.host}`), path=url.pathname;
      if(path==='/auth/callback'&&req.method==='GET') {
        const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('restock_oauth='))?.slice(14);
        await serial(()=>chatgpt.callback(url.searchParams,cookie));
        res.setHeader('Set-Cookie','restock_oauth=; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=0'); res.writeHead(303,{Location:'/?connected=1'});res.end();return;
      }
      // PayPal returns through a top-level navigation; this page never mutates state on GET.
      if(req.method!=='GET'||path.startsWith('/api/')) {
        assert(!req.headers.origin||hosts.some(h=>req.headers.origin===`http://${h}`),'Cross-origin requests are blocked.',403);
        assert(!req.headers['sec-fetch-site']||['same-origin','none'].includes(req.headers['sec-fetch-site']),'Cross-site requests are blocked.',403);
      }
      if(path.startsWith('/api/')) return send(200,await api(req,res,path,`http://127.0.0.1:${res.socket.localPort}`));
      const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
      assert(req.method==='GET'&&files[path],'Not found.',404);
      const [name,type]=files[path];res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`});res.end(await readFile(resolve(root,'public',name)));
    } catch(e) { send(e.status||500,{error:e instanceof AppError?e.message:'Unexpected local error. Check setup and retry.'}); }
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=await createApp(); const port=Number(process.env.PORT||4318);
  app.listen(port,'127.0.0.1',()=>console.log(`RestockPilot: http://127.0.0.1:${port} — sandbox only`));
}
