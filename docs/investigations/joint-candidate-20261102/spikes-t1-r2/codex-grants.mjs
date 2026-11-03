// Non-scored: Codex's effective start-migration grants. Each run writes a project
// .codex/config.toml (trusted by the harness argv) and Codex talks to a local
// capture endpoint instead of a model, which asks Codex's exec runtime for
// ALL_TOOLS (its enabled nested tools). CODEX_HOME is an empty temp dir: no
// auth.json, no user config. Runs (E7):
//   harness   unfiltered 1.6.4-shaped config + the harness argv (its -c enabled_tools)
//   shipped   the shipped providers/codex/config.toml, no command-line filter
//   filter    the shipped enabled_tools alone, against the unfiltered server
//   control   unfiltered 1.6.4-shaped config, no filter anywhere
// Usage: node <this file> <harness worktree>   (e.g. ~/amt-infra-harness)
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
// The shipped template, rendered as the installer renders it: absolute node and engine entry.
const shipped = (await readFile(path.join(repo, "providers/codex/config.toml"), "utf8"))
  .replace('command = "node"', `command = ${JSON.stringify(process.execPath)}`).replace("{{ENGINE_MCP_ENTRY}}", server);
const unfiltered = `[mcp_servers.start-migration]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([server])}\n`;
const filterOnly = shipped.replace(',"--without-relay"', "");
if (!shipped.includes('"--without-relay"]\nenabled_tools = [') || filterOnly === shipped) throw new Error("shipped config.toml is not the E7 shape");
const grantsSeen = async (config, dropEnabledTools) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codex-grants-")));
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-home-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  await mkdir(path.join(root, ".codex"));
  await writeFile(path.join(root, ".codex/config.toml"), config);
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
    if (enabled.enabled.length === 0) throw new Error(`codex enabled no start-migration tool: ${stderr.slice(-2000)}`);
    return { ...enabled, grants: listed.filter((tool) => enabled.enabled.some((name) => name.endsWith(`__${tool}`))) };
  } finally {
    capture.close();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
};

const version = spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout.trim();
const runs = [
  ["harness argv (enabled_tools) on unfiltered config", await grantsSeen(unfiltered, false), 9],
  ["shipped config.toml, no command-line filter", await grantsSeen(shipped, true), 9],
  ["shipped enabled_tools only, unfiltered server", await grantsSeen(filterOnly, true), 9],
  ["control (no filter)", await grantsSeen(unfiltered, true), 10],
];
const head = (dir) => spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
console.log(`${version}; harness ${head(process.argv[2])}; engine ${head(repo)} (worktree ${spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim() ? "dirty" : "clean"})`);
for (const [label, run] of runs) console.log(`${label}: ${run.grants.length} grants, relay callable: ${run.relayCallable}, enabled: ${JSON.stringify(run.enabled)}`);
const ok = runs.every(([, run, want]) => run.grants.length === want && run.relayCallable === (want === 9 ? "undefined" : "function"));
console.log(ok ? "EFFECTIVE_GRANTS=9 (shipped); control=10" : `EFFECTIVE_GRANTS=${runs.map(([, run]) => run.grants.length).join("/")} (STOP)`);
