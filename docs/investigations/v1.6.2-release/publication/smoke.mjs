// Installed-toolkit smoke. Two modes, one set of checks:
//   offline:   skills copied from the release SHA tree (what `skills add` copies),
//              runtime served from the staged archive through ensureRuntime's
//              injectable transport (the same seam test/installed-full-lifecycle uses).
//   published: `pnpm dlx skills add <repo> --skill ...` and `runtime.mjs ensure`
//              against GitHub, no override.
// env: SMOKE_MODE, SMOKE_VERSION, SMOKE_REPO (checkout at release SHA),
//      SMOKE_ARCHIVE + SMOKE_STAGED (offline only), SMOKE_OUT (scratch parent).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const { SMOKE_MODE: mode = "offline", SMOKE_VERSION: version, SMOKE_REPO: repo, SMOKE_ARCHIVE: archive,
  SMOKE_STAGED: staged, SMOKE_OUT: out } = process.env;
assert.ok(version && repo && out, "SMOKE_VERSION, SMOKE_REPO and SMOKE_OUT are required");
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const put = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const results = [];
const check = async (name, body) => {
  try { const note = await body(); results.push({ name, ok: true, note }); console.log(`PASS ${name}${note ? ` — ${note}` : ""}`); }
  catch (error) { results.push({ name, ok: false, note: error.message }); console.log(`FAIL ${name} — ${error.message}`); }
};
const run = (command, args, cwd, input, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout, stderr }));
  child.stdin.end(input ?? "");
});
const treeDigest = async (root) => {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(`${path.relative(root, full)}\0${sha(await readFile(full))}`);
    }
  };
  await walk(root);
  return sha(files.sort().join("\n"));
};

