// M14.1: the engine holds a migration to the exported call contract its legacy
// consumers rely on, and FINALIZE refuses source that changed after it was
// verified unless FINAL_VERIFY evidence was written after the change. These
// cases run the real analyzer and the real FINALIZE check over disposable
// directories; the M14 D1 shapes are reproduced, not described.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { exportAnalyzer, exportContractIssues, loadTypeScript, sourceReader } from "../../src/census/index.mjs";
import { HISTORY_FILE } from "../../src/formats/index.mjs";
import { fileIdentity } from "../../src/store/index.mjs";
import { assertVerificationFresh } from "../../src/slices/index.mjs";

const ts = loadTypeScript();

const tree = async (files) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "export contract "));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
};

// The M14 legacy module: CommonJS, `options` read through an alias, a coupon
// helper in another file that treats its `now` as a Date.
const LEGACY = {
  "discounts/coupons.js": `'use strict';
function validateCoupon(code, subtotal, now) {
  const today = (now || new Date()).toISOString().slice(0, 10);
  return { valid: String(code).trim() !== '' && subtotal >= 0, today };
}
module.exports = { validateCoupon };
`,
  "discounts/index.js": `'use strict';
const { validateCoupon } = require('./coupons');
function quote(cart, options) {
  const opts = options || {};
  const coupon = cart.coupon ? validateCoupon(cart.coupon, 1, opts.now) : null;
  return { items: cart && cart.items, tier: (cart.customer || {}).tier, coupon };
}
module.exports = { quote, validateCoupon: (code, subtotal, now) => validateCoupon(code, subtotal, now) };
`,
};

const COUPONS_ESM = `export function checkCoupon(code, subtotal, now) {
  return { valid: String(code).trim() !== '' && subtotal >= 0, today: now.toISOString() };
}
`;

