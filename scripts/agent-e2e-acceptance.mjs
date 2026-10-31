#!/usr/bin/env node
/**
 * Black-box acceptance using a REAL provider CLI, not an LLM-free fixture.
 *
 * Run only inside a disposable, isolated consumer with provider credentials.
 * This harness never repairs a consumer; lock scenarios use the real engine protocol.
 * Each stage has one agent invocation and no rescue prompt; resume uses a new stage.
 * The installed engine decides whether the migration is complete.
 *
 * By default the agent runs under OS-enforced isolation (see `isolated`): the
 * trusted runtime, verifier, receipt, skills and report directory are
 * read-only to it, and nothing it starts outlives it. `--isolation none` is for
 * hosts without unprivileged namespaces; such a run is functional evidence
 * only and its report says it is not security-certified.
 */
import { pathToFileURL } from "node:url";
import { checkpoint, pendingTransaction, startLockHolder, verifyCheckpoint, snapshotTree, sameTree, exists, sha256, openspecLeads } from "./acceptance-evidence.mjs";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyBundle } from "../providers/install-support.mjs";
import { isMainModule } from "../packages/migration-engine/src/engine-paths.mjs";

const fail = (message) => { throw new Error(message); };
const argsOf = (argv) => {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!["--provider", "--cwd", "--module", "--target", "--output", "--timeout-minutes", "--goal", "--expected-pin", "--isolation", "--kind", "--source", "--source-root", "--artifact-target", "--scenario", "--resume-from", "--ui"].includes(name) || !argv[i + 1] || name in options)
      fail("Expected unique --provider, --cwd, --module, --target, --output and known optional flags, each with a value");
    options[name] = argv[i + 1];
  }
  for (const required of ["--provider", "--cwd", "--module", "--target", "--output"]) if (!options[required]) fail("Missing " + required);
  if (!["claude", "codex", "opencode"].includes(options["--provider"])) fail("Unsupported provider");
  for (const key of ["--module", "--target"]) if (!/^[a-z][a-z0-9-]*$/.test(options[key])) fail("Unsafe " + key);
  const goal = options["--goal"] ?? "bootstrap";
  if (!["bootstrap", "complete"].includes(goal)) fail("Goal must be bootstrap or complete");
  const expectedPin = options["--expected-pin"] ?? null;
  if (expectedPin !== null && !/^sha256:[a-f0-9]{64}$/.test(expectedPin))
    fail("--expected-pin must be an exact SHA-256 release-manifest digest");
  if (goal === "complete" && expectedPin === null)
    fail("Complete acceptance requires --expected-pin obtained independently from the candidate bundle before agent execution.");
  const isolation = options["--isolation"] ?? "os";
  if (!["os", "none"].includes(isolation)) fail("--isolation must be os or none");
  const kind = options["--kind"] ?? "module";
  const scenario = options["--scenario"] ?? "fresh";
  const ui = options["--ui"] ?? "headless";
  if (!["module", "artifact"].includes(kind)) fail("--kind must be module or artifact");
  if (!["fresh", "interrupt", "resume", "read-only", "live-lock", "abandoned-lock"].includes(scenario)) fail("Invalid --scenario");
  if (!["headless", "native"].includes(ui) || (ui === "native" && (options["--provider"] !== "codex" || scenario !== "fresh" || isolation !== "os")))
    fail("Native UI requires Codex, OS isolation and a fresh scenario");
  if (["interrupt", "resume", "read-only", "live-lock", "abandoned-lock"].includes(scenario) && isolation !== "os")
    fail("Safety and interruption scenarios require OS isolation");
  if (scenario === "resume" && !options["--resume-from"]) fail("Resume requires --resume-from interrupt report");
  if (scenario !== "resume" && options["--resume-from"]) fail("--resume-from is only valid with resume");
  if (kind === "artifact" && (!options["--source"] || !options["--source-root"] || !options["--artifact-target"]))
    fail("Artifact acceptance requires --source, --source-root and --artifact-target");
  for (const key of ["--source", "--artifact-target"]) if (options[key] &&
    (!/^[a-zA-Z0-9_./-]+$/.test(options[key]) || path.isAbsolute(options[key]) || options[key].split('/').includes('..') || options[key].startsWith('-')))
    fail("Unsafe " + key);
  if (["interrupt", "resume"].includes(scenario) && !options["--source-root"]) fail("Checkpoint scenarios require --source-root for unchanged legacy evidence");
  if (scenario !== "fresh" && expectedPin === null) fail("Scenarios require an independent --expected-pin");
  // ponytail: 240 minutes covers a frontend migration with browser evidence; raise when a real run needs it.
  const minutes = options["--timeout-minutes"] === undefined ? 50 : Number(options["--timeout-minutes"]);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) fail("Timeout must be between 1 and 240 minutes");
  return { provider: options["--provider"], cwd: path.resolve(options["--cwd"]), module: options["--module"],
    target: options["--target"], goal, expectedPin, isolation, kind, scenario, ui, source: options["--source"],
    sourceRoot: options["--source-root"] ? path.resolve(options["--source-root"]) : null, artifactTarget: options["--artifact-target"],
    resumeFrom: options["--resume-from"] ? path.resolve(options["--resume-from"]) : null, output: path.resolve(options["--output"]), timeoutMs: minutes * 60000 };
};

