const $=selector=>document.querySelector(selector);
const $$=selector=>[...document.querySelectorAll(selector)];
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
let state, plan, models=[], busy=false;
async function api(path,body) {
  const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const value=await response.json(); if(!response.ok) throw new Error(value.error||'Request failed.'); return value;
}
function notice(message,error=false) { const el=$('#notice');el.textContent=message;el.classList.toggle('error',error);el.hidden=!message; }
async function run(button,fn) {
  if(busy)return;busy=true;if(button)button.disabled=true;notice('');
  try { await fn(); } catch(e) { notice(e.message,true); await load().catch(()=>{}); $('#notice').scrollIntoView({behavior:'smooth',block:'start'}); }
  finally {busy=false;if(button)button.disabled=false;}
}
function view(name) { $$('.view').forEach(e=>e.hidden=e.id!==name);$$('.nav').forEach(e=>e.classList.toggle('active',e.dataset.view===name));$('#page-label').textContent=({overview:'Overview',inventory:'Inventory',orders:'Purchase orders',connections:'Connections'})[name]; }
$$('.nav').forEach(button=>button.addEventListener('click',()=>view(button.dataset.view)));
$('#edit-inventory').onclick=()=>view('inventory');
function signals() {
  return state.inventory.map(row=>{const recent=row.sales.slice(7).reduce((a,b)=>a+b,0)/7,prior=row.sales.slice(0,7).reduce((a,b)=>a+b,0)/7;const daily=(recent*.7+prior*.3)*(1+Number($('#uplift').value)/100),cover=daily?row.stock/daily:null;return {...row,daily,cover,risk:cover===null?'healthy':cover<=row.lead?'critical':cover<row.lead+2?'watch':'healthy'};});
}
const tile=row=>`<span class="product-tile ${esc(row.color||'')}">${esc(row.name[0])}</span>`;
function renderOverview() {
  const rows=signals(),risk=rows.filter(r=>r.risk==='critical').length, watch=rows.filter(r=>r.risk==='watch').length;
  const onShelf=rows.reduce((sum,r)=>sum+r.stock*r.price,0), units=rows.reduce((sum,r)=>sum+r.sales.slice(7).reduce((a,b)=>a+b,0),0);
  $('#metrics').innerHTML=[['Products tracked',String(rows.length),'Across your sample café','▦'],['Need attention',String(risk+watch),`${risk} may run out before delivery`,'◷'],['Stock value',usd(onShelf),'At catalog purchase prices','◇'],['Units sold',String(units),'Last 7 days · sample data','↗']].map(([label,value,sub,icon],i)=>`<div class="metric"><span class="metric-icon">${icon}</span><p>${label}</p><strong>${value}</strong><small class="${i===1?'warning':''}">${sub}</small></div>`).join('');
  $('#stock-chart').innerHTML=rows.map(row=>{const width=Math.min(100,(row.cover??30)/30*100),tick=Math.min(100,row.lead/30*100);return `<div class="stock-row"><div class="stock-label">${esc(row.name)}<small>${row.cover===null?'No recent demand':`${row.cover.toFixed(1)} days of stock`}</small></div><svg class="stock-bar" viewBox="0 0 100 16" preserveAspectRatio="none" role="img" aria-label="${esc(row.name)}: ${row.cover===null?'no recent demand':row.cover.toFixed(1)+' days stock'}, ${row.lead} day lead"><rect x="0" y="4" width="100" height="8" rx="2" fill="#f3f0f7"/><rect x="0" y="4" width="${width}" height="8" rx="2" fill="${row.risk==='critical'?'#cfa498':row.risk==='watch'?'#d9c39d':'#b9a7cd'}"/><line x1="${tick}" x2="${tick}" y1="0" y2="16" stroke="#66516f" stroke-width=".65"/></svg><div class="stock-status ${row.risk}">${row.risk==='critical'?'Restock soon':row.risk==='watch'?'Keep an eye':'Looking good'}</div></div>`;}).join('');
}
$('#uplift').onchange=()=>renderOverview();
function renderInventory() {
  $('#inventory-rows').innerHTML=state.inventory.map(row=>`<tr data-sku="${esc(row.sku)}"><td><div class="product">${tile(row)}<div><strong>${esc(row.name)}</strong><small>${esc(row.unit)} · ${usd(row.price)}</small></div></div></td><td><input class="qty stock" aria-label="${esc(row.name)} stock" type="number" min="0" max="100000" step="1" value="${row.stock}" required></td><td><input class="qty lead" aria-label="${esc(row.name)} lead days" type="number" min="1" max="30" step="1" value="${row.lead}" required></td><td><input class="daily-sales" aria-label="${esc(row.name)} daily sales" value="${row.sales.join(', ')}" required></td></tr>`).join('');
}
$('#inventory-form').onsubmit=event=>{event.preventDefault();run(event.submitter,async()=>{const rows=$$('#inventory-rows tr').map(tr=>({sku:tr.dataset.sku,stock:Number(tr.querySelector('.stock').value),lead:Number(tr.querySelector('.lead').value),sales:tr.querySelector('.daily-sales').value.split(',').map(s=>s.trim()===''?NaN:Number(s.trim()))}));await api('/api/inventory',{rows});plan=null;await load();notice('Inventory saved. Generate a fresh restock plan using these numbers.');view('overview');});};
function modelOptions() {return models.map(m=>`<option value="${esc(m.slug)}">${esc(m.name)}</option>`).join('');}
function renderConnections() {
  const previousModel=$('#model')?.value||plan?.model, previousSource=$('#source')?.value||'chatgpt';
  const connected=state.chatgpt.sharing;
  $('#chatgpt-connection').innerHTML=connected?`<span class="status paid">Connected · ChatGPT plan usage</span><button class="button secondary" id="disconnect">Disconnect ChatGPT</button>`:`<select id="profile" aria-label="ChatGPT account"><option value="">Add a ChatGPT account</option>${state.chatgpt.profiles.map(p=>`<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}</select><button class="button primary" id="connect">Continue with ChatGPT</button>`;
  $('#connect')?.addEventListener('click',event=>run(event.currentTarget,async()=>{const result=await api('/api/auth/start',{profileId:$('#profile').value||null});location.assign(result.url);}));
  $('#disconnect')?.addEventListener('click',event=>run(event.currentTarget,async()=>{await api('/api/auth/logout',{});models=[];await load();notice('ChatGPT disconnected. Stored purchase plans remain available.');}));
  $('#paypal-connection').innerHTML=`<span class="status ${state.paypalReady?'paid':''}">${state.paypalReady?'Sandbox credentials configured':'Setup needed · see .env.example'}</span>`;
  $('#ai-selector').innerHTML=connected?`<label for="source">Planning mode</label><select id="source"><option value="chatgpt">AI priorities · ChatGPT</option><option value="preview">Calculated preview · no AI</option></select><label for="model">Your available models</label><select id="model" ${models.length?'':'disabled'}>${modelOptions()||'<option>No models loaded</option>'}</select>`:`<div class="mode-note">Calculated preview · no AI connection yet.<br><button type="button" id="connect-shortcut">Connect ChatGPT for AI priorities ↗</button></div>`;
  $('#connect-shortcut')?.addEventListener('click',()=>view('connections'));
  if(connected) { $('#source').value=previousSource; if(models.some(m=>m.slug===previousModel)) $('#model').value=previousModel; }
}
$('#plan-form').onsubmit=event=>{event.preventDefault();run(event.submitter,async()=>{notice('Building your plan…');plan=await api('/api/plans',{budget:Math.round(Number($('#budget').value)*100),horizon:Number($('#horizon').value),uplift:Number($('#uplift').value),note:$('#context').value,source:$('#source')?.value||'preview',model:$('#model')?.value});await load(false);renderPlan();notice('Your plan is ready. Review quantities and the total before checkout.');$('#plan-area').scrollIntoView({behavior:'smooth',block:'start'});});};
function cartItems() {return $$('.cart-qty').map(input=>({sku:input.dataset.sku,quantity:Number(input.value)})).filter(r=>r.quantity>0);}
function updateTotal() {
  const items=cartItems(),total=items.reduce((sum,row)=>sum+row.quantity*plan.rows.find(p=>p.sku===row.sku).price,0);
  const valid=$$('.cart-qty').every(el=>el.checkValidity())&&total>0&&total<=plan.settings.budget;
  $('#cart-total').textContent=usd(total);$('#cart-total').classList.toggle('out-of-budget',!valid);
  $('#budget-left').textContent=total<=plan.settings.budget?`${usd(plan.settings.budget-total)} remains in your budget`:`${usd(total-plan.settings.budget)} over budget`;
  $('#checkout').disabled=!valid||!$('#approval').checked||!state.paypalReady||plan.revision!==state.revision;
}
function renderPlan() {
  const area=$('#plan-area');area.hidden=!plan;if(!plan)return;
  const existing=state.orders.find(o=>o.planId===plan.id),stale=plan.revision!==state.revision;
  area.innerHTML=`<div class="plan-top"><div><p class="eyebrow">A PLAN YOU CAN PUT TO WORK</p><h2>Your restock shortlist</h2><p>${plan.settings.horizon} days of coverage + delivery time + 2 safety days · ${usd(plan.settings.budget)} budget</p></div><span class="source-chip">${plan.source==='chatgpt'?'✦ AI priorities · '+esc(plan.model):'Calculated preview · not AI'}</span></div><div class="advice-box"><p>${esc(plan.advice.summary)}</p><small>${esc(plan.advice.caution)}</small></div><div class="panel table-wrap"><table><thead><tr><th>Product</th><th>Why it’s here</th><th>Top-up target</th><th>Buy quantity</th><th>Unit cost</th></tr></thead><tbody>${plan.rows.map(row=>`<tr><td><div class="product">${tile(row)}<div><strong>${esc(row.name)}</strong><small>${esc(row.unit)}</small></div></div></td><td class="reason">${esc(row.reason)}</td><td>${row.needed}</td><td><input type="number" class="qty cart-qty" data-sku="${esc(row.sku)}" aria-label="Buy quantity for ${esc(row.name)}" value="${row.quantity}" min="0" max="${row.needed}" step="1" required ${existing?'disabled':''}></td><td>${usd(row.price)}</td></tr>`).join('')}</tbody></table><div class="checkout-row">${existing?`<div><p class="order-help">This plan already has a saved purchase order.</p><button class="button secondary" id="view-order">View purchase order ↗</button></div>`:`<div><label class="approval"><input id="approval" type="checkbox"><span>I reviewed these quantities and approve this exact <strong>sandbox</strong> total. No real goods or money are involved.</span></label><p class="fineprint">${stale?'Inventory changed. Generate a fresh plan before checkout.':!state.paypalReady?'Add sandbox credentials in .env before checkout.':'Example supplier: Little Day Wholesale · synthetic catalog'}</p></div><div class="cart-summary"><p>Reviewed total · USD</p><strong id="cart-total"></strong><p id="budget-left"></p><button class="button primary full" id="checkout" disabled>Create PayPal checkout ↗</button><p class="fineprint">You’ll approve the test order on PayPal.</p></div>`}</div></div>`;
  if(existing) {$('#view-order').onclick=()=>view('orders');return;}
  $$('.cart-qty').forEach(input=>input.oninput=()=>{$('#approval').checked=false;updateTotal();});$('#approval').onchange=updateTotal;updateTotal();
  $('#checkout').onclick=event=>run(event.currentTarget,async()=>{await api('/api/orders',{planId:plan.id,items:cartItems(),approved:$('#approval').checked});await load(false);renderPlan();view('orders');notice('Sandbox order saved. Open PayPal checkout to approve, then return here to capture.');});
}
function renderOrders() {
  $('#order-count').textContent=state.orders.length;
  $('#orders-list').innerHTML=state.orders.length?[...state.orders].reverse().map(order=>`<section class="panel order-card"><div class="order-top"><div><h2>Restock order · ${esc(order.id.slice(0,8))}</h2><p>${esc(new Date(order.createdAt).toLocaleString())} · ${order.source==='chatgpt'?'AI-prioritized':'Calculated preview'} · sandbox</p></div><div><strong>${usd(order.total)}</strong><p><span class="status ${order.state==='paid'?'paid':''}">${esc(order.state.replaceAll('-',' '))}</span></p></div></div><div class="order-items">${order.items.map(row=>`<span>${row.quantity} × ${esc(row.name)}</span>`).join('')}</div><p class="order-help">${order.state==='paid'?'Payment confirmed by PayPal. This sandbox purchase does not ship goods or change on-hand inventory.':order.state==='needs-reconciliation'?'The payment outcome needs checking. Refresh this saved order or reconcile it in the sandbox dashboard before making another purchase.':'1. Approve in PayPal. 2. Return here and refresh. 3. Capture the approved test payment.'}</p><div class="order-actions">${order.checkoutUrl&&order.state==='awaiting-approval'?`<a class="button primary" href="${esc(order.checkoutUrl)}" target="_blank" rel="noreferrer">Open PayPal checkout ↗</a>`:''}${order.paypalId?`<button class="button secondary" data-action="refresh" data-id="${esc(order.id)}">Refresh from PayPal</button>`:''}${order.state==='approved'&&!order.captureAttemptedAt?`<button class="button primary" data-action="capture" data-id="${esc(order.id)}">Capture ${usd(order.total)} sandbox payment</button>`:''}</div>${order.paypalId?`<p class="fineprint">PayPal order: ${esc(order.paypalId)}${order.captureId?' · Capture: '+esc(order.captureId):''}</p>`:''}<details><summary>View order activity</summary><ol>${order.history.map(e=>`<li>${esc(new Date(e.at).toLocaleTimeString())} — ${esc(e.message)}</li>`).join('')}</ol></details></section>`).join(''):`<div class="empty"><h2>A clear shelf. A fresh start.</h2><p>Your reviewed purchases will appear here.<br>Build a plan in Overview to create your first sandbox checkout.</p></div>`;
  $$('[data-action]').forEach(button=>button.onclick=()=>run(button,async()=>{const result=await api(`/api/orders/${button.dataset.id}/${button.dataset.action}`,{approved:button.dataset.action==='capture'});await load(false);notice(result.state==='paid'?'PayPal confirmed the sandbox payment.':`Order checked: ${result.state.replaceAll('-',' ')}.`);}));
}
async function load(restorePlan=true) {
  state=await api('/api/state');
  if(state.chatgpt.sharing&&!models.length){try {models=await api('/api/models');}catch(e){notice(e.message,true);}}
  if(restorePlan) plan=state.plans.filter(p=>p.revision===state.revision).at(-1)||null;
  renderOverview();renderInventory();renderConnections();renderOrders();renderPlan();
}
load().then(()=>{const params=new URLSearchParams(location.search);if(params.has('checkout')){view('orders');notice(params.get('checkout')==='cancelled'?'Checkout was cancelled. No payment has been confirmed.':'Welcome back. Refresh the saved order to verify PayPal approval, then capture the test payment.');}if(params.has('connected')){notice('ChatGPT connected. Your next plan can use AI priorities.');}history.replaceState({},'',location.pathname);}).catch(e=>notice(e.message,true));