const issuesFor = async (target, { legacy = LEGACY, symbols = ["*"], entry = "discounts/index.js", targetEntry = "src/index.js" } = {}) => {
  const legacyRoot = await tree(legacy);
  const targetRoot = await tree(target);
  try {
    const before = await exportAnalyzer(ts, sourceReader(legacyRoot)).contractOf(entry, symbols);
    const names = Object.keys(before.exports);
    const after = await exportAnalyzer(ts, sourceReader(targetRoot)).contractOf(targetEntry, names);
    return { before, issues: exportContractIssues(before, after, { legacyEntry: entry, targetEntry }) };
  } finally {
    await rm(legacyRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
};

test("the legacy contract is derived from source: every exported callable and the keys it reads per argument", async () => {
  const { before } = await issuesFor({ "src/index.js": "export {};\n" });
  assert.deepEqual(before.exports.quote.params.map(({ name, keys }) => ({ name, keys })), [
    { name: "cart", keys: ["coupon", "customer", "items"] },
    { name: "options", keys: ["now"] },
  ]);
  assert.deepEqual(before.exports.validateCoupon.params.map(({ keys }) => keys), [[], [], []]);
});

test("M14 D1: a target that turns the options bag into a bare Date is refused, naming the key it no longer reads", async () => {
  const { issues } = await issuesFor({
    "src/coupons.js": COUPONS_ESM,
    "src/index.js": `import { checkCoupon } from './coupons.js';
export function validateCoupon(code, subtotal, now = new Date()) { return checkCoupon(code, subtotal, now); }
export function quote(cart, now = new Date()) {
  const coupon = cart.coupon ? checkCoupon(cart.coupon, 1, now) : null;
  return { items: cart?.items, tier: cart.customer?.tier, coupon };
}
`,
  });
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.match(issues[0], /export 'quote\(cart, options\)' reads 'options\.now' from argument 2 \('options'\); target 'quote\(cart, now\)' never reads that key from its argument 2 \('now'\)/);
});

test("equivalent call contracts pass: delegation to another file, parameter destructuring, TypeScript and aliases", async () => {
  // The M14 candidate shape: quote hands both arguments to a pricing module.
  assert.deepEqual((await issuesFor({
    "src/coupons.js": COUPONS_ESM,
    "src/pricing.js": `import { checkCoupon } from './coupons.js';
export function priceCart(cart, options = {}) {
  const { now } = options ?? {};
  return { items: cart?.items, tier: cart.customer?.tier, coupon: cart.coupon ? checkCoupon(cart.coupon, 1, now) : null };
}
`,
    "src/index.js": `import { checkCoupon } from './coupons.js';
import { priceCart } from './pricing.js';
export function quote(cart, options) { return priceCart(cart, options); }
export function validateCoupon(code, subtotal, now) { return checkCoupon(code, subtotal, now); }
`,
  })).issues, []);
  assert.deepEqual((await issuesFor({
    "src/index.ts": `interface QuoteOptions { now?: Date }
export const quote = (cart: { items: unknown[]; customer?: { tier?: string }; coupon?: string }, { now }: QuoteOptions = {}) =>
  ({ items: cart.items, tier: cart.customer?.tier, coupon: cart.coupon, now });
export function validateCoupon(code: string, subtotal: number, now?: Date) { return { code, subtotal, now }; }
`,
  }, { targetEntry: "src/index.ts" })).issues, []);
  assert.deepEqual((await issuesFor({
    "src/index.js": `export function quote(cart, options) {
  const opts = options ?? {};
  if ('now' in opts) void 0;
  const { items, customer, coupon } = cart;
  return { items, tier: customer?.tier, coupon, now: opts["now"] };
}
export { validate as validateCoupon };
function validate(...args) { return args; }
`,
  })).issues, []);
});

test("a missing export, a non-callable export and a dropped argument are each refused", async () => {
  const { issues } = await issuesFor({
    "src/index.js": "export const quote = { cart: null };\n",
  });
  assert.equal(issues.length, 2, issues.join("\n"));
  assert.match(issues[0], /export 'quote\(cart, options\)' is callable; src\/index\.js exports 'quote' as a value/);
  assert.match(issues[1], /export 'validateCoupon\(code, subtotal, now\)' is not exported by src\/index\.js/);
  const dropped = (await issuesFor({
    "src/index.js": `export function quote(cart) { return { items: cart.items, customer: cart.customer, coupon: cart.coupon }; }
export function validateCoupon(code, subtotal, now) { return [code, subtotal, now]; }
`,
  })).issues;
  assert.equal(dropped.length, 1, dropped.join("\n"));
  assert.match(dropped[0], /reads argument 2 \('options'\); target 'quote\(cart\)' declares no parameter there/);
});

test("fail-open: a use the analyzer cannot establish never refuses an otherwise equivalent target", async () => {
  // Spread into a copy, handed to an external package, or a callee it cannot resolve.
  assert.deepEqual((await issuesFor({
    "src/index.js": `import { price } from 'pricing-lib';
export function quote(cart, options) { return price({ ...cart }, options); }
export const validateCoupon = (code, subtotal, now) => lookup(code, subtotal, now);
`,
  })).issues, []);
  // A legacy export whose value is decided at run time carries no obligation.
  const dynamic = await issuesFor({ "src/index.js": "export {};\n" }, {
    legacy: { "discounts/index.js": "module.exports = build();\nfunction build() { return {}; }\n" },
  });
  assert.equal(dynamic.before.exports.default.kind, "UNRESOLVED");
  assert.deepEqual(dynamic.issues, []);
});

test("CommonJS default exports and ESM re-exports resolve to the function they name", async () => {
  const legacy = { "discounts/index.js": "module.exports = function quote(cart, options) { return options.now + cart.total; };\n" };
  assert.deepEqual((await issuesFor({
    "src/impl.js": "export default function quote(cart, { now }) { return now + cart.total; }\n",
    "src/index.js": "export { default } from './impl.js';\n",
  }, { legacy })).issues, []);
  const broken = (await issuesFor({
    "src/impl.js": "export default function quote(cart, now) { return now.getTime() + cart.total; }\n",
    "src/index.js": "export { default } from './impl.js';\n",
  }, { legacy })).issues;
  assert.equal(broken.length, 1, broken.join("\n"));
  assert.match(broken[0], /reads 'options\.now' from argument 2/);
  assert.deepEqual((await issuesFor({
    "src/impl.js": "export function quote(cart, options) { return options?.now; }\nexport function validateCoupon() { return arguments; }\n",
    "src/index.js": "export * from './impl.js';\n",
  }, { legacy: { ...LEGACY, "discounts/index.js": LEGACY["discounts/index.js"] } })).issues.filter((issue) => !issue.includes("'cart.")), []);
});

test("a parameter declared again inside the function is open on either side, never a guessed obligation", async () => {
  // Legacy reads `options.discount` only on a nested, unrelated `options`.
  const legacy = { "discounts/index.js": `function quote(cart, options) {
  const opts = options || {};
  const lines = cart.items.map((item) => { const options = item.options; return options.discount; });
  return { lines, now: opts.now };
}
module.exports = { quote };
` };
  const { before, issues } = await issuesFor({ "src/index.js": "export function quote(cart, { now } = {}) { return { lines: cart.items, now }; }\n" }, { legacy });
  assert.deepEqual(before.exports.quote.params[1], { name: "options", keys: [], open: true, used: true });
  assert.deepEqual(issues, []);
  // On the target side a redeclared parameter satisfies whatever legacy read.
  assert.deepEqual((await issuesFor({ "src/index.js": `export function quote(cart, options) {
  { const options = cart.coupon; void options; }
  return [cart.items, cart.customer, cart.coupon, options];
}
export function validateCoupon(code, subtotal, now) { return [code, subtotal, now]; }
` })).issues, []);
});

test("a destructured CommonJS require names the exports its consumer takes; a whole-module require takes all", async () => {
  const root = await tree({
    ...LEGACY,
    "orders/checkout.js": "'use strict';\nconst { quote } = require('../discounts');\nconst all = require('../discounts');\nconst { validateCoupon: check } = require(\n  '../discounts/coupons');\n",
  });
  try {
    const legacy = exportAnalyzer(ts, sourceReader(root));
    assert.deepEqual(await legacy.requiredNames("orders/checkout.js", "discounts/index.js", 2), ["quote"]);
    assert.equal(await legacy.requiredNames("orders/checkout.js", "discounts/index.js", 3), null);
    // The scan's edge line is the `require(` call's own line.
    assert.deepEqual(await legacy.requiredNames("orders/checkout.js", "discounts/coupons.js", 4), ["validateCoupon"]);
    assert.equal(await legacy.requiredNames("orders/checkout.js", "discounts/coupons.js", 5), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- FINALIZE: verification freshness -----------------------------------

const verifyEvent = (seq, slice, verifiedFiles) =>
  ({ event: "STEP_COMPLETED", step: "VERIFY_SLICES", slice, nextStep: "FINALIZE", revision: seq, ...(verifiedFiles ? { verifiedFiles } : {}) });

const finalizeFixture = async () => {
  const targetRoot = await tree({
    "src/a.js": "export const a = 1;\n",
    "src/b.js": "export const b = 1;\n",
    "evidence/slice-a.txt": "ok 1 - a\n",
  });
  const legacyRoot = await tree({ "legacy.js": "\n" });
  const root = path.join(targetRoot, ".agents/knowledge/migrations/modules/m");
  await mkdir(path.join(root, path.dirname(HISTORY_FILE)), { recursive: true });
  const roots = { legacyRoot, targetRoot };
  const history = (events) => writeFile(path.join(root, HISTORY_FILE), events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  const finalVerify = (...references) => writeFile(path.join(root, "gates.json"), JSON.stringify({ version: 1, gates: [
    { gate: "FINAL_VERIFY", result: "PASS", attempts: 1, evidence: references.map((reference) => ({ kind: "test", reference })) }] }));
  // Modification times are set explicitly: the rule reads them, so the test must not race the clock.
  const at = (file, seconds) => utimes(path.join(targetRoot, file), seconds, seconds);
  const cleanup = async () => {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(legacyRoot, { recursive: true, force: true });
  };
  return { targetRoot, root, roots, history, finalVerify, at, cleanup };
};

test("FINALIZE refuses source changed after VERIFY_SLICES unless FINAL_VERIFY evidence was written after the change", async () => {
  const fixture = await finalizeFixture();
  const { targetRoot, root, roots, history, finalVerify, at } = fixture;
  const state = { completedSlices: ["slice-a"] };
  try {
    const identity = (file) => fileIdentity(path.join(targetRoot, file));
    await history([verifyEvent(7, "slice-a", { "src/a.js": await identity("src/a.js"), "src/b.js": await identity("src/b.js") })]);
    await finalVerify("evidence/slice-a.txt");
    // Unchanged since verification: slice evidence is fresh, nothing more is owed.
    await assertVerificationFresh({ root, state, roots });

    // The M14 run-3 shape: a FINALIZE-time simplification after both slices verified.
    await writeFile(path.join(targetRoot, "src/b.js"), "export const b = 2;\n");
    await at("evidence/slice-a.txt", 1000);
    await at("src/b.js", 2000);
    await assert.rejects(assertVerificationFresh({ root, state, roots }), (error) =>
      error.validationCode === "STALE_VERIFICATION_EVIDENCE" &&
      /'src\/b\.js' \(verified by slice-a\) changed after VERIFY_SLICES verified it, and no FINAL_VERIFY evidence file was written after the change/.test(error.message));
    // The changed file itself is never evidence about the change.
    await finalVerify("evidence/slice-a.txt", "src/b.js");
    await assert.rejects(assertVerificationFresh({ root, state, roots }), { validationCode: "STALE_VERIFICATION_EVIDENCE" });

    // A re-run recorded after the change satisfies it.
    await writeFile(path.join(targetRoot, "evidence/final.txt"), "ok 1 - a\nok 2 - b\n");
    await at("evidence/final.txt", 3000);
    await finalVerify("evidence/slice-a.txt", "evidence/final.txt");
    await assertVerificationFresh({ root, state, roots });

    // Restoring the verified bytes needs no new evidence either.
    await writeFile(path.join(targetRoot, "src/b.js"), "export const b = 1;\n");
    await finalVerify("evidence/slice-a.txt");
    await assertVerificationFresh({ root, state, roots });
  } finally {
    await fixture.cleanup();
  }
});

test("each file is judged by the newest verification that covered it; a record verified before snapshots existed is not judged", async () => {
  const fixture = await finalizeFixture();
  const { targetRoot, root, roots, history, finalVerify, at } = fixture;
  const state = { completedSlices: ["slice-a", "slice-b"] };
  try {
    const before = await fileIdentity(path.join(targetRoot, "src/a.js"));
    await writeFile(path.join(targetRoot, "src/a.js"), "export const a = 2;\n");
    await at("src/a.js", 2000);
    await at("evidence/slice-a.txt", 1000);
    await finalVerify("evidence/slice-a.txt");
    // slice-b rewrote slice-a's file and verified it again: the newer snapshot governs.
    const after = await fileIdentity(path.join(targetRoot, "src/a.js"));
    await history([verifyEvent(7, "slice-a", { "src/a.js": before }), verifyEvent(9, "slice-b", { "src/a.js": after })]);
    await assertVerificationFresh({ root, state, roots });
    // Reversed, the older snapshot is stale.
    await history([verifyEvent(7, "slice-b", { "src/a.js": after }), verifyEvent(9, "slice-a", { "src/a.js": before })]);
    await assert.rejects(assertVerificationFresh({ root, state, roots }), /'src\/a\.js' \(verified by slice-a\)/);
    // A slice verified again judges by its newest snapshot only: what it no longer claims is not held.
    await history([verifyEvent(7, "slice-a", { "src/a.js": before }), verifyEvent(9, "slice-a", { "src/b.js": await fileIdentity(path.join(targetRoot, "src/b.js")) })]);
    await assertVerificationFresh({ root, state, roots });
    // A slice the record no longer counts as completed (a reopened or replanned one) sets nothing.
    await history([verifyEvent(7, "slice-a", { "src/a.js": before })]);
    await assertVerificationFresh({ root, state: { completedSlices: ["slice-b"] }, roots });
    await assert.rejects(assertVerificationFresh({ root, state, roots }), { validationCode: "STALE_VERIFICATION_EVIDENCE" });
    // Events written before M14.1 carry no snapshot: the existing record keeps its behavior.
    await history([verifyEvent(7, "slice-a"), verifyEvent(9, "slice-b")]);
    await assertVerificationFresh({ root, state, roots });
  } finally {
    await fixture.cleanup();
  }
});
