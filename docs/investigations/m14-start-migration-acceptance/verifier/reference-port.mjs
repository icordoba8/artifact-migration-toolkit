const C = { SAVE10: { kind: 'percent', rate: 0.10, min: 5000 }, FLAT500: { kind: 'fixed', amount: 500, min: 2000 },
  FREESHIP: { kind: 'shipping', min: 0 }, SUMMER23: { kind: 'percent', rate: 0.15, min: 0, expires: '2023-09-30' } };
const LOY = { standard: 0, gold: 0.02, platinum: 0.04 };
const round = v => Math.floor(v + 0.5);
const err = (code) => Object.assign(new Error(code), { code });
function check(code, subtotal, now) {
  const key = String(code).trim().toUpperCase(); const c = C[key];
  if (!c) return { valid: false, code: key, reason: 'UNKNOWN_COUPON' };
  const today = (now || new Date()).toISOString().slice(0, 10);
  if (c.expires && today > c.expires) return { valid: false, code: key, reason: 'COUPON_EXPIRED' };
  if (subtotal < c.min) return { valid: false, code: key, reason: 'COUPON_MINIMUM_NOT_MET' };
  return { valid: true, code: key, c };
}
export function validateCoupon(code, subtotal, now) { const r = check(code, subtotal, now); return r.valid ? { valid: true, code: r.code } : r; }
export function quote(cart, opts = {}) {
  const items = cart && cart.items;
  if (!Array.isArray(items) || !items.length) throw err('EMPTY_CART');
  for (const i of items) { if (!Number.isInteger(i.qty) || i.qty < 1) throw err('INVALID_QTY'); if (!Number.isInteger(i.unitPrice) || i.unitPrice < 0) throw err('INVALID_PRICE'); }
  const tier = (cart.customer || {}).tier; const loy = tier == null ? 0 : (Object.hasOwn(LOY, tier) ? LOY[tier] : null);
  if (loy === null) throw err('UNKNOWN_TIER');
  const subtotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0), qty = items.reduce((s, i) => s + i.qty, 0);
  const discounts = []; let rem = subtotal;
  const vol = round(rem * (qty >= 50 ? 0.10 : qty >= 10 ? 0.05 : 0)); if (vol > 0) { discounts.push({ code: 'VOLUME', amount: vol }); rem -= vol; }
  const l = round(rem * loy); if (l > 0) { discounts.push({ code: 'LOYALTY', amount: l }); rem -= l; }
  let free = false;
  if (cart.coupon != null && cart.coupon !== '') {
    const r = check(cart.coupon, subtotal, opts.now); if (!r.valid) throw err(r.reason);
    let a = 0; if (r.c.kind === 'percent') a = round(rem * r.c.rate); else if (r.c.kind === 'fixed') a = Math.min(r.c.amount, rem); else free = true;
    if (a > 0) { discounts.push({ code: r.code, amount: a }); rem -= a; }
  }
  const shipping = free || rem >= 5000 ? 0 : 799;
  return { currency: 'USD', subtotal, discounts, shipping, total: rem + shipping };
}
