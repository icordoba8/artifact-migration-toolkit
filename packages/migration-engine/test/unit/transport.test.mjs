// Track A7: the transport/ boundary and the installed entry paths
// (docs/architecture/a7-ownership.md). The command and protocol behavior is
// covered where it always was: run-migration, mcp-server, record-decision,
// migration-policy, toolkit-identity, bin-mappings, engine-paths and the
// provider suites. This file pins the module boundary, the facades and the
// install layout A7 relies on.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import * as transport from "../../src/transport/index.mjs";

const src = fileURLToPath(new URL("../../src/", import.meta.url));
const enginePackage = path.resolve(src, "..");
const repo = path.resolve(enginePackage, "../..");
const ts = createRequire(import.meta.url)("ts-discovery-compiler");
const execFileAsync = promisify(execFile);

const engineFiles = async () =>
  (await readdir(src, { recursive: true })).filter((file) => file.endsWith(".mjs")).map((file) => file.split(path.sep).join("/"));
const parse = async (file, root = src) =>
  ts.createSourceFile(file, await readFile(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declared = (sf) => sf.statements.flatMap((statement) =>
  ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ? [statement.name.text]
    : ts.isVariableStatement(statement) ? statement.declarationList.declarations.map((d) => d.name.getText(sf)) : []);
/** Every relative target a file names, `src/`-relative: static, re-export and dynamic. */
const targets = (file, sf, { dynamic = true } = {}) => {
  const found = [];
  const visit = (node) => {
    let spec;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) spec = node.moduleSpecifier.text;
    else if (dynamic && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      spec = ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : "<dynamic>";
    }
    if (spec === "<dynamic>") found.push(spec);
    else if (spec?.startsWith(".")) found.push(path.posix.join(path.posix.dirname(file), spec));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};
const load = (file) => import(pathToFileURL(path.join(src, file)).href);

/**
 * The installed and historical entry paths. Each is a facade: it declares
 * nothing, re-exports its BASE names as the canonical bindings, and starts its
 * command only when it is the process entry. `bin` is the package bin name,
 * `from` the canonical owners of its bindings, `impl` the files it names.
 */
const FACADES = {
  "cli/discover-module.mjs": { bin: "artifact-migration-discover", from: ["transport/index.mjs"], impl: ["transport/discover.mjs"] },
  "cli/run-migration.mjs": { bin: "artifact-migration-run", from: ["transport/index.mjs"], impl: ["transport/run.mjs"] },
  "cli/advance-migration.mjs": { bin: "artifact-migration-advance", from: ["transport/index.mjs"], impl: ["transport/advance.mjs"] },
  "cli/validate-migration.mjs": { bin: "artifact-migration-validate", from: ["transport/index.mjs"], impl: ["transport/validate.mjs"] },
  "cli/update-migration-registry.mjs": { bin: "artifact-migration-registry", from: ["transport/index.mjs"], impl: ["transport/registry.mjs"] },
  "record-decision.mjs": { bin: "artifact-migration-decision", from: ["decision-recorder.mjs"], impl: ["decision-recorder.mjs"] },
  "upgrades/upgrade-migration.mjs": { bin: "artifact-migration-upgrade", from: ["upgrades/upgrade-coordinator.mjs", "transport/index.mjs"], impl: ["upgrades/upgrade-coordinator.mjs", "transport/upgrade.mjs"] },
  "artifact/run-artifact.mjs": { bin: "artifact-migrate", from: ["transport/index.mjs"], impl: ["transport/artifact.mjs"] },
  "mcp-server.mjs": { bin: "artifact-migration-mcp", from: ["transport/index.mjs"], impl: ["transport/mcp.mjs"] },
  "cli/toolkit-identity.mjs": { bin: "artifact-migration-toolkit", from: ["transport/index.mjs"], impl: ["transport/toolkit-identity.mjs"] },
  // The signer service is started by the OS service manager, not a package bin.
  "operator-signer-service.mjs": { from: ["operator-signer-host.mjs"], impl: ["operator-signer-host.mjs"] },
  // Not executable: the policy's historical import path.
  "migration-policy.mjs": { from: ["lifecycle-policy.mjs", "transport/index.mjs"], impl: ["lifecycle-policy.mjs", "transport/index.mjs"] },
};
/** The package API aggregator. Like the facades it sits above transport, so nothing in src/ imports it. */
const TOP = new Set([...Object.keys(FACADES), "core.mjs"]);

// Each facade's BASE (f342b6f) export names, with function arities (null = value).
const BASE_EXPORTS = {
  "cli/discover-module.mjs": { normalizePonytailArgument: 1, parseDiscoverArguments: 1, renderExecutionPreview: 1, runDiscoverCli: 1 },
  "cli/advance-migration.mjs": { parseAdvanceArguments: 1, runAdvanceCli: 1 },
  "cli/run-migration.mjs": { decisionCandidates: 1, parseRunArguments: 1, renderAuthoringRequest: 2, runMigration: 1 },
  "cli/validate-migration.mjs": { parseValidateArguments: 1, runValidateCli: 1 },
  "cli/update-migration-registry.mjs": { parseRegistryArguments: 1, runRegistryCli: 1 },
  "cli/toolkit-identity.mjs": { parseToolkitIdentityArguments: 1, runToolkitIdentityCli: 1 },
  "artifact/run-artifact.mjs": { artifactDirective: 3, parseArtifactArguments: 1, runArtifactCli: 0 },
  "mcp-server.mjs": { approvalShapedArgument: 1, createSession: 0, handleMessage: 1, serve: 0 },
  "record-decision.mjs": { APPROVAL_CHANNELS: null, APPROVAL_EVIDENCE_PHRASES: null, DECISION_KINDS: null, SIGNER_UNAVAILABLE: null, approvedByPhrase: 1, assertReviewedCandidateCurrent: 2, auditDecisionLedger: 1, autoApprovalChannel: 1, autoMayDecide: 1, beginAttestedDecision: 1, buildDecision: 1, challengeFor: 1, channelOf: 1, completeAttestedDecision: 1, groupFactsDigest: 1, ledgerFileForChannel: 1, parseDecisionArguments: 1, pendingDecisionCandidates: 1, projectDecisions: 1, rationaleDigestOf: 1, recordNewFormatDecisionGroup: 1, relayOperatorDecision: 1, renderDecisionReview: 1, reviewAttestedCandidate: 1, reviewFor: 1, reviewReference: 1, runRecordDecisionCli: 1 },
  "upgrades/upgrade-migration.mjs": { TRANSACTION_STATES: null, executeRollback: 1, executeUpgrade: 1, parseUpgradeArguments: 1, pendingTransactions: 2, previewRollback: 0, previewUpgrade: 0, recoverTransaction: 1, recoverUpgrade: 0, renderRollbackPreview: 1, renderUpgradePreview: 1, runUpgradeCli: 1 },
  "operator-signer-service.mjs": { SERVICE_CONFIG_FILE: null, runSignerService: 1 },
  "migration-policy.mjs": { MIGRATION_MODES: null, MIGRATION_OUTCOMES: null, assertOptionCombination: 1, exitCodeFor: 1, isAutoAuthority: 1, maySelfConfirm: 0, nextOutcome: 0 },
};

// -- architecture --------------------------------------------------------------

test("A7-ARCH-1: transport/ has exactly one public entry, and it only re-exports its own files", async () => {
  const entries = (await engineFiles()).filter((file) => file.startsWith("transport/") && file.endsWith("/index.mjs"));
  assert.deepEqual(entries, ["transport/index.mjs"]);
  for (const statement of (await parse("transport/index.mjs")).statements) {
    assert.ok(ts.isExportDeclaration(statement) && statement.moduleSpecifier, "transport/index.mjs only re-exports");
    assert.match(statement.moduleSpecifier.text, /^\.\/[\w-]+\.mjs$/);
  }
});

test("A7-ARCH-2: engine code reaches transport/ only through its entry; only the facades take a specific file", async () => {
  const offenders = [];
  for (const file of (await engineFiles()).filter((file) => !file.startsWith("transport/"))) {
    for (const target of targets(file, await parse(file))) {
      if (!target.startsWith("transport/")) continue;
      if (TOP.has(file) && (target === "transport/index.mjs" || Object.hasOwn(FACADES, file))) continue;
      offenders.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(offenders, []);
  // A facade names only its own implementation, the shared startup and, for
  // the two failure handlers that render one, the exit-code table.
  for (const [facade, { impl }] of Object.entries(FACADES)) {
    const allowed = new Set([...impl, "transport/entry.mjs", "lifecycle-policy.mjs"]);
    assert.deepEqual(targets(facade, await parse(facade)).filter((target) => !allowed.has(target)), [], facade);
  }
});

test("A7-ARCH-3: nothing below transport/ imports it, transport/ imports no facade, and no new import cycle exists", async () => {
  const files = await engineFiles();
  const edges = new Map();
  for (const file of files) {
    const sf = await parse(file);
    const all = targets(file, sf);
    assert.ok(!all.includes("<dynamic>"), `${file} has a non-literal import`);
    // Below transport: neither the module nor anything above it (facades, the package aggregator).
    if (!file.startsWith("transport/") && !TOP.has(file)) {
      assert.deepEqual(all.filter((target) => target.startsWith("transport/") || TOP.has(target)), [], file);
    }
    if (file.startsWith("transport/")) assert.deepEqual(all.filter((target) => TOP.has(target)), [], file);
    edges.set(file, { all, static: targets(file, sf, { dynamic: false }) });
  }
  // Tarjan over a chosen edge set: the non-trivial strongly connected components.
  const components = (kind) => {
    let index = 0;
    const order = new Map(), low = new Map(), stack = [], open = new Set(), found = [];
    const visit = (v) => {
      order.set(v, index); low.set(v, index++); stack.push(v); open.add(v);
      for (const w of edges.get(v)[kind].filter((target) => edges.has(target))) {
        if (!order.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
        else if (open.has(w)) low.set(v, Math.min(low.get(v), order.get(w)));
      }
      if (low.get(v) !== order.get(v)) return;
      const component = [];
      let w;
      do { w = stack.pop(); open.delete(w); component.push(w); } while (w !== v);
      if (component.length > 1) found.push(component.sort());
    };
    for (const file of files) if (!order.has(file)) visit(file);
    return found;
  };
  assert.deepEqual(components("static"), []);
  // BASE had one lazily closed component; A7 may only shrink it. Its members
  // now go by `decision-recorder.mjs` (was record-decision) and
  // `lifecycle-policy.mjs` (the lower half of migration-policy).
  const BASE_LAZY = new Set(["artifact/artifact-migration.mjs", "core.mjs", "decision-recorder.mjs", "lifecycle-policy.mjs",
    "operation-sequence.mjs", "operator-approval.mjs", "resumable-migration.mjs"]);
  for (const component of components("all")) {
    assert.deepEqual(component.filter((file) => !BASE_LAZY.has(file)), [], `new lazy cycle: ${component.join(" ")}`);
  }
});

test("A7-ARCH-4: one live implementation per transport declaration; the facades declare nothing and share one startup", async () => {
  const files = await engineFiles();
  const owners = new Map();
  for (const file of files) {
    for (const name of declared(await parse(file))) owners.set(name, [...(owners.get(name) ?? []), file]);
  }
  for (const name of Object.keys(transport)) {
    assert.equal(owners.get(name)?.length, 1, `${name}: ${owners.get(name)}`);
    assert.match(owners.get(name)[0], /^transport\//, name);
  }
  for (const facade of Object.keys(FACADES)) assert.deepEqual(declared(await parse(facade)), [], facade);
  // The symlink-safe guard is asked in one place, through startCommand.
  for (const file of files.filter((file) => file !== "engine-paths.mjs" && file !== "transport/entry.mjs")) {
    assert.doesNotMatch(await readFile(path.join(src, file), "utf8"), /isMainModule\(/, file);
  }
  // The A3/A6 MOVED rule, for A7: the moved CLI and protocol code is gone from the domain files it left.
  const left = {
    "decision-recorder.mjs": ["startCommand"],
    "upgrades/upgrade-coordinator.mjs": ["parseUpgradeArguments", "runUpgradeCli"],
    "lifecycle-policy.mjs": ["assertOptionCombination", "MODE_MESSAGE", "RUN_REFUSED_OPTIONS", "assertMode", "assertStepName"],
    "operator-signer-host.mjs": ["startCommand"],
  };
  for (const [file, names] of Object.entries(left)) {
    assert.deepEqual(declared(await parse(file)).filter((name) => names.includes(name)), [], file);
    assert.doesNotMatch(await readFile(path.join(src, file), "utf8"), /^#!|process\.argv/m, `${file} is not a process entry`);
  }
});

test("A7-ARCH-5: every historical entry path exports its BASE names and arities, as the canonical bindings", async () => {
  const canonical = {};
  for (const { from } of Object.values(FACADES)) for (const file of from) canonical[file] ??= await load(file);
  for (const [facade, { from }] of Object.entries(FACADES)) {
    const module = await load(facade);
    assert.deepEqual(Object.keys(module).sort(), Object.keys(BASE_EXPORTS[facade]).sort(), facade);
    for (const [name, arity] of Object.entries(BASE_EXPORTS[facade])) {
      const owner = from.find((file) => Object.hasOwn(canonical[file], name));
      assert.ok(owner, `${facade} ${name} has no canonical owner`);
      assert.equal(module[name], canonical[owner][name], `${facade} ${name}`);
      if (arity !== null) assert.equal(module[name].length, arity, `${facade} ${name} arity`);
    }
  }
  // The package API keeps the policy names, as the same bindings.
  const core = await load("core.mjs");
  const policy = await load("migration-policy.mjs");
  for (const name of Object.keys(BASE_EXPORTS["migration-policy.mjs"])) assert.equal(core[name], policy[name], `core ${name}`);
  assert.equal(policy.exitCodeFor("BLOCKED"), 2);
  assert.deepEqual(policy.MIGRATION_MODES, ["auto", "step"]);
});

test("A7-ARCH-6: all ten bins keep their paths, shebangs and startup, and answer the same through a symlink", async (t) => {
  const manifest = JSON.parse(await readFile(path.join(enginePackage, "package.json"), "utf8"));
  const bins = Object.fromEntries(Object.entries(FACADES).filter(([, { bin }]) => bin).map(([file, { bin }]) => [bin, `src/${file}`]));
  assert.deepEqual(manifest.bin, bins);
  for (const [name, relative] of Object.entries(manifest.bin)) {
    const source = await readFile(path.join(enginePackage, relative), "utf8");
    assert.match(source, /^#!\/usr\/bin\/env node\n/, name);
    assert.equal((source.match(/^startCommand\(import\.meta\.url, /gm) ?? []).length, 1, name);
  }
  if (process.platform === "win32") {
    t.skip("POSIX bin symlinks");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "a7 bins "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (command, args) => execFileAsync(process.execPath, [command, ...args], { cwd: root, encoding: "utf8" })
    .then(({ stdout, stderr }) => ({ stdout, stderr, code: 0 }), ({ stdout, stderr, code }) => ({ stdout, stderr, code }));
  // An unknown option is refused by each command's own parser: the message on
  // stderr only, exit 1, and the same bytes whether the file or its link ran.
  for (const [name, relative] of Object.entries(manifest.bin).filter(([name]) => name !== "artifact-migration-mcp")) {
    const link = path.join(root, name);
    await symlink(path.join(enginePackage, relative), link);
    const direct = await run(path.join(enginePackage, relative), ["--a7-unknown-option"]);
    assert.equal(direct.code, 1, `${name}: ${direct.stderr}`);
    assert.equal(direct.stdout, "", name);
    assert.match(direct.stderr, /a7-unknown-option/, name);
    assert.deepEqual(await run(link, ["--a7-unknown-option"]), direct, name);
  }
  // The MCP server through its link: one initialize answer, then a closed stdin ends the session cleanly.
  await symlink(path.join(enginePackage, manifest.bin["artifact-migration-mcp"]), path.join(root, "artifact-migration-mcp"));
  const child = spawn(process.execPath, [path.join(root, "artifact-migration-mcp")], { cwd: root });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } })}\n`);
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, stderr);
  const frames = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, 1);
  assert.ok(frames[0].result.capabilities.tools, stdout);
});

// What transport may reach of the decision authority: the recorder entry
// (which compares the answer under the module lock), the relay, the offer loop
// and read-only views. Nothing that builds, appends or answers a decision.
const AUTHORITY_IMPORTS = {
  "decision-recorder.mjs": ["pendingDecisionCandidates", "relayOperatorDecision", "runRecordDecisionCli"],
  "operator-approval.mjs": ["approveWithOperator", "moduleApprover", "recorderFor"],
  "decisions/index.mjs": ["renderDecisionReview", "reviewReference"],
};

test("A7-ARCH-7: MCP and the CLI reach decisions only through the recorder; no tool or argument can approve", async () => {
  const reached = {};
  for (const file of (await engineFiles()).filter((file) => file.startsWith("transport/"))) {
    for (const statement of (await parse(file)).statements) {
      if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier.text.startsWith(".")) continue;
      const target = path.posix.join(path.posix.dirname(file), statement.moduleSpecifier.text);
      const bindings = statement.importClause?.namedBindings;
      const names = bindings && ts.isNamedImports(bindings) ? bindings.elements.map((element) => (element.propertyName ?? element.name).text) : ["*"];
      if (Object.hasOwn(AUTHORITY_IMPORTS, target) || /^decisions\//.test(target)) (reached[target] ??= new Set()) && names.forEach((name) => reached[target].add(name));
      if (target === "store/index.mjs") assert.deepEqual(names.filter((name) => /write|append|journal|remove|seal|commit/i.test(name)), [], file);
    }
    const sf = await parse(file);
    for (const target of targets(file, sf)) assert.ok(!/^(module-lock|operator-signer|operator-webauthn)/.test(target), `${file} -> ${target}`);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(reached).map(([target, names]) => [target, [...names].sort()])), AUTHORITY_IMPORTS);
  // At runtime: the tool list names no approval, and no schema accepts an approval-shaped key.
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  const served = transport.serve({ input, output });
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  await served;
  const { tools } = JSON.parse(text).result;
  assert.ok(tools.length > 0);
  // One tool carries an answer: the explicit AGENT_RELAYED relay, whose
  // `decision` is the operator's own APPROVE/REJECT for a reviewed reference.
  // It records only through relayOperatorDecision, under the module lock.
  const answering = [];
  for (const tool of tools) {
    assert.doesNotMatch(tool.name, /approv|confirm|record/i, tool.name);
    for (const key of Object.keys(tool.inputSchema?.properties ?? {})) {
      if (transport.approvalShapedArgument({ [key]: "x" }, tool.name) !== null) answering.push(`${tool.name}.${key}`);
    }
  }
  assert.deepEqual(answering, ["migration_relay_decision.decision"]);
  assert.deepEqual(tools.find((tool) => tool.name === "migration_relay_decision").inputSchema.properties.decision.enum, ["APPROVE", "REJECT"]);
  assert.notEqual(transport.approvalShapedArgument({ module: "auth", confirmation: "x" }, "migration_run"), null);
});

test("A7-ARCH-8: the installers stay self-contained, and the release payload carries every engine entry they load", async () => {
  // The installers never import engine code statically; they load the verified release's files by path.
  for (const file of ["providers/install-support.mjs", "scripts/runtime-bootstrap.mjs"]) {
    const sf = await parse(file, repo);
    for (const statement of sf.statements.filter((statement) => ts.isImportDeclaration(statement))) {
      assert.match(statement.moduleSpecifier.text, /^node:/, `${file} imports ${statement.moduleSpecifier.text}`);
    }
  }
  const bootstrap = await readFile(path.join(repo, "scripts/runtime-bootstrap.mjs"));
  for (const skill of ["start-migration", "migrate-artifact"]) {
    assert.ok(bootstrap.equals(await readFile(path.join(repo, `skills/${skill}/scripts/runtime.mjs`))), `skills/${skill} runtime.mjs is not the bootstrap`);
  }
  const support = await readFile(path.join(repo, "providers/install-support.mjs"), "utf8");
  const loaded = [...support.matchAll(/'packages\/migration-engine\/src\/([\w/-]+\.mjs)'/g), ...bootstrap.toString().matchAll(/'packages\/migration-engine\/src\/([\w/-]+\.mjs)'/g)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(loaded)].sort(), ["mcp-server.mjs", "migration-utils.mjs"]);
  assert.equal(typeof (await load("migration-utils.mjs")).runDoctor, "function");
  const { payloadPaths } = await import(pathToFileURL(path.join(repo, "scripts/release.mjs")).href);
  const payload = new Set(await payloadPaths(repo));
  for (const file of await engineFiles()) assert.ok(payload.has(`packages/migration-engine/src/${file}`), file);
  for (const file of ["providers/install-support.mjs", "packages/migration-engine/package.json"]) assert.ok(payload.has(file), file);
});

test("A7-ARCH-9: importing any facade or the transport entry starts nothing", async () => {
  // A fresh process, stdin left open: a facade that started its command would
  // print a refusal, set an exit code, or (the MCP server) wait on stdin forever.
  const base = JSON.stringify(pathToFileURL(src).href);
  const probe = `
    for (const file of ${JSON.stringify([...Object.keys(FACADES), "transport/index.mjs", "core.mjs"])}) {
      await import(new URL(file, ${base}).href);
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", probe], { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill(), 60_000);
  const [code, signal] = await new Promise((resolve) => child.on("exit", (...args) => resolve(args)));
  clearTimeout(timer);
  assert.deepEqual({ code, signal, output }, { code: 0, signal: null, output: "" });
});
