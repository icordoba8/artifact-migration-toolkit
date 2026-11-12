// T1 conditions 1–3 against the real Copilot CLI: a default install and a
// <=1.6.5-receipt upgrade each register exactly the nine relay-less tools, and a
// root `.mcp.json` shadow is refused by name. `copilot mcp list --json` runs with
// an isolated COPILOT_HOME whose `trustedFolders` names the consumer (the
// documented user step); no model turn is taken.
// Usage (from the repository root): node <this file> <scratch dir>
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { adapter, digest } from "../../../../providers/install-support.mjs";
import { buildRelease } from "../../../../scripts/release.mjs";
import { candidateReleaseRoot } from "../../../../packages/migration-engine/test/support/candidate-release-root.mjs";

const scratch = path.resolve(process.argv[2]);
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });
const shown = (text) => text.replaceAll(scratch, "$S");
const built = await buildRelease({ root: await candidateReleaseRoot(scratch, { version: "1.3.1" }), force: true });
const bundle = path.join(scratch, "release");
await cp(built.stagingRoot, bundle, { recursive: true });
const pin = digest(await readFile(path.join(bundle, "release-manifest.json")));
const root = path.join(scratch, "consumer");
const home = path.join(scratch, "copilot-home");
await mkdir(root, { recursive: true });
await mkdir(home, { recursive: true });
await writeFile(path.join(home, "config.json"), JSON.stringify({ trustedFolders: [root] }));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VSCODE_|TERM_PROGRAM|GITHUB_TOKEN|GH_TOKEN|COPILOT_)/.test(key)));
const list = (label) => {
  const out = JSON.parse(execFileSync("copilot", ["mcp", "list", "--json"], { cwd: root, env: { ...env, COPILOT_HOME: home }, encoding: "utf8" }));
  console.log(`## ${label}\n${shown(JSON.stringify(out))}`);
};
const toolsList = (server) => JSON.parse(spawnSync(server.command, server.args, { input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`, encoding: "utf8" }).stdout).result.tools.map((tool) => tool.name);
const options = { scope: "project", root, store: path.join(scratch, "store"), bundle, pin };

console.log(`copilot --version: ${execFileSync("copilot", ["--version"], { encoding: "utf8" }).trim()}`);
const installed = await adapter("copilot", options);
const registered = () => readFile(path.join(root, ".github/mcp.json"), "utf8").then((text) => JSON.parse(text).mcpServers["start-migration"]);
list("default install (no flags)");
console.log(`server tools/list: ${toolsList(await registered()).join(",")}`);

// A <=1.6.5 receipt: relay-carrying `.vscode` entry, no `.github` registration.
const receiptFile = path.join(root, ".artifact-migration-tools/copilot.json");
const legacy = { ...installed, mcp: { ...installed.mcp, args: installed.mcp.args.slice(0, 1) } };
legacy.configOwned = legacy.mcp;
delete legacy.cliConfigOwned;
await writeFile(receiptFile, JSON.stringify(legacy, null, 2));
await writeFile(path.join(root, ".vscode/mcp.json"), JSON.stringify({ servers: { "start-migration": legacy.mcp } }));
await rm(path.join(root, ".github/mcp.json"));
list("legacy receipt before upgrade");
await adapter("copilot", { ...options, action: "update" });
list("after update (no flags)");
console.log(`server tools/list (${toolsList(await registered()).length})`);

await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { "start-migration": { command: "node", args: ["x"] } } }));
list("shadow .mcp.json present");
for (const action of ["doctor", "update"]) {
  const error = await adapter("copilot", { ...options, action }).then(() => null, (e) => e);
  console.log(`${action} with shadow: ${error?.code} file=${error?.state?.file}`);
}
