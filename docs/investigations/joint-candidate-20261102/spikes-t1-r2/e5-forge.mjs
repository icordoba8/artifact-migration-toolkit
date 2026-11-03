// E5 path-4 spike: is an AGENT_RELAYED line written by plain file I/O (no engine code) accepted?
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
// Run via `node scripts/engine-test.mjs <this file>` (fixture identity, temp root).
const engine = path.resolve(process.argv[2] ?? "packages/migration-engine");
const { createSession, handleMessage } = await import(`${engine}/src/mcp-server.mjs`);
const { createFixture, atDirectLedgerCompleteness, EXCLUDED_CLASSIFICATION } = await import(`${engine}/test/integration/approval.fixture.mjs`);
const call = async (name, args) => JSON.parse((await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, createSession())).result.content.at(-1).text);
const fixture = await createFixture();
await atDirectLedgerCompleteness(fixture, EXCLUDED_CLASSIFICATION);
const run = await call("migration_run", { module: "auth", cwd: fixture.root, mode: "auto" });
const ledger = path.join(fixture.root, "target/.agents/knowledge/migrations/modules/auth/decisions/operator-decisions.ndjson");
const before = await readFile(ledger, "utf8").catch(() => "");
const relayed = await call("migration_relay_decision", { module: "auth", cwd: fixture.root, reference: run.operatorApproval.reference, decision: "APPROVE" });
const after = await readFile(ledger, "utf8");
const line = after.slice(before.length);
console.log("relay:", relayed.outcome, relayed.recorded, "| line keys:", Object.keys(JSON.parse(line)).join(","));
// Undo with plain I/O, then re-append the same bytes with plain I/O (no engine import on this path).
await writeFile(ledger, before); await appendFile(ledger, line);
const next = await call("migration_run", { module: "auth", cwd: fixture.root, mode: "auto" });
console.log("after plain-I/O append: outcome", next.outcome, "| still OPERATOR_DECISION?", next.outcome === "OPERATOR_DECISION");
console.log("line:", line.trim().slice(0, 400));
