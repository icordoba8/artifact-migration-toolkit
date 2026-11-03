// Logs each JSON-RPC method the client sends, then proxies to the real engine MCP server.
import { spawn } from "node:child_process"; import { appendFileSync } from "node:fs";
const log = (s) => appendFileSync("$S/t1/tap.log", new Date().toISOString() + " " + s + "\n");
log("spawned argv=" + JSON.stringify(process.argv.slice(2)) + " pm_on_fail=" + process.env.pnpm_config_pm_on_fail);
const child = spawn(process.execPath, ["~/amt-joint-candidate/packages/migration-engine/src/mcp-server.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = ""; process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { log("client " + JSON.parse(line).method); } catch {} } child.stdin.write(d); });
let out = ""; child.stdout.on("data", (d) => { out += d; let i; while ((i = out.indexOf("\n")) >= 0) { const line = out.slice(0, i); out = out.slice(i + 1); try { const m = JSON.parse(line); if (m.result?.tools) log("server tools/list -> " + m.result.tools.length + " tools: " + m.result.tools.map(t => t.name).join(",")); } catch {} } process.stdout.write(d); });
child.on("exit", (c) => process.exit(c ?? 0)); process.stdin.on("end", () => child.stdin.end());
