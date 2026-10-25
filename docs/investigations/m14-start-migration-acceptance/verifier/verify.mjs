// Independent behavioral verifier for the legacy-shop `discounts` module.
// Usage: node verify.mjs <target-root> [report-dir]   (or --module <file> to test a file directly)
// Exit 0 only when the target's public API matches the pinned legacy behavior.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const legacy = createRequire(import.meta.url)(path.join(here, 'legacy-ref/src/features/discounts/index.js'));
const args = process.argv.slice(2);
const modFile = args[0] === '--module' ? path.resolve(args[1]) : path.join(path.resolve(args[0]), 'src/features/discounts/index.js');
const reportDir = args[0] === '--module' ? null : args[1];
const target = await import(pathToFileURL(modFile).href);

const results = [];
const check = (id, fn) => { try { fn(); results.push({ id, pass: true }); } catch (e) { results.push({ id, pass: false, detail: String(e.message).slice(0, 300) }); } };
const eq = (a, b, what) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${what}: got ${x} expected ${y}`); };
const outcome = (fn) => { try { return { value: fn() }; } catch (e) { return { error: e instanceof Error ? (e.code ?? 'NO_CODE') : 'NOT_AN_ERROR' }; } };
const D = s => new Date(s + 'T12:00:00Z');
const NOW = { now: D('2026-01-15') };

// API surface
check('API-001 exports quote and validateCoupon functions', () => {
  if (typeof target.quote !== 'function') throw new Error('quote missing');
  if (typeof target.validateCoupon !== 'function') throw new Error('validateCoupon missing');
});

// Hand-computed expectations (derived from the legacy rules, not from running it)
const cases = [
  ['Q-001 single item, no discount, shipping charged', { items: [{ sku: 'A', unitPrice: 1999, qty: 1 }] },
    { value: { currency: 'USD', subtotal: 1999, discounts: [], shipping: 799, total: 2798 } }],
  ['Q-002 free shipping at exactly 5000', { items: [{ sku: 'A', unitPrice: 2500, qty: 2 }] },
    { value: { currency: 'USD', subtotal: 5000, discounts: [], shipping: 0, total: 5000 } }],
  ['Q-003 volume 5% at 10 items, half-up rounding 52.5->53', { items: [{ sku: 'A', unitPrice: 105, qty: 10 }] },
    { value: { currency: 'USD', subtotal: 1050, discounts: [{ code: 'VOLUME', amount: 53 }], shipping: 799, total: 1796 } }],
  ['Q-004 volume 10% at 50 items', { items: [{ sku: 'A', unitPrice: 100, qty: 50 }] },
    { value: { currency: 'USD', subtotal: 5000, discounts: [{ code: 'VOLUME', amount: 500 }], shipping: 799, total: 5299 } }],
  ['Q-005 9 items get no volume discount', { items: [{ sku: 'A', unitPrice: 100, qty: 9 }] },
    { value: { currency: 'USD', subtotal: 900, discounts: [], shipping: 799, total: 1699 } }],
  ['Q-006 loyalty applies after volume on remaining', { items: [{ sku: 'A', unitPrice: 1000, qty: 12 }], customer: { tier: 'gold' } },
    { value: { currency: 'USD', subtotal: 12000, discounts: [{ code: 'VOLUME', amount: 600 }, { code: 'LOYALTY', amount: 228 }], shipping: 0, total: 11172 } }],
  ['Q-007 platinum 4%', { items: [{ sku: 'A', unitPrice: 2000, qty: 1 }], customer: { tier: 'platinum' } },
    { value: { currency: 'USD', subtotal: 2000, discounts: [{ code: 'LOYALTY', amount: 80 }], shipping: 799, total: 2719 } }],
  ['Q-008 SAVE10 trimmed and case-insensitive, after volume and loyalty', { items: [{ sku: 'A', unitPrice: 1000, qty: 12 }], customer: { tier: 'gold' }, coupon: ' save10 ' },
    { value: { currency: 'USD', subtotal: 12000, discounts: [{ code: 'VOLUME', amount: 600 }, { code: 'LOYALTY', amount: 228 }, { code: 'SAVE10', amount: 1117 }], shipping: 0, total: 10055 } }],
  ['Q-009 FLAT500 fixed amount', { items: [{ sku: 'A', unitPrice: 2000, qty: 1 }], coupon: 'FLAT500' },
    { value: { currency: 'USD', subtotal: 2000, discounts: [{ code: 'FLAT500', amount: 500 }], shipping: 799, total: 2299 } }],
  ['Q-010 FREESHIP waives shipping, no discount row', { items: [{ sku: 'A', unitPrice: 300, qty: 1 }], coupon: 'freeship' },
    { value: { currency: 'USD', subtotal: 300, discounts: [], shipping: 0, total: 300 } }],
  ['Q-011 shipping decided on the discounted amount', { items: [{ sku: 'A', unitPrice: 5000, qty: 1 }], coupon: 'SAVE10' },
    { value: { currency: 'USD', subtotal: 5000, discounts: [{ code: 'SAVE10', amount: 500 }], shipping: 799, total: 5299 } }],
  ['Q-012 SUMMER23 valid on its last day', { items: [{ sku: 'A', unitPrice: 1000, qty: 1 }], coupon: 'SUMMER23' },
    { value: { currency: 'USD', subtotal: 1000, discounts: [{ code: 'SUMMER23', amount: 150 }], shipping: 799, total: 1649 } }, { now: D('2023-09-30') }],
  ['Q-013 empty coupon string is ignored', { items: [{ sku: 'A', unitPrice: 100, qty: 1 }], coupon: '' },
    { value: { currency: 'USD', subtotal: 100, discounts: [], shipping: 799, total: 899 } }],
  ['Q-014 zero-priced items allowed', { items: [{ sku: 'A', unitPrice: 0, qty: 3 }] },
    { value: { currency: 'USD', subtotal: 0, discounts: [], shipping: 799, total: 799 } }],
  ['Q-015 null tier means no loyalty', { items: [{ sku: 'A', unitPrice: 100, qty: 1 }], customer: { tier: null } },
    { value: { currency: 'USD', subtotal: 100, discounts: [], shipping: 799, total: 899 } }],
  ['Q-016 coupon minimum uses the subtotal even when volume lowers the remaining amount', { items: [{ sku: 'A', unitPrice: 500, qty: 10 }], coupon: 'SAVE10' },
    { value: { currency: 'USD', subtotal: 5000, discounts: [{ code: 'VOLUME', amount: 250 }, { code: 'SAVE10', amount: 475 }], shipping: 799, total: 5074 } }],
  ['E-001 empty items', { items: [] }, { error: 'EMPTY_CART' }],
  ['E-002 missing cart', null, { error: 'EMPTY_CART' }],
  ['E-003 fractional qty', { items: [{ sku: 'A', unitPrice: 100, qty: 1.5 }] }, { error: 'INVALID_QTY' }],
  ['E-004 zero qty', { items: [{ sku: 'A', unitPrice: 100, qty: 0 }] }, { error: 'INVALID_QTY' }],
  ['E-005 negative price', { items: [{ sku: 'A', unitPrice: -1, qty: 1 }] }, { error: 'INVALID_PRICE' }],
  ['E-006 qty checked before price', { items: [{ sku: 'A', unitPrice: -1, qty: 0 }] }, { error: 'INVALID_QTY' }],
  ['E-007 unknown tier', { items: [{ sku: 'A', unitPrice: 100, qty: 1 }], customer: { tier: 'diamond' } }, { error: 'UNKNOWN_TIER' }],
  ['E-008 unknown coupon', { items: [{ sku: 'A', unitPrice: 100, qty: 1 }], coupon: 'BOGUS' }, { error: 'UNKNOWN_COUPON' }],
  ['E-009 coupon minimum compared to pre-discount subtotal', { items: [{ sku: 'A', unitPrice: 4999, qty: 1 }], coupon: 'SAVE10' }, { error: 'COUPON_MINIMUM_NOT_MET' }],
  ['E-010 expired coupon', { items: [{ sku: 'A', unitPrice: 100, qty: 1 }], coupon: 'SUMMER23' }, { error: 'COUPON_EXPIRED' }, { now: D('2023-10-01') }],
  ['E-011 tier error precedes coupon error', { items: [{ sku: 'A', unitPrice: 100, qty: 1 }], customer: { tier: 'x' }, coupon: 'BOGUS' }, { error: 'UNKNOWN_TIER' }],
];
for (const [id, cart, expected, opts] of cases) check(id, () => eq(outcome(() => target.quote(cart, opts ?? NOW)), expected, 'quote'));

check('E-012 domain errors are Error instances carrying the code', () => {
  try { target.quote({ items: [] }, NOW); throw new Error('no throw'); }
  catch (e) { if (!(e instanceof Error) || e.code !== 'EMPTY_CART') throw new Error('not an Error with code'); }
});

const vcases = [
  ['V-001 valid coupon normalizes the code', [' save10 ', 5000, D('2026-01-01')], { valid: true, code: 'SAVE10' }],
  ['V-002 unknown', ['nope', 5000, D('2026-01-01')], { valid: false, code: 'NOPE', reason: 'UNKNOWN_COUPON' }],
  ['V-003 below minimum', ['FLAT500', 1999, D('2026-01-01')], { valid: false, code: 'FLAT500', reason: 'COUPON_MINIMUM_NOT_MET' }],
  ['V-004 expired is checked before minimum', ['summer23', 0, D('2024-01-01')], { valid: false, code: 'SUMMER23', reason: 'COUPON_EXPIRED' }],
  ['V-005 last valid day inclusive', ['SUMMER23', 0, D('2023-09-30')], { valid: true, code: 'SUMMER23' }],
  ['V-006 default now: SUMMER23 is expired today', ['SUMMER23', 0], { valid: false, code: 'SUMMER23', reason: 'COUPON_EXPIRED' }],
];
for (const [id, a, expected] of vcases) check(id, () => eq(target.validateCoupon(...a), expected, 'validateCoupon'));

// Differential against the pinned legacy module: deterministic pseudo-random carts.
let seed = 0x4d14;
const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const pick = a => a[rnd(a.length)];
check('DIFF-001 3000 generated carts match legacy exactly (value or error code)', () => {
  for (let i = 0; i < 3000; i++) {
    const items = Array.from({ length: rnd(4) }, (_, k) => ({ sku: 'S' + k,
      unitPrice: pick([0, 1, 99, 105, 333, 999, 1250, 1999, 2500, 4999, -5, 10.5]),
      qty: pick([1, 1, 2, 3, 7, 9, 10, 11, 25, 49, 50, 60, 0, 2.5]) }));
    const cart = { items };
    const tier = pick([undefined, null, 'standard', 'gold', 'platinum', 'bronze']);
    if (tier !== undefined) cart.customer = { tier };
    const coupon = pick([undefined, undefined, '', null, 'SAVE10', 'save10 ', 'FLAT500', 'FREESHIP', 'SUMMER23', 'X1']);
    if (coupon !== undefined) cart.coupon = coupon;
    const opts = { now: pick([D('2023-06-01'), D('2023-09-30'), D('2023-10-01'), D('2026-01-15')]) };
    const a = outcome(() => target.quote(structuredClone(cart), opts));
    const b = outcome(() => legacy.quote(structuredClone(cart), opts));
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`case ${i} ${JSON.stringify(cart)}: target ${JSON.stringify(a)} legacy ${JSON.stringify(b)}`);
  }
});
check('DIFF-002 inputs are not mutated', () => {
  const cart = { items: [{ sku: 'A', unitPrice: 1000, qty: 12 }], customer: { tier: 'gold' }, coupon: ' save10 ' };
  const before = JSON.stringify(cart); target.quote(cart, NOW);
  if (JSON.stringify(cart) !== before) throw new Error('cart mutated');
});

const passed = results.filter(r => r.pass).length;
const report = { verifier: 'm14-discounts', module: modFile, passed, total: results.length, failures: results.filter(r => !r.pass) };
if (reportDir) { fs.mkdirSync(reportDir, { recursive: true }); fs.writeFileSync(path.join(reportDir, 'verifier-result.json'), JSON.stringify({ ...report, results }, null, 2)); }
console.log(JSON.stringify(report, null, 1));
process.exit(passed === results.length ? 0 : 1);
