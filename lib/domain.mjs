export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function assert(condition, message, status = 400) {
  if (!condition) throw new AppError(message, status);
}
export const money = minor => (minor / 100).toFixed(2);
export const catalog = [
  { sku: 'OAT-01', name: 'Barista oat milk', category: 'DAIRY ALTERNATIVES', unit: '1 L carton', price: 250, stock: 12, lead: 3, sales: [5,6,4,7,6,9,8,6,7,5,8,7,10,9], color: 'oat' },
  { sku: 'BEAN-02', name: 'House blend beans', category: 'COFFEE', unit: '250 g bag', price: 650, stock: 9, lead: 4, sales: [2,3,2,3,4,4,3,3,4,3,4,4,5,3], color: 'bean' },
  { sku: 'MATCH-03', name: 'Ceremonial matcha', category: 'TEA', unit: '30 g tin', price: 850, stock: 7, lead: 5, sales: [1,1,0,2,1,1,2,1,2,1,2,2,2,1], color: 'matcha' },
  { sku: 'CUP-04', name: 'Compostable cups', category: 'PACKAGING', unit: 'Pack of 50', price: 400, stock: 5, lead: 2, sales: [1,1,1,1,2,2,1,1,1,2,1,2,2,1], color: 'cup' },
  { sku: 'SYRUP-05', name: 'Vanilla syrup', category: 'PANTRY', unit: '750 ml bottle', price: 500, stock: 18, lead: 3, sales: [1,0,1,0,1,2,1,1,0,1,1,1,2,1], color: 'syrup' },
  { sku: 'COCOA-06', name: 'Drinking chocolate', category: 'PANTRY', unit: '500 g pouch', price: 600, stock: 20, lead: 4, sales: [1,1,0,1,1,1,1,1,1,1,0,1,1,1], color: 'cocoa' }
];
export function inventoryInput(rows) {
  assert(Array.isArray(rows) && rows.length === catalog.length, 'Provide all six inventory rows.');
  const seen = new Set();
  return rows.map(row => {
    const product = catalog.find(p => p.sku === row.sku);
    assert(product && !seen.has(row.sku), 'Unknown or duplicate inventory SKU.'); seen.add(row.sku);
    assert(Number.isInteger(row.stock) && row.stock >= 0 && row.stock <= 100000, 'Stock must be a whole number from 0 to 100,000.');
    assert(Number.isInteger(row.lead) && row.lead >= 1 && row.lead <= 30, 'Lead time must be 1–30 days.');
    assert(Array.isArray(row.sales) && row.sales.length === 14 && row.sales.every(n => Number.isInteger(n) && n >= 0 && n <= 10000), 'Supply 14 daily sales counts for each SKU.');
    return { ...product, stock: row.stock, lead: row.lead, sales: [...row.sales] };
  });
}
export function settingsInput(input) {
  assert(Number.isInteger(input.budget) && input.budget >= 100 && input.budget <= 100000, 'Budget must be $1–$1,000.');
  assert(Number.isInteger(input.horizon) && input.horizon >= 3 && input.horizon <= 21, 'Coverage must be 3–21 days.');
  assert(Number.isInteger(input.uplift) && input.uplift >= -50 && input.uplift <= 100, 'Demand adjustment must be between -50% and +100%.');
  assert(typeof input.note === 'string' && input.note.length <= 1000, 'Shop context must be at most 1,000 characters.');
  return { budget: input.budget, horizon: input.horizon, uplift: input.uplift, note: input.note.trim() };
}
export function forecast(inventory, settings) {
  return inventory.map(row => {
    const previous = row.sales.slice(0,7).reduce((a,b) => a+b,0) / 7;
    const recent = row.sales.slice(7).reduce((a,b) => a+b,0) / 7;
    const daily = (previous * .3 + recent * .7) * (1 + settings.uplift / 100);
    const cover = daily > 0 ? row.stock / daily : null;
    const target = Math.ceil(daily * (row.lead + settings.horizon + 2));
    const needed = Math.min(500, Math.max(0, target - row.stock));
    return { ...row, daily: Math.round(daily*100)/100, cover: cover === null ? null : Math.round(cover*10)/10,
      needed, risk: cover === null ? 'healthy' : cover <= row.lead ? 'critical' : cover < row.lead + 2 ? 'watch' : 'healthy',
      trend: previous ? Math.round((recent/previous-1)*100) : recent ? 100 : 0 };
  });
}
export const schema = { type: 'object', additionalProperties: false, required: ['summary','priorities','caution'], properties: {
  summary: { type: 'string' }, caution: { type: 'string' },
  priorities: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['sku','reason'], properties: { sku: { type: 'string', enum: catalog.map(r=>r.sku) }, reason: { type: 'string' } } } }
} };
export function validateAdvice(value) {
  assert(value && typeof value.summary === 'string' && value.summary.trim() && value.summary.length <= 2000 && typeof value.caution === 'string' && value.caution.length <= 2000, 'AI returned an invalid explanation.', 502);
  assert(Array.isArray(value.priorities) && value.priorities.length === catalog.length, 'AI must rank every catalog item.', 502);
  const seen = new Set();
  for (const row of value.priorities) {
    assert(catalog.some(p=>p.sku === row.sku) && !seen.has(row.sku) && typeof row.reason === 'string' && row.reason.trim() && row.reason.length <= 1500, 'AI returned an invalid or duplicate product recommendation.', 502); seen.add(row.sku);
  }
  return value;
}
export function sampleAdvice(signals) {
  return { summary: 'Start with products most likely to run out before delivery. Allocate the budget one unit at a time so a single product cannot consume it all.', caution: 'This is a calculated preview, not AI output. Forecasts use 14 days of sample sales; unexpected demand and delivery delays can change the result.',
    priorities: [...signals].sort((a,b)=>(a.cover ?? Infinity)-a.lead-((b.cover ?? Infinity)-b.lead)).map(r=>({sku:r.sku,reason: r.needed ? `${r.cover === null ? 'No recent demand' : `${r.cover} days of stock`} versus a ${r.lead}-day delivery lead. Target top-up: ${r.needed} units.` : 'Current stock covers the forecast window; leave this item out of the purchase.'})) };
}
// Allocation is bounded by trusted prices and stock targets. AI controls priority, never price or spending authority.
export function allocate(signals, advice, budget) {
  const rows = advice.priorities.map(p=>({...signals.find(s=>s.sku===p.sku), reason:p.reason, quantity:0}));
  let left = budget, progress = true;
  while (progress) {
    progress = false;
    for (const row of rows) if (row.quantity < row.needed && row.price <= left) { row.quantity++; left -= row.price; progress = true; }
  }
  return rows;
}
export function reviewedCart(items, plan) {
  assert(Array.isArray(items) && items.length > 0 && items.length <= catalog.length, 'Select at least one product.');
  const seen = new Set();
  const rows = items.map(item=> {
    const product = plan.rows.find(r=>r.sku===item.sku);
    assert(product && !seen.has(item.sku), 'Unknown or duplicate cart item.'); seen.add(item.sku);
    assert(Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= product.needed, 'Quantity exceeds the forecast target or is invalid.');
    return { sku: product.sku, name: product.name, unit: product.unit, quantity: item.quantity, price: product.price };
  });
  const total = rows.reduce((sum,r)=>sum+r.price*r.quantity,0);
  assert(total > 0 && total <= plan.settings.budget, 'The reviewed cart exceeds your approved budget.');
  return { items: rows, total };
}
export function verifiedPayment(response, order) {
  assert(response.id === order.paypalId, 'PayPal returned a different order.', 502);
  const units = response.purchase_units;
  assert(Array.isArray(units) && units.length === 1 && units[0].custom_id === order.id, 'PayPal order reference did not match.', 502);
  assert(units[0].amount?.currency_code === 'USD' && units[0].amount?.value === money(order.total), 'PayPal order amount did not match.', 502);
  const captures = units[0].payments?.captures || [];
  const paid = response.status === 'COMPLETED' && captures.length === 1 && captures[0].status === 'COMPLETED' && captures[0].amount?.currency_code === 'USD' && captures[0].amount?.value === money(order.total);
  return { state: paid ? 'paid' : response.status === 'APPROVED' ? 'approved' : response.status === 'COMPLETED' || captures.length ? 'pending' : 'awaiting-approval', paypalStatus: response.status, captureId: paid ? captures[0].id : null, checkedAt: new Date().toISOString() };
}