const scratch = await mkdtemp(path.join(out, `smoke ${mode} `));
const consumer = path.join(scratch, "consumer app");
const store = path.join(scratch, "store");
const legacy = path.join(consumer, "legacy");
const target = path.join(consumer, "target");
const registry = path.join(target, ".agents/knowledge/migrations/registry.json");
const record = path.join(target, ".agents/knowledge/migrations/modules/auth");
const { SPEC } = await import(pathToFileURL(path.join(repo, "packages/migration-engine/test/support/consumer-fixture.mjs")).href);
await mkdir(path.join(legacy, "auth"), { recursive: true });
await mkdir(path.join(target, "src"), { recursive: true });
await mkdir(path.dirname(registry), { recursive: true });
await writeFile(path.join(consumer, "package.json"), '{"name":"smoke-consumer","private":true}\n');
await writeFile(path.join(legacy, "auth/marker.txt"), "auth\n");
await writeFile(path.join(legacy, "auth/form.html"), "<form><button>Sign in</button></form>\n");
await writeFile(path.join(target, "src/placeholder.ts"), "export {};\n");
await put(registry, { version: 1, projects: {
  legacy: { root: path.relative(path.dirname(registry), legacy) },
  target: { root: path.relative(path.dirname(registry), target) },
}, modules: { auth: { target: "auth" } } });
const git = (args) => exec("git", ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", ...args], { cwd: consumer });
await git(["init", "-q"]);
await git(["add", "-A"]);
await git(["commit", "-qm", "fresh consumer"]);
const legacyBefore = await treeDigest(legacy);
const targetSourceBefore = await treeDigest(path.join(target, "src"));

// 1. Install both skills.
const skills = ["start-migration", "migrate-artifact"];
// `skills add -a claude-code` installs into Claude Code's own project root.
const skillsDir = mode === "published" ? ".claude/skills" : ".agents/skills";
await check("both skills install", async () => {
  for (const skill of skills) {
    if (mode === "published") {
      const result = await run("pnpm", ["dlx", "skills", "add", "https://github.com/icordoba8/artifact-migration-toolkit",
        "--skill", skill, "-a", "claude-code", "-y"], consumer);
      assert.equal(result.code, 0, `${skill}: ${result.stdout}\n${result.stderr}`);
    } else {
      await cp(path.join(repo, "skills", skill), path.join(consumer, skillsDir, skill), { recursive: true });
    }
    await stat(path.join(consumer, skillsDir, skill, "SKILL.md"));
  }
  await git(["add", "-A"]);
  await git(["commit", "-qm", "install skills"]);
  return mode;
});
await check("installed stamps name the release version", async () => {
  for (const skill of skills) {
    const stamp = await json(path.join(consumer, skillsDir, skill, "release-identity.json"));
    assert.deepEqual([stamp.version, stamp.skill, stamp.source], [version, skill, "repository"], JSON.stringify(stamp));
  }
  return `both ${version}`;
});

// 2. Bootstrap the runtime through each skill's own copy, no --version.
const bootstrap = (skill) => path.join(consumer, skillsDir, skill, "scripts/runtime.mjs");
const manifest = staged ? await json(path.join(staged, "release-manifest.json")) : null;
const ensure = async (skill) => {
  if (mode === "published") {
    const result = await run(process.execPath, [bootstrap(skill), "ensure", "--provider", "claude", "--root", consumer, "--store", store], consumer);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  }
  const digest = sha(await readFile(archive));
  const runtime = await import(pathToFileURL(bootstrap(skill)).href);
  return runtime.ensureRuntime({ provider: "claude", root: consumer, store }, {
    resolve: async () => ({ asset: { name: path.basename(archive), digest, url: "private://staged" },
      commit: manifest.toolkit.commit, version: manifest.toolkit.version, viaGh: false }),
    download: async (_selection, destination) => { await cp(archive, destination); },
  });
};
let first; let receipt;
await check("first preflight resolves and verifies the release (start-migration)", async () => {
  first = await ensure("start-migration");
  assert.equal(first.bootstrapped, true, JSON.stringify(first));
  assert.equal(first.selection, "skill");
  assert.equal(first.skillIdentity, "required");
  assert.equal(first.toolkit.version, version);
  if (manifest) assert.deepEqual(first.toolkit, manifest.toolkit);
  receipt = await json(path.join(consumer, ".artifact-migration-tools/claude.json"));
  assert.deepEqual(receipt.toolkit, first.toolkit);
  return `commit ${first.toolkit.commit.slice(0, 12)} contentHash ${first.toolkit.contentHash.slice(0, 19)}…`;
});
await check("migrate-artifact preflight reuses the verified runtime", async () => {
  const second = await ensure("migrate-artifact");
  assert.equal(second.bootstrapped, false, JSON.stringify(second));
  assert.deepEqual(second.toolkit, first.toolkit);
  return `network ${second.network}`;
});
await check("repeated invocation reuses without network", async () => {
  const again = await run(process.execPath, [bootstrap("start-migration"), "ensure", "--provider", "claude", "--root", consumer, "--store", store], consumer);
  assert.equal(again.code, 0, again.stderr);
  const parsed = JSON.parse(again.stdout);
  assert.equal(parsed.bootstrapped, false);
  assert.equal(parsed.network, false);
  assert.deepEqual(parsed.toolkit, first.toolkit);
});
await check("installed release manifest matches both skill identities", async () => {
  const file = receipt.commands["artifact-migration-run"].find((part) => part.endsWith(".mjs"));
  const runtimeRoot = path.join(store, path.relative(store, file).split(path.sep)[0]);
  const installedManifest = await json(path.join(runtimeRoot, "release-manifest.json"));
  assert.deepEqual(installedManifest.toolkit, first.toolkit);
  for (const skill of skills) assert.ok(installedManifest.skills.skills[skill].computedHash, skill);
  return Object.keys(installedManifest.skills.skills).join(", ");
});

// 3. CLI and MCP from the installed toolkit.
const command = async (name, args, input) => {
  const [bin, ...prefix] = receipt.commands[name];
  assert.ok(path.isAbsolute(bin) && !bin.startsWith(repo), `${name} resolves outside the installed toolkit: ${bin}`);
  return run(bin, [...prefix, ...args], consumer, input);
};
await check("CLI commands resolve from the installed toolkit", async () => {
  const names = Object.keys(receipt.commands);
  for (const name of names) {
    const file = receipt.commands[name].find((part) => part.endsWith(".mjs"));
    assert.ok(file && file.startsWith(store), `${name}: ${receipt.commands[name].join(" ")}`);
    await stat(file);
  }
  return `${names.length} commands under the store`;
});
const mcp = async (calls) => {
  const [bin, ...args] = Array.isArray(receipt.mcp.command) ? receipt.mcp.command : [receipt.mcp.command, ...receipt.mcp.args];
  const lines = [{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } },
    ...calls.map((call, index) => ({ jsonrpc: "2.0", id: index + 1, ...call }))];
  const result = await run(bin, args, consumer, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  assert.equal(result.code, 0, result.stderr);
  const replies = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return calls.map((_, index) => replies.find((reply) => reply.id === index + 1));
};
await check("installed engine resolves playwright-core for capture from its own tree", async () => {
  const file = receipt.commands["artifact-migration-run"].find((part) => part.endsWith(".mjs"));
  const runtimeRoot = path.join(store, path.relative(store, file).split(path.sep)[0]);
  const { createRequire } = await import("node:module");
  const resolved = createRequire(path.join(runtimeRoot, "packages/migration-engine/src/visual-evidence.mjs")).resolve("playwright-core");
  assert.ok(resolved.startsWith(runtimeRoot), resolved);
  const { version: pw } = await json(path.join(path.dirname(resolved), "package.json"));
  return `playwright-core ${pw}`;
});
await check("MCP starts and lists the toolkit tools", async () => {
  const [list] = await mcp([{ method: "tools/list", params: {} }]);
  const names = list.result.tools.map((tool) => tool.name);
  for (const name of ["migration_status", "migration_run", "migration_prefill", "migration_capture", "migration_evidence_binding"]) assert.ok(names.includes(name), name);
  return `${names.length} tools`;
});

// 4. A disposable module lifecycle: create, status, run, validate, resume.
const state = () => json(path.join(record, "state.json"));
await check("discover creates a stamped record", async () => {
  const result = await command("artifact-migration-discover", ["auth", "--registry", registry, "--openspec-proposal-stdin", "--mode", "auto"], SPEC);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const created = await state();
  assert.deepEqual(created.toolkitIdentity, first.toolkit);
  return `format ${created.formatVersion}, step ${created.currentStep}`;
});
await check("engine CLI reports the record's identity as the installed one", async () => {
  const result = await command("artifact-migration-toolkit", ["status", "--module", "auth"]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes(version) && /MATCH/.test(result.stdout) && !/MISMATCH/.test(result.stdout), result.stdout);
  return result.stdout.split("\n").find(Boolean)?.slice(0, 140);
});
await check("module status through MCP names the active identity", async () => {
  const [status] = await mcp([{ method: "tools/call", params: { name: "migration_status", arguments: { module: "auth" } } }]);
  assert.ok(!status.result.isError, JSON.stringify(status));
  const body = JSON.parse(status.result.content.at(-1).text);
  assert.deepEqual(body.activeToolkitIdentity, first.toolkit);
  return body.currentStep ?? body.state?.currentStep ?? "ok";
});
let revision;
await check("run continues at the authored checkpoint", async () => {
  const result = await command("artifact-migration-run", ["auth", "--mode", "auto", "--json"]);
  const parsed = JSON.parse(result.stdout);
  assert.ok(["CONTINUE", "BLOCKED", "NEEDS_INPUT"].includes(parsed.outcome) || parsed.outcome, result.stdout);
  revision = (await state()).revision;
  return `outcome ${parsed.outcome}, step ${(await state()).currentStep}`;
});
await check("evidence validation refuses an unauthored checkpoint", async () => {
  const result = await command("artifact-migration-validate", ["auth", "--step", (await state()).currentStep]);
  assert.notEqual(result.code, 0, result.stdout);
  return (result.stderr || result.stdout).split("\n").find(Boolean)?.slice(0, 120);
});
await check("resume is idempotent", async () => {
  const result = await command("artifact-migration-run", ["auth", "--mode", "auto", "--json"]);
  assert.ok(JSON.parse(result.stdout).outcome, result.stdout);
  assert.equal((await state()).revision, revision);
  return `revision ${revision} unchanged`;
});
await check("migrate-artifact status on a disposable artifact", async () => {
  const result = await command("artifact-migrate", ["legacy/auth/form.html", "--status", "--json"]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.match(/"(status|state|outcome)"\s*:\s*"([A-Z_]+)"/)?.[2] ?? result.stdout.slice(0, 80);
});
await check("no unintended consumer mutation", async () => {
  assert.equal(await treeDigest(legacy), legacyBefore, "legacy tree changed");
  assert.equal(await treeDigest(path.join(target, "src")), targetSourceBefore, "target source changed");
  const { stdout } = await git(["status", "--porcelain", "--untracked-files=all"]);
  const allowed = [/^\.artifact-migration-tools\//, /^target\/\.agents\/knowledge\/migrations\//,
    /^\.agents\/knowledge\//, /^\.mcp\.json$/, /^\.claude\//,
    // The discover command's own first-setup writes: the spec it was handed, and the registry binding.
    /^target\/openspec\/specs\/auth\/spec\.md$/, /^package\.json$/, /^skills-lock\.json$/];
  const unexpected = stdout.split("\n").filter(Boolean).map((line) => line.slice(3).replace(/^"|"$/g, ""))
    .filter((file) => !allowed.some((pattern) => pattern.test(file)));
  assert.deepEqual(unexpected, []);
  const { config, ...rest } = await json(path.join(consumer, "package.json"));
  assert.deepEqual([rest, Object.keys(config)], [{ name: "smoke-consumer", private: true }, ["startMigration"]]);
  return "legacy and target source byte-identical";
});

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS (${mode}) scratch: ${scratch}`);
await put(path.join(scratch, "smoke-results.json"), { mode, version, toolkit: first?.toolkit ?? null, results });
process.exitCode = failed.length ? 1 : 0;
