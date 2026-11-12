// E5 condition 3: did any certification run R1–R12 relay a decision? Scans every
// tool invocation (MCP tool calls, shell commands, code-mode exec input) in the
// rollouts and every operator ledger left in the run roots.
// Usage: node e5-r1-r12-search.mjs <m15 runs dir> <glob-free parent of amt-m15-cert-R* roots>
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const [runs, parent] = process.argv.slice(2);
const RELAY = /migration_relay_decision|artifact-migration-decision|--relay\b|record-decision|AGENT_RELAYED/;
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const file = path.join(dir, name);
  return statSync(file).isDirectory() ? walk(file) : [file];
});
const rollouts = new Map();
for (const file of walk(runs).filter((file) => /\/rollout-[^/]+\.jsonl$/.test(file))) rollouts.set(path.basename(file), file);
const totals = { rollouts: 0, McpToolCall: 0, CommandExecution: 0, custom_tool_call: 0, relayInvocations: 0 };
for (const file of [...rollouts.values()].sort()) {
  totals.rollouts += 1;
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const { payload } = JSON.parse(line);
    const item = payload?.item;
    let invocation = null;
    if (item?.type === "McpToolCall" || item?.type === "CommandExecution") invocation = item;
    else if (payload?.type === "custom_tool_call") invocation = payload;
    if (!invocation) continue;
    totals[invocation.type] += 1;
    const text = invocation.type === "McpToolCall" ? `${invocation.tool} ${JSON.stringify(invocation.arguments)}`
      : invocation.type === "CommandExecution" ? JSON.stringify(invocation.command) : invocation.input;
    if (RELAY.test(text)) { totals.relayInvocations += 1; console.log("RELAY", path.relative(runs, file), text.slice(0, 200)); }
  }
}
const ledgers = readdirSync(parent).filter((name) => name.startsWith("amt-m15-cert-R"))
  .flatMap((name) => { try { return walk(path.join(parent, name)); } catch { return []; } })
  .filter((file) => file.endsWith("/operator-decisions.ndjson"));
console.log(JSON.stringify({ ...totals, operatorLedgers: ledgers.length, ledgers }, null, 2));