const SKILL_DIRS = { claude: ".claude/skills", codex: ".agents/skills", opencode: ".opencode/skills" };
/** Digest of every installed skill byte: the agent must never patch the toolkit it is judged on. */
const treeDigest = async (dir) => {
  const hash = createHash("sha256");
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter(e => e.isFile()).sort((a, b) =>
    path.join(a.parentPath, a.name).localeCompare(path.join(b.parentPath, b.name)))) {
    const file = path.join(entry.parentPath, entry.name);
    hash.update(path.relative(dir, file)).update("\0").update(await readFile(file)).update("\0");
  }
  return hash.digest("hex");
};

export const run = ({ command, argv, cwd, timeoutMs, stopWhen, native = false, env = process.env }) => new Promise((resolve, reject) => {
  // PWD too: OpenCode resolves its workspace from $PWD, and an inherited one
  // points the agent at the toolkit checkout instead of the consumer.
  const child = spawn(command, argv, { cwd, env: { ...env, PWD: cwd }, detached: native, stdio: native ? "inherit" : ["ignore", "pipe", "pipe"] });
  const stdout = [], stderr = [];
  let total = 0, timedOut = false, overflow = false, done = false;
  let interrupted = false, stopError = null, checking = false, escalation;
  const signal = value => {
    try { if (native) process.kill(-child.pid, value); else child.kill(value); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const stop = () => { signal("SIGTERM"); escalation ??= setTimeout(() => signal("SIGKILL"), 3000); };
  const monitor = stopWhen ? setInterval(async () => {
    if (checking || interrupted || done) return;
    checking = true;
    try { if (await stopWhen() && !done) { interrupted = true; stop(); } }
    catch (error) { stopError = error.message; if (!done) stop(); }
    finally { checking = false; }
  }, 50) : null;
  const clear = () => { clearTimeout(timeout); clearTimeout(escalation); clearInterval(monitor); };
  const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  const ingest = (parts) => chunk => {
    total += chunk.length;
    if (total > 32 * 1024 * 1024) {
      overflow = true;
      stop();
      return;
    }
    parts.push(chunk);
  };
  child.stdout?.on("data", ingest(stdout));
  child.stderr?.on("data", ingest(stderr));
  child.once("error", error => { if (!done) { done = true; clear(); reject(error); } });
  child.once("close", (code, signal) => {
    if (done) return;
    done = true; clear();
    resolve({ code, signal, timedOut, overflow, interrupted, stopError,
      stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
  });
});

/**
 * OS-enforced isolation: the agent gets its own user, mount and PID namespaces.
 * Each trusted path is bind-mounted read-only, then every capability is dropped
 * before exec, so the agent can neither write those paths nor remount them;
 * and when it exits, every process it left behind is killed with its PID
 * namespace -- nothing can rewrite the report afterwards.
 * ponytail: unshare(1) + setpriv(1), no container runtime. Ceiling: the agent
 * still shares the network and every path not listed, including the consumer
 * record it legitimately writes through the engine.
 * The agent keeps the runner's own non-root UID/GID, never namespace root: a
 * provider's own sandbox (Codex bubblewrap) may map parent UID 0 only if its
 * creator held CAP_SETFCAP (Linux >= 5.12), which the agent never does.
 * --keep-caps lets the trusted setup shell mount; setpriv then drops every
 * capability set before the agent starts.
 */
const ISOLATE = ["--user", "--map-current-user", "--keep-caps", "--mount", "--propagation", "private",
  "--pid", "--fork", "--mount-proc", "--kill-child"];
// Re-enter cwd after mounting: the inherited cwd handle still points below a new bind mount.
const ISOLATE_SETUP = 'set -e; n=$1; shift; while [ "$n" -gt 0 ]; do mount --bind "$1" "$1"; ' +
  'mount -o remount,bind,ro "$1"; shift; n=$((n - 1)); done; ' +
  'cd -- "$PWD"; exec setpriv --no-new-privs --inh-caps=-all --bounding-set=-all -- "$@"';
export const isolated = ({ command, argv }, readOnly) => ({ command: "unshare",
  argv: [...ISOLATE, "sh", "-c", ISOLATE_SETUP, "sh", String(readOnly.length), ...readOnly, command, ...argv] });

/**
 * Trusted, out-of-namespace witness for destructive changes to the module
 * record directory. The engine legitimately replaces state.json atomically,
 * but NEVER deletes and recreates modules/<target> to start its history over.
 *
 * This is a negative certification gate, not a durable anti-tamper ledger:
 * filesystem notifications can coalesce or be lost. A positive result does
 * not prove continuity against every adversarial filesystem operation.
 */
const observeRecordDirectory = async (record) => {
  const parent = path.dirname(record), target = path.basename(record);
  await mkdir(parent, { recursive: true });
  let targetRenames = await exists(record) ? 1 : 0;
  const violations = [];
  const watcher = watch(parent, { persistent: false }, (event, name) => {
    if (event !== "rename") return;
    const entry = name?.toString();
    if (entry === target) {
      targetRenames += 1;
      if (targetRenames > 1) violations.push("The migration record directory was removed, replaced, or recreated after its initial creation.");
    } else if (!entry || entry === path.basename(parent)) {
      violations.push("The module record parent directory was removed or replaced.");
    }
  });
  watcher.on("error", (error) => violations.push("Record continuity observer failed: " + error.message));
  return {
    close: () => watcher.close(),
    snapshot: () => ({ targetDirectoryRenameEvents: targetRenames,
      violations: [...new Set(violations)], assurance: "BEST_EFFORT_FILESYSTEM_EVENTS" }),
  };
};

// Each host's headless permission model, granting only the installed
// registration, the consumer's own Playwright MCP server (the skill's UI evidence
// provider) and its state directory -- never a sandbox bypass.
export const commandFor = (provider, invocation, root, native = false) => {
  const ask = "Invoke the installed " + (invocation.startsWith("/migrate-artifact") ? "migrate-artifact" : "start-migration") + " skill with exactly these arguments: " +
    invocation + ". Follow its existing contract; do not repair or modify the installed toolkit.";
  if (provider === "claude") return { command: "claude",
    argv: ["--print", invocation, "--output-format", "stream-json", "--verbose",
      "--mcp-config", ".mcp.json", "--permission-mode", "acceptEdits",
      "--allowedTools", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "mcp__start-migration", "mcp__playwright"] };
  // OpenCode has no --command flag; --standalone keeps the run off the user's service.
  if (provider === "opencode") return { command: "opencode",
    argv: ["run", "--standalone", "--format", "json", "--auto", ask] };
  // Codex workspace-write keeps .agents read-only, and an untrusted project skips its .codex/config.toml MCP entry.
  // exec never prompts, so an MCP call needing approval is refused: approve only CODEX_MCP_TOOLS, per tool,
  // on top of the installed start-migration entry (relay_decision stays out: operator decisions are not tool grants).
  return { command: "codex",
    argv: [...(native ? ["--no-daemon"] : ["exec", "--json"]), "--sandbox", "workspace-write", "--add-dir", path.join(root, ".agents"),
      "-c", `projects={ ${JSON.stringify(root)} = { trust_level = "trusted" } }`, "-c", 'approval_policy="never"',
      "-c", `mcp_servers.start-migration.enabled_tools=${JSON.stringify(CODEX_MCP_TOOLS)}`,
      ...CODEX_MCP_TOOLS.flatMap((tool) => ["-c", `mcp_servers.start-migration.tools.${tool}.approval_mode="approve"`]),
      "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"',
      ...(native ? [] : [ask])] };
};
export const CODEX_MCP_TOOLS = ["artifact_status", "artifact_run", "migration_status", "migration_scan",
  "migration_evidence_binding", "migration_prefill", "migration_capture", "migration_pending_decisions", "migration_run"];

export function acceptanceVerdict(goal, agent, bootstrapped, finished, verified, progress) {
  if (agent.code !== 0 || agent.timedOut || agent.overflow) return "FAIL";
  if (goal === "bootstrap") return bootstrapped ? "BOOTSTRAP_PASS" : "FAIL";
  return finished && verified?.code === 0 && !verified.timedOut && !verified.overflow && progress ? "E2E_COMPLETE_PASS" : "FAIL";
}

async function main() {
  const options = argsOf(process.argv.slice(2));
  // An explicit marker makes it harder to accidentally run destructive
  // acceptance work on a user's actual production repository.
  const root = await realpath(options.cwd);
  await mkdir(options.output, { recursive: true });
  const output = await realpath(options.output);
  if (output === root || output.startsWith(root + path.sep)) fail("Output must be outside the disposable consumer");
  if ((await readdir(output)).length) fail("Output must be empty; never overwrite earlier evidence");
  // From here on every outcome -- a refusal, a tamper finding, a missing status
  // -- leaves a report.json: an absent report must never be read as a pass.
  const report = { schemaVersion: 1, provider: options.provider, module: options.module, target: options.target,
    goal: options.goal, kind: options.kind, scenario: options.scenario, root, verdict: "FAIL", failure: null };
  try {
    await score(options, root, output, report);
  } catch (error) {
    report.failure = error.message;
    if (report.security) report.security.certified = false;
    report.verdict = "FAIL";
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    throw error;
  }
  process.stdout.write(JSON.stringify({ output, verdict: report.verdict, currentStep: report.engine?.currentStep,
    progressDisplayed: report.presentation?.progressAppearsInAgentOutput }, null, 2) + "\n");
  if (!["BOOTSTRAP_PASS", "E2E_COMPLETE_PASS", "INTERRUPTED_CHECKPOINT", "SAFETY_REFUSAL_PASS"].includes(report.verdict)) process.exitCode = 1;
}

async function score(options, root, output, report) {
  const markerPath = path.join(root, ".artifact-migration-acceptance.json");
  const markerBytes = await readFile(markerPath);
  const marker = JSON.parse(markerBytes);
  if (marker.disposable !== true || marker.module !== options.module || marker.target !== options.target ||
      typeof marker.verifier !== "string" || typeof marker.verifierSha256 !== "string")
    fail("Disposable consumer marker requires module, target, external verifier and its SHA-256");
  const verifier = await realpath(marker.verifier);
  if (verifier === root || verifier.startsWith(root + path.sep))
    fail("Independent verifier must reside OUTSIDE the agent-writable consumer");
  const verifierSha256 = createHash("sha256").update(await readFile(verifier)).digest("hex");
  if (marker.verifierSha256 !== verifierSha256) fail("Independent verifier digest does not match the pinned digest");
  if (options.kind === "artifact" && (marker.kind !== "artifact" || marker.source !== options.source ||
      marker.sourceRoot !== options.sourceRoot || marker.artifactTarget !== options.artifactTarget))
    fail("Artifact marker must pin kind, source, sourceRoot and artifactTarget");
  const invocation = options.kind === "artifact"
    ? '/migrate-artifact ' + options.source + ' --source-root ' + JSON.stringify(options.sourceRoot) +
      ' --target-root ' + JSON.stringify(root) + ' --target ' + options.artifactTarget + ' --mode auto --ponytail full'
    : '/start-migration ' + options.module + ' --target ' + options.target +
      ' --mode auto --ponytail full --design-source target-system';
  let sourceBefore;
  if (options.sourceRoot) {
    options.sourceRoot = await realpath(options.sourceRoot);
    if (options.kind === "module" && (root === options.sourceRoot || root.startsWith(options.sourceRoot + path.sep) || options.sourceRoot.startsWith(root + path.sep)))
      fail("Acceptance source root must be separate from the writable target");
    if (marker.sourceRoot !== options.sourceRoot) fail("Marker must pin the source root");
    if (options.kind === "artifact" && path.resolve(options.sourceRoot, options.source) === path.resolve(root, options.artifactTarget))
      fail("Acceptance fixture must retain its legacy source separately from migrated output");
    sourceBefore = await snapshotTree(options.kind === "artifact" ? path.join(options.sourceRoot, options.source) : options.sourceRoot);
    report.source = { root: options.sourceRoot, tree: sourceBefore };
  }
  report.invocation = invocation;
  const invocationCommand = commandFor(options.provider, invocation, root, options.ui === "native");
  // The receipt is the installation precondition. Check it before walking
  // provider files so a fresh consumer reports a useful error, not ENOENT.
  // The receipt is produced by the real skill runtime at install, never by this
  // harness; pin it now so the agent cannot redirect the status command below.
  const receiptPath = path.join(root, ".artifact-migration-tools", options.provider + ".json");
  const receiptBytes = await readFile(receiptPath).catch(error => {
    if (error.code === "ENOENT") fail(
      "ACCEPTANCE_PRECONDITION: The installed " + options.provider +
      " runtime receipt is missing at " + receiptPath +
      ". Install the exact candidate toolkit into this disposable consumer before running acceptance.",
    );
    throw error;
  });
  const installed = JSON.parse(receiptBytes);
  if (installed.provider !== options.provider ||
      path.resolve(installed.root ?? "") !== root ||
      typeof installed.release !== "string" || !path.isAbsolute(installed.release) ||
      typeof installed.store !== "string" || !path.isAbsolute(installed.store) ||
      !/^sha256:[a-f0-9]{64}$/.test(installed.pin ?? "") ||
      installed.release !== path.join(installed.store, `${installed.toolkit?.version}-${installed.pin.slice(7)}`))
    fail("ACCEPTANCE_PRECONDITION: The installed runtime receipt has a conflicting provider, root, release or pin.");
  report.toolkit = installed.toolkit ?? null;
  report.candidate = { expectedPin: options.expectedPin, installedPin: installed.pin, independentPinRequiredForComplete: true,
    matchesTrustedPin: options.expectedPin !== null && options.expectedPin === installed.pin };
  if (options.expectedPin && installed.pin !== options.expectedPin)
    fail("ACCEPTANCE_PRECONDITION: Installed engine pin does not match independently supplied --expected-pin.");
  const manifest = await verifyBundle(installed.release, installed.pin);
  if (JSON.stringify(manifest.toolkit) !== JSON.stringify(installed.toolkit))
    fail("ACCEPTANCE_PRECONDITION: Installed receipt identity disagrees with the verified bundle.");
  const packageJson = JSON.parse(await readFile(
    path.join(installed.release, "packages/migration-engine/package.json"), "utf8"));
  const cliName = options.kind === "artifact" ? "artifact-migrate" : "artifact-migration-discover";
  const expectedCli = path.join(installed.release, "packages/migration-engine", packageJson.bin?.[cliName] ?? "");
  const cli = installed.commands?.[cliName];
  if (!Array.isArray(cli) || cli.length !== 2 || !path.isAbsolute(cli[0]) || cli[1] !== expectedCli || !packageJson.bin?.[cliName])
    fail("ACCEPTANCE_PRECONDITION: Status command is not the one from the verified release.");
  report.trusted = {
    marker: { path: markerPath, sha256: sha256(markerBytes) },
    receipt: { path: receiptPath, sha256: sha256(receiptBytes), store: installed.store, release: installed.release },
    verifier: { path: verifier, sha256: verifierSha256 },
  };
  const artifactApi = options.kind === "artifact" ? await import(pathToFileURL(path.join(installed.release,
    "packages/migration-engine/src/artifact/artifact-migration.mjs"))) : null;
  const id = artifactApi ? artifactApi.artifactIdFor({ source: options.source, type: "artifact" }) : options.target;
  const recordDir = path.join(root, ".agents/knowledge/migrations", artifactApi ? "artifacts" : "modules", id);
  const record = path.join(recordDir, "state.json");
  const lock = path.join(root, ".agents/knowledge/migrations/locks", (artifactApi ? "artifact-" : "") + id + ".lock");
  const statusArgs = artifactApi ? [options.source, "--source-root", options.sourceRoot, "--target-root", root,
    "--target", options.artifactTarget, "--status", "--json"] : [options.target, "--status"];
  const readStatus = () => run({ command: cli[0], argv: [...cli.slice(1), ...statusArgs], cwd: root, timeoutMs: 120000 });
  if (options.resumeFrom) {
    options.resumeFrom = await realpath(options.resumeFrom);
    if (options.resumeFrom.startsWith(root + path.sep)) fail("Resume evidence must be outside the consumer");
  }
  const savedBytes = options.resumeFrom ? await readFile(options.resumeFrom, "utf8") : null;
  const saved = savedBytes === null ? null : JSON.parse(savedBytes);
  if (options.resumeFrom && (!saved || typeof saved !== "object")) fail("Resume report must be an interruption report object");
  if (saved) {
    if (saved.verdict !== "INTERRUPTED_CHECKPOINT" || saved.root !== root || saved.kind !== options.kind || saved.provider !== options.provider ||
        saved.invocation !== invocation || saved.candidate?.installedPin !== installed.pin ||
        saved.security?.isolation !== (options.isolation === "os" ? "OS_NAMESPACE" : "NONE") || !saved.checkpoint)
      fail("ACCEPTANCE_PRECONDITION: Resume report does not bind this interrupted consumer");
    if (!saved.trusted || !sameTree(saved.trusted, report.trusted))
      fail("ACCEPTANCE_CHECKPOINT_CHANGED: trusted marker, receipt or verifier identity differs before resume");
    if (await pendingTransaction(recordDir))
      fail("ACCEPTANCE_CHECKPOINT_BUSY: pending journal before resume; preserve it without recovery");
    if (await exists(lock)) fail("ACCEPTANCE_PRECONDITION: Interrupted lock remains; owner proof required, never repair it");
    if (!saved.source || saved.source.root !== options.sourceRoot || !sameTree(saved.source.tree, sourceBefore))
      fail("ACCEPTANCE_CHECKPOINT_CHANGED: source was rebuilt or changed before resume");
    await verifyCheckpoint(recordDir, saved.checkpoint, true);
    const status = await readStatus();
    await writeFile(path.join(output, "resume-before-status.json"), status.stdout);
    if (status.code !== 0 || /"(?:status|outcome)"\s*:\s*"(?:BLOCKED|STALE)"/.test(status.stdout)) fail("Resume checkpoint fails installed engine integrity checks");
  } else if (await exists(record)) fail("Not a fresh consumer: migration record already exists");
  if (options.provider === "codex") {
    const version = await run({ command: "codex", argv: ["--version"], cwd: root, timeoutMs: 30000 });
    const engineNode = await run({ command: cli[0], argv: ["--version"], cwd: root, timeoutMs: 30000 });
    report.runtime = { node: process.version, engineNode: engineNode.stdout.trim(), codex: version.stdout.trim(),
      model: "gpt-6.1-sol", reasoningEffort: "high" };
    if (version.code !== 0 || version.stdout.trim() !== "codex-cli 0.165.0" || process.version !== "v22.13.0" ||
        engineNode.code !== 0 || engineNode.stdout.trim() !== "v22.13.0") fail("ACCEPTANCE_PRECONDITION: require Codex 0.165.0 and Node 22.13.0 (runner and installed engine)");
  }
  report.record = recordDir;
  const skills = path.join(root, SKILL_DIRS[options.provider]);
  const skillsBefore = await treeDigest(skills);
  // The report directory exists before the agent does, so it can be sealed too.
  await mkdir(output, { recursive: true });
  // A verifier in its own directory is sealed whole, so its own dependencies (a
  // browser driver) are as untouchable as its script. A broad directory -- one
  // holding the consumer, HOME (the provider's session files) or the temp dir,
  // such as HOME or / -- seals only the script and its sibling node_modules.
  // ponytail: a broad-directory verifier's dependency resolved from anywhere
  // else (a parent node_modules, NODE_PATH) is not sealed; give the verifier
  // its own directory for that.
  const verifierDir = path.dirname(verifier);
  const writable = [root, ...(await Promise.all([os.homedir(), os.tmpdir()].map((dir) => realpath(dir).catch(() => dir))))];
  const broad = writable.some((dir) => dir === verifierDir || dir.startsWith(path.join(verifierDir, path.sep)));
  const verifierModules = await realpath(path.join(verifierDir, "node_modules")).catch(() => null);
  const sealedVerifier = broad ? [verifier, verifierModules].filter(Boolean) : [verifierDir];
  const readOnly = [...new Set(await Promise.all([...(options.scenario === "read-only" ? [root] : []), ...(options.sourceRoot ? [options.kind === "artifact" ? path.join(options.sourceRoot, options.source) : options.sourceRoot] : []), ...(options.resumeFrom ? [options.resumeFrom] : []), installed.store, ...sealedVerifier, receiptPath, markerPath, skills, output]
    .map((entry) => realpath(entry))))].sort();
  report.security = { isolation: options.isolation === "os" ? "OS_NAMESPACE" : "NONE",
    readOnly: options.isolation === "os" ? readOnly : [],
    // Certified only when the agent could not write the trusted paths and the
    // candidate is the one pinned from outside the consumer.
    trustedRuntimeIsolated: options.isolation === "os" && options.expectedPin !== null && options.expectedPin === installed.pin,
    // E2E certification is awarded only after a genuine COMPLETE, verifier PASS
    // and the independent record-continuity refusal gate. Never pre-award it.
    certified: false };
  if (options.isolation === "os") {
    // unshare maps the effective IDs onto themselves, so an effective root would keep host
    // root's file ownership inside the namespace; a real root could regain it (setuid(0)).
    if (process.getuid() === 0 || process.geteuid() === 0) fail("ACCEPTANCE_PRECONDITION: OS isolation refuses to run " +
      "with a real or effective UID of 0: the agent keeps the runner's effective UID, so launch the runner as a " +
      "non-root user. Rerun with --isolation none for functional evidence that is NOT security-certified.");
    const probe = await run({ ...isolated({ command: "true", argv: [] }, readOnly), cwd: root, timeoutMs: 30000 })
      .catch((error) => ({ code: 1, stderr: error.message }));
    if (probe.code !== 0) fail("ACCEPTANCE_PRECONDITION: OS isolation is unavailable here (unprivileged user, mount and PID " +
      "namespaces via unshare --map-current-user --keep-caps and setpriv): " + String(probe.stderr).trim() + ". Rerun with --isolation none for " +
      "functional evidence that is NOT security-certified.");
  }
  // Watch the parent from THIS trusted runner, not inside the agent namespace.
  // Creating only the empty parent is safe for an otherwise fresh consumer.
  const observer = await observeRecordDirectory(recordDir);
  let holder;
  try {
    if (["live-lock", "abandoned-lock"].includes(options.scenario)) {
      if (await exists(lock)) fail("ACCEPTANCE_PRECONDITION: Fixture already has a lock");
      holder = await startLockHolder(cli[0], pathToFileURL(path.join(installed.release,
        "packages/migration-engine/src/lifecycle/lock.mjs")).href, root, path.basename(lock, ".lock"));
      const ownerFile = (await readdir(lock))[0];
      report.lock = { owner: JSON.parse(await readFile(path.join(lock, ownerFile), "utf8")), before: await snapshotTree(lock) };
      if (options.scenario === "abandoned-lock") { await holder.stop(true); report.lock.ownerExited = true; }
    }
    const beforeTree = ["read-only", "live-lock"].includes(options.scenario) ? await snapshotTree(root) : null;
    if (beforeTree) await writeFile(path.join(output, "consumer-before.json"), JSON.stringify(beforeTree, null, 2));
    let agent, interruptedAt;
    let launch = options.isolation === "os" ? isolated(invocationCommand, readOnly) : invocationCommand;
    if (options.ui === "native") {
      if (!process.stdin.isTTY || !process.stdout.isTTY) fail("Native launch requires an operator terminal");
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      launch = { command: "script", argv: ["--quiet", "--return", "--flush", "--log-out", path.join(output, "native.typescript"),
        "--log-timing", path.join(output, "native.timing"), "--command", [launch.command, ...launch.argv].map(quote).join(" ")] };
      process.stdout.write("Record the screen. Type exactly once: " + invocation + "\nNo rescue prompts. Exit when the agent stops.\n");
    }
    report.launch = { ...launch, cwd: root };
    report.startedAt = new Date().toISOString();
    try {
      agent = await run({ ...launch, cwd: root, timeoutMs: options.timeoutMs, native: options.ui === "native",
        // Runtime selection must keep the installed store even when resume uses another HOME.
        env: { ...process.env, ARTIFACT_MIGRATION_TOOLS_STORE: installed.store },
        stopWhen: options.scenario === "interrupt" ? async () => {
          if (!await exists(record)) return false;
          interruptedAt = await checkpoint(recordDir, lock);
          return interruptedAt !== null;
        } : undefined });
    } finally {
      // Drain notifications already queued by the provider before closing watch.
      await new Promise((resolve) => setImmediate(resolve));
      report.security.recordContinuity = observer.snapshot();
      observer.close();
    }
    if (options.ui === "native") agent.stdout = await readFile(path.join(output, "native.typescript"), "utf8");
    await writeFile(path.join(output, "agent.stdout.log"), agent.stdout);
    await writeFile(path.join(output, "agent.stderr.log"), agent.stderr);
    const combined = agent.stdout + "\n" + agent.stderr;
    report.openspec = { status: "NOT_TESTED", reviewRequired: true, candidates: openspecLeads(agent.stdout) };
    report.presentation = { nativeUiCertified: false, mode: options.ui,
      operatorRequired: options.ui === "native" ? ["screen recording", "single invocation attestation", "compare visible progress with engine status"] : [] };
    report.agent = { exitCode: agent.code, signal: agent.signal, timedOut: agent.timedOut, overflow: agent.overflow,
      transcriptSha256: createHash("sha256").update(combined).digest("hex") };
    if (report.security.recordContinuity.violations.length > 0) {
      fail("ACCEPTANCE_RECORD_REPLACED: The coding agent destroyed or replaced its migration record. " +
        report.security.recordContinuity.violations.join(" ") + " Transcripts preserved; never certify this run.");
    }
    if (!markerBytes.equals(await readFile(markerPath)))
      fail("Agent modified the pinned acceptance marker (transcripts preserved)");
    if (createHash("sha256").update(await readFile(verifier)).digest("hex") !== verifierSha256)
      fail("Independent verifier changed during the agent run (transcripts preserved)");
    if (await treeDigest(skills) !== skillsBefore)
      fail("Agent modified the installed skills (transcripts preserved)");
    if (!receiptBytes.equals(await readFile(receiptPath)))
      fail("Agent modified the installed runtime receipt (transcripts preserved)");
    try {
      await verifyBundle(installed.release, installed.pin);
    } catch (error) {
      fail("Agent left the installed runtime bundle modified or invalid (transcripts preserved): " + error.message);
    }
    const statusRun = await readStatus();
    await writeFile(path.join(output, "engine-status.stdout.log"), statusRun.stdout);
    await writeFile(path.join(output, "engine-status.stderr.log"), statusRun.stderr);
    if (sourceBefore && !sameTree(sourceBefore, await snapshotTree(options.kind === "artifact" ? path.join(options.sourceRoot, options.source) : options.sourceRoot))) fail("Source changed during acceptance");
    if (report.lock) {
      report.lock.after = await exists(lock) ? await snapshotTree(lock) : null;
      report.lock.holderAliveAfter = holder.alive();
      if (options.scenario === "live-lock" && (!holder.alive() || !sameTree(report.lock.before, report.lock.after)))
        fail("Live lock ownership or bytes changed");
      // The engine never proves a host-realm owner gone from the agent's PID namespace (nor from
      // Codex's per-command sandbox namespace), so a vanished lock was removed outside the protocol.
      if (options.scenario === "abandoned-lock") {
        report.lock.recovery = report.lock.after ? "BLOCKED_OWNER_PROOF" : "REMOVED_WITHOUT_OWNER_PROOF";
        fail(report.lock.after ? "ACCEPTANCE_LOCK_OWNER_PROOF: abandoned host-realm owner cannot be reclaimed in the agent PID namespace; preserve lock, engine change/owner ruling required"
          : "ACCEPTANCE_LOCK_REMOVED: the abandoned lock vanished although no engine path can prove its host-realm owner gone; never certify");
      }
    }
    if (agent.stopError) fail("Checkpoint observer failed: " + agent.stopError);
    if (beforeTree) {
      const afterTree = await snapshotTree(root);
      await writeFile(path.join(output, "consumer-after.json"), JSON.stringify(afterTree, null, 2));
      report.safety = { reviewRequired: true, unchanged: sameTree(beforeTree, afterTree), refusalObserved: /read.only|EROFS|permission denied|holds the lock|cannot be proven gone/i.test(combined) };
      if (!report.safety.unchanged || !report.safety.refusalObserved || agent.timedOut || agent.overflow || agent.signal || await exists(record))
        fail("Safety refusal not proven: require unchanged consumer, actual refusal, no timeout and no migration record");
      report.verdict = "SAFETY_REFUSAL_PASS";
      await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
      return;
    }
    if (statusRun.code !== 0) fail("Engine status failed after agent invocation; logs preserved");
    const rawStatus = JSON.parse(statusRun.stdout);
    const status = artifactApi ? { ...rawStatus, currentStep: rawStatus.state?.currentStep } : rawStatus;
    if (["BLOCKED", "STALE"].includes(status.status) || ["BLOCKED", "STALE"].includes(status.outcome)) fail("Engine reports invalid or stale record");
    const state = JSON.parse(await readFile(record, "utf8"));
    report.engine = { currentStep: status.currentStep, state: status.status, revision: state.revision,
      progressChecklist: status.progressChecklist, progressAvailable: typeof status.progressChecklist === "string" && status.progressChecklist.length > 0 };
    if (artifactApi ? state.artifactId !== id || status.artifactId !== id : state.targetModule !== options.target || status.target !== options.target)
      fail("Migration record does not belong to the requested --target");
    if (options.scenario === "interrupt") {
      if (!agent.interrupted || !interruptedAt || agent.timedOut || agent.overflow) fail("No committed checkpoint was interrupted");
      await verifyCheckpoint(recordDir, interruptedAt, true);
      if (await exists(lock) || await pendingTransaction(recordDir))
        fail("ACCEPTANCE_CHECKPOINT_BUSY: interruption left a lock/journal; preserve it for owner-proof recovery");
      report.checkpoint = interruptedAt;
      report.verdict = "INTERRUPTED_CHECKPOINT";
      await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
      return;
    }
    if (saved) {
      await verifyCheckpoint(recordDir, saved.checkpoint);
      if (state.revision <= saved.checkpoint.revision) fail("Resume did not commit any new checkpoint");
      if (await readFile(options.resumeFrom, "utf8") !== savedBytes) fail("Resume evidence changed during the run");
      report.resume = { previousReportSha256: sha256(savedBytes), historyPrefixPreserved: true, completedArtifactsPreserved: true };
    }
    const finished = state.currentStep === "COMPLETE" && status.currentStep === "COMPLETE";
    const bootstrapped = state.completedSteps?.includes("RESOLVE") &&
      status.progressChecklist?.includes("DISCOVER_LEGACY") && status.currentStep !== "RESOLVE";
    // argv[3] is this report directory, for the verifier's own artifacts (screenshots).
    const verified = finished ? await run({
      command: process.execPath, argv: [verifier, root, output], cwd: root, timeoutMs: 300000,
    }) : null;
    if (verified) {
      await writeFile(path.join(output, "independent-verify.stdout.log"), verified.stdout);
      await writeFile(path.join(output, "independent-verify.stderr.log"), verified.stderr);
    }
    Object.assign(report, { completedAt: new Date().toISOString(),
      presentation: { ...report.presentation, progressAppearsInAgentOutput: combined.includes("progress: " + (artifactApi ? id : options.module) + " -> " + (artifactApi ? state.target.path : options.target)),
        // This is NOT proof of native UI rendering; that needs a separate recording.
        nativeUiCertified: false },
      independentVerification: verified ? { exitCode: verified.code, timedOut: verified.timedOut,
        verifierSha256 } : null,
      verdict: acceptanceVerdict(options.goal, agent, bootstrapped, finished, verified, status.progressChecklist) });
    report.security.certified = report.verdict === "E2E_COMPLETE_PASS" && options.ui !== "native" &&
      report.security.trustedRuntimeIsolated && report.security.recordContinuity.violations.length === 0;
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  } finally {
    observer.close();
    if (holder?.alive()) await holder.stop();
  }
}

// Imported by the tests for commandFor; run only as a script (directly or through a symlink).
if (isMainModule(import.meta.url))
  main().catch(error => { console.error("AGENT_ACCEPTANCE_ERROR:", error.message); process.exitCode = 1; });
