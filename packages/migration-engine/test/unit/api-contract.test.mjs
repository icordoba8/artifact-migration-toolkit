// Format 21 / scanner algorithm 5: the legacy API response contract is derived
// from source and the OpenSpec is held to it. These cases run the real scanner
// over a disposable git repository; nothing here hardcodes a status or an
// identifier the engine is supposed to find.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { apiContractIssues, openSpecResponses, runDiscoveryScan } from "../../src/census/index.mjs";

const exec = promisify(execFile);

// Three layers: routes map identifiers to statuses with a table and a fallback,
// a service throws identifiers, and a lookup helper two files away throws too.
const ORDERS = {
  "orders/order-error.js": `export class OrderError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
`,
  "orders/order-lookup.js": `import { OrderError } from "./order-error.js";
const rows = new Map();
export const find = (id) => {
  const row = rows.get(id);
  if (!row) throw new OrderError("NOT_FOUND", "No such order");
  return row;
};
`,
  "orders/order-service.js": `import { OrderError } from "./order-error.js";
import { find } from "./order-lookup.js";
export function ship(id) {
  const order = find(id);
  if (order.locked) throw new OrderError("ORDER_LOCKED", "Locked");
  if (order.shipped) throw new OrderError("ALREADY_SHIPPED", "Shipped");
  return { ...order, shipped: true };
}
export const quote = (input) => {
  if (!input?.sku) throw new OrderError("SKU_REQUIRED", "A SKU is required");
  return { total: 1 };
};
`,
  "orders/order-routes.js": `import * as service from "./order-service.js";
import { OrderError } from "./order-error.js";
const STATUS = { NOT_FOUND: 404, ORDER_LOCKED: 423, ALREADY_SHIPPED: 409 };
const guard = (fn) => async (req) => {
  try {
    return await fn(req);
  } catch (e) {
    if (!(e instanceof OrderError)) return { status: 503, body: { error: "UNAVAILABLE" }, headers: { "Retry-After": "5" } };
    return { status: STATUS[e.code] || 400, body: { error: e.code, detail: e.message } };
  }
};
export const routes = {
  "POST /orders/:id/ship": guard((req) => ({ status: 202, body: service.ship(req.params.id) })),
  "POST /quotes": guard((req) => ({ status: 200, body: { state: "QUOTED", total: service.quote(req.body).total } })),
};
`,
};

const repository = async (files) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "api-contract-"));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["add", "-A"], { cwd: root });
  await exec("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
  return root;
};

