import { assert, AppError, money } from './domain.mjs';
export class PayPal {
  constructor(env = process.env, fetcher = fetch) { this.env = env; this.fetcher = fetcher; }
  async request(path, options) {
    let response;
    try { response = await this.fetcher(`https://api-m.sandbox.paypal.com${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(45000) }); }
    catch { throw new AppError('PayPal did not respond. Check the saved order before trying again.', 502); }
    assert(response.ok, `PayPal returned HTTP ${response.status}. Check sandbox setup or the order in the Developer Dashboard.`, 502);
    try { return await response.json(); } catch { throw new AppError('PayPal returned an unreadable response.',502); }
  }
  async token() {
    assert(this.env.PAYPAL_CLIENT_ID && this.env.PAYPAL_CLIENT_SECRET, 'Add PayPal sandbox credentials to .env and restart RestockPilot.',503);
    const response = await this.request('/v1/oauth2/token', { method:'POST', headers:{ Authorization:`Basic ${Buffer.from(`${this.env.PAYPAL_CLIENT_ID}:${this.env.PAYPAL_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type':'application/x-www-form-urlencoded' }, body:'grant_type=client_credentials' });
    assert(typeof response.access_token==='string' && response.access_token, 'PayPal did not provide an access token.',502);
    return response.access_token;
  }
  async call(path, method='GET', body, requestId, token) {
    return this.request(`/v2/checkout/orders${path}`, { method, headers:{ Authorization:`Bearer ${token || await this.token()}`, 'Content-Type':'application/json', Prefer:'return=representation', ...(requestId ? {'PayPal-Request-Id':requestId} : {}) }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
  }
  async create(order, origin, token) {
    const value = money(order.total);
    const response = await this.call('', 'POST', { intent:'CAPTURE', purchase_units:[{
      reference_id:'restock', custom_id:order.id, description:'RestockPilot synthetic cafe restock — sandbox test only',
      amount:{ currency_code:'USD', value, breakdown:{item_total:{currency_code:'USD',value}} },
      items:order.items.map(row=>({ name:row.name, sku:row.sku, description:row.unit, quantity:String(row.quantity), unit_amount:{currency_code:'USD',value:money(row.price)}, category:'PHYSICAL_GOODS' }))
    }], payment_source:{paypal:{experience_context:{brand_name:'RestockPilot',shipping_preference:'NO_SHIPPING',user_action:'PAY_NOW',return_url:`${origin}/?checkout=returned`,cancel_url:`${origin}/?checkout=cancelled`}}} }, `create-${order.id}`, token);
    assert(typeof response.id==='string' && /^[A-Z0-9]{10,32}$/.test(response.id), 'PayPal did not return a valid order ID. Reconcile before retrying.',502);
    const raw = response.links?.find(link=>['payer-action','approve'].includes(link.rel))?.href;
    let url;
    try { url = new URL(raw); } catch {}
    assert(url?.origin==='https://www.sandbox.paypal.com' && !url.username && !url.password, 'PayPal did not return a safe sandbox checkout link.',502);
    return { paypalId:response.id, checkoutUrl:url.href };
  }
  async details(id) { assert(/^[A-Z0-9]{10,32}$/.test(id),'Invalid order ID.'); return this.call(`/${id}`); }
  async capture(order) { return this.call(`/${order.paypalId}/capture`,'POST',{},`capture-${order.id}`); }
}
