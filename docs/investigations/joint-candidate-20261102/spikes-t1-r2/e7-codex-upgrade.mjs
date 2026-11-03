// Non-scored (E7): real Codex project installs. Fresh install of the candidate,
// and an install of the published v1.6.4 by its own installer followed by
// `update` with the candidate's installer. Prints the owned .codex/config.toml
// block and the grants: the registered server's tools/list, narrowed by its
// enabled_tools when present (Codex's own narrowing is proven by codex-grants.mjs).
// Usage: node <this file> <v1.6.4 extracted bundle dir> <candidate dist bundle dir>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const [oldBundle, newBundle] = process.argv.slice(2).map((dir) => path.resolve(dir));
const pinOf = async (bundle) => `sha256:${createHash("sha256").update(await readFile(path.join(bundle, "release-manifest.json"))).digest("hex")}`;
const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "e7-codex-upgrade-")));
const install = (bundle, action, root, store, pin) => {
  const result = spawnSync(process.execPath, [path.join(bundle, "providers/codex/install.mjs"), action,
    "--scope", "project", "--root", root, "--store", store, "--bundle", bundle, "--pin", pin], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${action} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
};
const grants = async (label, root, receipt) => {
  const toml = await readFile(path.join(root, ".codex/config.toml"), "utf8");
  const listed = JSON.parse(spawnSync(receipt.mcp.command, receipt.mcp.args, { input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n', encoding: "utf8" }).stdout)
    .result.tools.map((tool) => tool.name);
  const granted = receipt.mcp.enabled_tools ? listed.filter((tool) => receipt.mcp.enabled_tools.includes(tool)) : listed;
  console.log(`${label}: toolkit ${receipt.toolkit.version}; config block:\n${toml.match(/\[mcp_servers\.start-migration\][\s\S]*?(?=# END)/)[0].replaceAll(scratch, "<tmp>")}` +
    `  tools/list ${listed.length}; granted ${granted.length}; relay granted: ${granted.includes("migration_relay_decision")}`);
  return granted.length;
};
try {
  const [oldPin, newPin] = [await pinOf(oldBundle), await pinOf(newBundle)];
  const fresh = path.join(scratch, "fresh");
  const upgraded = path.join(scratch, "upgraded");
  await Promise.all([fresh, upgraded].map((dir) => mkdir(dir)));
  const counts = [
    await grants("fresh install (candidate)", fresh, install(newBundle, "install", fresh, path.join(scratch, "store-fresh"), newPin)),
    await grants("before upgrade (v1.6.4 installer)", upgraded, install(oldBundle, "install", upgraded, path.join(scratch, "store-up"), oldPin)),
    await grants("after update (candidate installer)", upgraded, install(newBundle, "update", upgraded, path.join(scratch, "store-up"), newPin)),
  ];
  console.log(counts.join(" / ") === "9 / 10 / 9" ? "E7_INSTALLED_GRANTS fresh=9 upgrade=10->9" : `E7_INSTALLED_GRANTS ${counts.join(" / ")} (STOP)`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