const contractOf = async (files, algorithmVersion = 5) => {
  const root = await repository(files);
  try {
    return await runDiscoveryScan({ legacyRoot: root, moduleRoots: ["orders"], algorithmVersion });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const ids = (scan) => scan.apiContract.obligations.map((o) => o.id);

test("algorithm 5 traces route-layer mapping tables, fallbacks and runtime faults across files", async () => {
  const scan = await contractOf(ORDERS);
  assert.deepEqual(scan.apiContract.unresolved, []);
  assert.deepEqual(ids(scan), [
    "POST /orders/:id/ship -> 202",
    "POST /orders/:id/ship -> 404 NOT_FOUND body{detail,error}",
    "POST /orders/:id/ship -> 409 ALREADY_SHIPPED body{detail,error}",
    "POST /orders/:id/ship -> 423 ORDER_LOCKED body{detail,error}",
    "POST /orders/:id/ship -> 503 UNAVAILABLE body{error} headers{retry-after}",
    // An uppercase value in a success body is data, not an error identifier.
    "POST /quotes -> 200 body{state,total}",
    "POST /quotes -> 400 SKU_REQUIRED body{detail,error}",
    "POST /quotes -> 503 UNAVAILABLE body{error} headers{retry-after}",
  ]);
  // Provenance names the route, the status expression and the raise site two layers down.
  const notFound = scan.apiContract.obligations.find((o) => o.code === "NOT_FOUND");
  assert.match(notFound.route, /^orders\/order-routes\.js:\d+$/);
  assert.match(notFound.statusAt, /^orders\/order-routes\.js:\d+$/);
  assert.deepEqual(notFound.origins, ["orders/order-lookup.js:5"]);
});

test("a conflict status is read from the mapping table, never assumed", async () => {
  const teapot = { ...ORDERS, "orders/order-routes.js": ORDERS["orders/order-routes.js"].replace("ALREADY_SHIPPED: 409", "ALREADY_SHIPPED: 418") };
  const scan = await contractOf(teapot);
  assert.ok(ids(scan).includes("POST /orders/:id/ship -> 418 ALREADY_SHIPPED body{detail,error}"));
  assert.ok(!ids(scan).some((id) => id.includes("409")));
  // Removing the row sends the identifier through the route layer's own fallback.
  const unmapped = { ...ORDERS, "orders/order-routes.js": ORDERS["orders/order-routes.js"].replace(", ALREADY_SHIPPED: 409", "") };
  assert.ok(ids(await contractOf(unmapped)).includes("POST /orders/:id/ship -> 400 ALREADY_SHIPPED body{detail,error}"));
});

test("a dynamic mapping, identifier or convention is UNRESOLVED, never defaulted", async () => {
  const dynamic = { ...ORDERS,
    "orders/order-routes.js": ORDERS["orders/order-routes.js"].replace("STATUS[e.code] || 400", "statusFor(e)")
      .replace("const guard", "const statusFor = (e) => { switch (e.code) { case 'NOT_FOUND': return 404; default: return 400; } };\nconst guard"),
    "orders/order-service.js": ORDERS["orders/order-service.js"].replace('new OrderError("SKU_REQUIRED"', "new OrderError(input.kind"),
    "orders/express.js": `export const mount = (app) => app.post("/legacy", (req, res) => res.status(201).json({}));\n`,
    "orders/app/api/ping/route.js": `export async function GET() { return Response.json({ ok: true }); }\n`,
    // A declaration that refers to itself must terminate, not overflow the stack.
    "orders/cycle.js": `const code = pick();\nfunction pick() { return code ?? "X"; }\nexport const routes = { "GET /cycle": () => ({ status: code }) };\n`,
  };
  const { unresolved } = (await contractOf(dynamic)).apiContract;
  const reasons = unresolved.map((u) => `${u.endpoint} | ${u.reason}`);
  assert.ok(reasons.some((r) => r.startsWith("POST /orders/:id/ship | the response status cannot be established")), reasons.join("\n"));
  assert.ok(reasons.some((r) => r.startsWith("POST /quotes | the thrown error's identifier cannot be established")), reasons.join("\n"));
  assert.ok(reasons.some((r) => r.startsWith("POST /legacy | an Express-style route registration")), reasons.join("\n"));
  assert.ok(reasons.some((r) => r.startsWith("GET orders/app/api/ping/route.js | a Next.js route handler")), reasons.join("\n"));
  assert.ok(reasons.some((r) => r.startsWith("GET /cycle | the response status cannot be established")), reasons.join("\n"));
  for (const entry of unresolved) assert.match(entry.at, /^orders\/.+:\d+$/);
});

test("a module without endpoints owes no response obligations, and older algorithms carry no contract", async () => {
  const ui = { "orders/view.js": "export const render = () => fetch('/orders').then((r) => r.status === 404 ? [] : r.json());\n" };
  assert.deepEqual((await contractOf(ui)).apiContract, { version: 1, obligations: [], unresolved: [] });
  const four = await contractOf(ORDERS, 4);
  assert.equal("apiContract" in four, false);
  // The contract is part of the algorithm-5 digest only: a mapping change moves it, not algorithm 4's.
  const changed = { ...ORDERS, "orders/order-routes.js": ORDERS["orders/order-routes.js"].replace("ORDER_LOCKED: 423", "ORDER_LOCKED: 409") };
  assert.equal((await contractOf(changed, 4)).discoveryDigest, four.discoveryDigest);
  assert.notEqual((await contractOf(changed)).discoveryDigest, (await contractOf(ORDERS)).discoveryDigest);
});

const spec = (lines) => `# Orders

### Requirement: ORDERS-REQ-001 Ship
The target MUST ship an order.

#### Scenario: ORDERS-SCN-001 Ship outcomes
Shipping reports every legacy outcome.
${lines.map((line) => `- Response: ${line}`).join("\n")}
`;

test("the OpenSpec must cite every derived response verbatim and nothing else", async () => {
  const scan = await contractOf(ORDERS);
  const all = ids(scan);
  assert.deepEqual(apiContractIssues(scan.apiContract, spec(all), "openspec/specs/orders/spec.md"), []);

  // Service identifiers named in prose, route-layer statuses omitted: the production failure.
  const prose = `${spec([])}\nDUPLICATE handling: ORDER_LOCKED and ALREADY_SHIPPED are refused.\n`;
  const blocked = apiContractIssues(scan.apiContract, prose, "spec.md");
  assert.equal(blocked.filter((issue) => issue.startsWith("API_RESPONSE_UNCOVERED")).length, all.length);
  assert.ok(blocked.some((issue) => issue.includes("'POST /orders/:id/ship -> 409 ALREADY_SHIPPED body{detail,error}'") && issue.includes("orders/order-routes.js")));

  // Missing fallback: the 400 the route layer's `|| 400` produces.
  const noFallback = all.filter((id) => !id.includes("400"));
  assert.deepEqual(apiContractIssues(scan.apiContract, spec(noFallback), "spec.md").map((i) => i.split(":")[0]), ["API_RESPONSE_UNCOVERED"]);

  // Missing identifier and wrong status are both an ungrounded citation and an uncovered response.
  for (const wrong of ["POST /orders/:id/ship -> 409 body{detail,error}", "POST /orders/:id/ship -> 422 ALREADY_SHIPPED body{detail,error}"]) {
    const cited = all.filter((id) => !id.includes("ALREADY_SHIPPED")).concat(wrong);
    const issues = apiContractIssues(scan.apiContract, spec(cited), "spec.md");
    assert.deepEqual(issues.map((i) => i.split(":")[0]).sort(), ["API_RESPONSE_UNCOVERED", "API_RESPONSE_UNGROUNDED"]);
  }

  // A citation outside a scenario can never be verified.
  const outside = `- Response: ${all[0]}\n${spec(all)}`;
  assert.match(apiContractIssues(scan.apiContract, outside, "spec.md")[0], /^API_RESPONSE_MALFORMED: spec.md line 1/);
  assert.deepEqual([...openSpecResponses(spec(all)).cited.get(all[0])], ["ORDERS-SCN-001"]);
});
