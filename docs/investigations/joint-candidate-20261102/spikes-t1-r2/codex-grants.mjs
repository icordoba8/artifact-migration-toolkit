// Non-scored: Codex's effective start-migration grants under the harness argv.
// The engine server is launched unfiltered (10 tools, relay included); Codex talks
// to a local capture endpoint instead of a model, which asks Codex's exec runtime
// for ALL_TOOLS (its enabled nested tools). CODEX_HOME is an empty temp dir:
// no auth.json, no user config. Control run: the same argv minus enabled_tools.
// Usage: node <this file> <harness worktree>   (e.g. ~/amt-infra-harness)
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const { commandFor } = await import(path.resolve(process.argv[2], "scripts/agent-e2e-acceptance.mjs"));
const server = path.join(repo, "packages/migration-engine/src/mcp-server.mjs");

const listed = JSON.parse(spawnSync(process.execPath, [server], { input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n', encoding: "utf8" }).stdout)
  .result.tools.map((tool) => tool.name);
console.log(`server tools/list: ${listed.length} ${JSON.stringify(listed)}`);

// Runs in Codex's exec isolate: ALL_TOOLS is "metadata for the enabled nested tools".
const PROBE = 'text(JSON.stringify({ enabled: ALL_TOOLS.map((t) => t.name).filter((n) => /start.migration/.test(n)), ' +
  'relayCallable: typeof tools.mcp__start_migration__migration_relay_decision }));';
const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const grantsSeen = async (dropEnabledTools) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-grants-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-home-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  const bodies = [];
  const capture = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (!request.url.endsWith("/responses")) return response.writeHead(404).end();
      bodies.push(body);
      // Turn 1: the "model" asks Codex's code-mode runtime which nested tools it enabled. Turn 2: done.
      const item = bodies.length === 1
        ? { type: "custom_tool_call", id: "ct", call_id: "probe", name: "exec", input: PROBE }
        : { type: "message", role: "assistant", id: "m", content: [{ type: "output_text", text: "ok" }] };
      response.writeHead(200, { "content-type": "text/event-stream" }).end(sse([
        { type: "response.created", response: { id: `r${bodies.length}` } },
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { id: `r${bodies.length}`, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
      ]));
    });
  });
  await new Promise((resolve) => capture.listen(0, "127.0.0.1", resolve));
  try {
    let { argv } = commandFor("codex", "/start-migration auth", root);
    if (dropEnabledTools) argv = argv.filter((arg, i) => !arg.includes(".enabled_tools=") && !argv[i + 1]?.includes(".enabled_tools="));
    argv = [...argv.slice(0, -1), "--skip-git-repo-check", "--ephemeral",
      "-c", `mcp_servers.start-migration.command=${JSON.stringify(process.execPath)}`,
      "-c", `mcp_servers.start-migration.args=${JSON.stringify([server])}`,
      "-c", 'model_provider="capture"',
      "-c", `model_providers.capture={ name = "capture", base_url = "http://127.0.0.1:${capture.address().port}/v1", wire_api = "responses" }`,
      argv.at(-1)];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENAI|CODEX)_/.test(key)));
    const child = spawn("codex", argv, { cwd: root, env: { ...env, CODEX_HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise((resolve) => child.on("exit", resolve));
    const output = bodies[1] && JSON.parse(bodies[1]).input.find((entry) => entry.call_id === "probe" && entry.type.endsWith("_output"));
    if (!output) throw new Error(`codex exited ${code} without returning the probe: ${stderr.slice(-2000)}`);
    const enabled = JSON.parse(output.output.map((part) => part.text).find((text) => text.startsWith('{"enabled"')));
    return { ...enabled, grants: listed.filter((tool) => enabled.enabled.some((name) => name.endsWith(`__${tool}`))) };
  } finally {
    capture.close();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
};

const version = spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout.trim();
const harness = await grantsSeen(false);
const control = await grantsSeen(true);
console.log(`${version}; harness ${spawnSync("git", ["-C", process.argv[2], "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()}; engine ${spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()}`);
for (const [label, run] of [["harness argv (enabled_tools)", harness], ["control (no enabled_tools)", control]])
  console.log(`${label}: ${run.grants.length} grants, relay callable: ${run.relayCallable}, enabled: ${JSON.stringify(run.enabled)}`);
const ok = harness.grants.length === 9 && harness.relayCallable === "undefined" && control.grants.length === 10 && control.relayCallable === "function";
console.log(ok ? "EFFECTIVE_GRANTS=9" : `EFFECTIVE_GRANTS=${harness.grants.length} (STOP)`);
