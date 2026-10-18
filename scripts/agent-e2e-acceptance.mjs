#!/usr/bin/env node
/**
 * Black-box acceptance using a REAL provider CLI, not an LLM-free fixture.
 *
 * Run only inside a disposable, isolated consumer with provider credentials.
 * This harness never edits a skill, registry, lock, or migration artifact.
 * Its single agent invocation gets no rescue prompt. The installed engine
 * decides whether the migration is complete.
 *
 * By default the agent runs under OS-enforced isolation (see `isolated`): the
 * trusted runtime, verifier, receipt, skills and report directory are
 * read-only to it, and nothing it starts outlives it. `--isolation none` is for
 * hosts without unprivileged namespaces; such a run is functional evidence
 * only and its report says it is not security-certified.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyBundle } from "../providers/install-support.mjs";

const fail = (message) => { throw new Error(message); };
const argsOf = (argv) => {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!["--provider", "--cwd", "--module", "--target", "--output", "--timeout-minutes", "--goal", "--expected-pin", "--isolation"].includes(name) || !argv[i + 1] || name in options)
      fail("Expected unique --provider, --cwd, --module, --target, --output and optional --timeout-minutes arguments");
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
  // ponytail: 240 minutes covers a frontend migration with browser evidence; raise when a real run needs it.
  const minutes = options["--timeout-minutes"] === undefined ? 50 : Number(options["--timeout-minutes"]);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) fail("Timeout must be between 1 and 240 minutes");
  return { provider: options["--provider"], cwd: path.resolve(options["--cwd"]), module: options["--module"],
    target: options["--target"], goal, expectedPin, isolation, output: path.resolve(options["--output"]), timeoutMs: minutes * 60000 };
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

const run = ({ command, argv, cwd, timeoutMs }) => new Promise((resolve, reject) => {
  // PWD too: OpenCode resolves its workspace from $PWD, and an inherited one
  // points the agent at the toolkit checkout instead of the consumer.
  const child = spawn(command, argv, { cwd, env: { ...process.env, PWD: cwd }, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [], stderr = [];
  let total = 0, timedOut = false, overflow = false, done = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
  const ingest = (parts) => chunk => {
    total += chunk.length;
    if (total > 32 * 1024 * 1024) {
      overflow = true;
      child.kill("SIGTERM");
      return;
    }
    parts.push(chunk);
  };
  child.stdout.on("data", ingest(stdout));
  child.stderr.on("data", ingest(stderr));
  child.once("error", error => { if (!done) { done = true; clearTimeout(timeout); reject(error); } });
  child.once("close", (code, signal) => {
    if (done) return;
    done = true; clearTimeout(timeout);
    resolve({ code, signal, timedOut, overflow,
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
 */
const ISOLATE = ["--user", "--map-root-user", "--mount", "--propagation", "private",
  "--pid", "--fork", "--mount-proc", "--kill-child"];
const ISOLATE_SETUP = 'set -e; n=$1; shift; while [ "$n" -gt 0 ]; do mount --bind "$1" "$1"; ' +
  'mount -o remount,bind,ro "$1"; shift; n=$((n - 1)); done; ' +
  'exec setpriv --no-new-privs --inh-caps=-all --bounding-set=-all -- "$@"';
const isolated = ({ command, argv }, readOnly) => ({ command: "unshare",
  argv: [...ISOLATE, "sh", "-c", ISOLATE_SETUP, "sh", String(readOnly.length), ...readOnly, command, ...argv] });

// Each host's headless permission model, granting only the installed
// registration, the consumer's own Playwright MCP server (the skill's UI evidence
// provider) and its state directory -- never a sandbox bypass.
const commandFor = (provider, invocation, root) => {
  const ask = "Invoke the installed start-migration skill with exactly these arguments: " +
    invocation + ". Follow its existing contract; do not repair or modify the installed toolkit.";
  if (provider === "claude") return { command: "claude",
    argv: ["--print", invocation, "--output-format", "stream-json", "--verbose",
      "--mcp-config", ".mcp.json", "--permission-mode", "acceptEdits",
      "--allowedTools", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "mcp__start-migration", "mcp__playwright"] };
  // OpenCode has no --command flag; --standalone keeps the run off the user's service.
  if (provider === "opencode") return { command: "opencode",
    argv: ["run", "--standalone", "--format", "json", "--auto", ask] };
  // Codex workspace-write keeps .agents read-only, and an untrusted project skips its .codex/config.toml MCP entry.
  return { command: "codex",
    argv: ["exec", "--json", "--sandbox", "workspace-write", "--add-dir", path.join(root, ".agents"),
      "-c", `projects={ ${JSON.stringify(root)} = { trust_level = "trusted" } }`, ask] };
};

async function main() {
  const options = argsOf(process.argv.slice(2));
  // An explicit marker makes it harder to accidentally run destructive
  // acceptance work on a user's actual production repository.
  const root = await realpath(options.cwd);
  const output = path.resolve(options.output);
  if (output === root || output.startsWith(root + path.sep)) fail("Output must be outside the disposable consumer");
  // From here on every outcome -- a refusal, a tamper finding, a missing status
  // -- leaves a report.json: an absent report must never be read as a pass.
  const report = { schemaVersion: 1, provider: options.provider, module: options.module, target: options.target,
    goal: options.goal, verdict: "FAIL", failure: null };
  try {
    await score(options, root, output, report);
  } catch (error) {
    report.failure = error.message;
    report.verdict = "FAIL";
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    throw error;
  }
  process.stdout.write(JSON.stringify({ output, verdict: report.verdict, currentStep: report.engine.currentStep,
    progressDisplayed: report.presentation.progressAppearsInAgentOutput }, null, 2) + "\n");
  if (!["BOOTSTRAP_PASS", "E2E_COMPLETE_PASS"].includes(report.verdict)) process.exitCode = 1;
}

async function score(options, root, output, report) {
  const markerPath = path.join(root, ".artifact-migration-acceptance.json");
  const markerBytes = await readFile(markerPath, "utf8");
  const marker = JSON.parse(markerBytes);
  if (marker.disposable !== true || marker.module !== options.module || marker.target !== options.target ||
      typeof marker.verifier !== "string" || typeof marker.verifierSha256 !== "string")
    fail("Disposable consumer marker requires module, target, external verifier and its SHA-256");
  const verifier = await realpath(marker.verifier);
  if (verifier === root || verifier.startsWith(root + path.sep))
    fail("Independent verifier must reside OUTSIDE the agent-writable consumer");
  const verifierSha256 = createHash("sha256").update(await readFile(verifier)).digest("hex");
  if (marker.verifierSha256 !== verifierSha256) fail("Independent verifier digest does not match the pinned digest");
  const record = path.join(root, ".agents", "knowledge", "migrations", "modules", options.target, "state.json");
  const already = await readFile(record, "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (already !== null) fail("Not a fresh consumer: migration record already exists");
  const invocation = '/start-migration ' + options.module + ' --target ' + options.target +
    ' --mode auto --ponytail full --design-source target-system';
  report.invocation = invocation;
  const invocationCommand = commandFor(options.provider, invocation, root);
  // The receipt is the installation precondition. Check it before walking
  // provider files so a fresh consumer reports a useful error, not ENOENT.
  // The receipt is produced by the real skill runtime at install, never by this
  // harness; pin it now so the agent cannot redirect the status command below.
  const receiptPath = path.join(root, ".artifact-migration-tools", options.provider + ".json");
  const receiptBytes = await readFile(receiptPath, "utf8").catch(error => {
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
  const expectedDiscover = path.join(installed.release, "packages/migration-engine",
    packageJson.bin?.["artifact-migration-discover"] ?? "");
  const installedDiscover = installed.commands?.["artifact-migration-discover"];
  if (!Array.isArray(installedDiscover) || installedDiscover.length !== 2 ||
      !path.isAbsolute(installedDiscover[0]) || installedDiscover[1] !== expectedDiscover ||
      !packageJson.bin?.["artifact-migration-discover"])
    fail("ACCEPTANCE_PRECONDITION: Discover command is not the one from the verified release.");
  const skills = path.join(root, SKILL_DIRS[options.provider]);
  const skillsBefore = await treeDigest(skills);
  // The report directory exists before the agent does, so it can be sealed too.
  await mkdir(output, { recursive: true });
  // A verifier directory that does not hold the consumer is sealed whole, so
  // its own dependencies (a browser driver) are as untouchable as its script.
  const verifierDir = path.dirname(verifier);
  const sealedVerifier = root.startsWith(verifierDir + path.sep) ? verifier : verifierDir;
  const readOnly = [...new Set(await Promise.all([installed.store, sealedVerifier, receiptPath, markerPath, skills, output]
    .map((entry) => realpath(entry))))].sort();
  report.security = { isolation: options.isolation === "os" ? "OS_NAMESPACE" : "NONE",
    readOnly: options.isolation === "os" ? readOnly : [],
    // Certified only when the agent could not write the trusted paths and the
    // candidate is the one pinned from outside the consumer.
    certified: options.isolation === "os" && options.expectedPin !== null && options.expectedPin === installed.pin };
  if (options.isolation === "os") {
    const probe = await run({ ...isolated({ command: "true", argv: [] }, readOnly), cwd: root, timeoutMs: 30000 })
      .catch((error) => ({ code: 1, stderr: error.message }));
    if (probe.code !== 0) fail("ACCEPTANCE_PRECONDITION: OS isolation is unavailable here (unprivileged user, mount and PID " +
      "namespaces via unshare and setpriv): " + String(probe.stderr).trim() + ". Rerun with --isolation none for " +
      "functional evidence that is NOT security-certified.");
  }
  report.startedAt = new Date().toISOString();
  const agent = await run({ ...(options.isolation === "os" ? isolated(invocationCommand, readOnly) : invocationCommand),
    cwd: root, timeoutMs: options.timeoutMs });
  await writeFile(path.join(output, "agent.stdout.log"), agent.stdout);
  await writeFile(path.join(output, "agent.stderr.log"), agent.stderr);
  const combined = agent.stdout + "\n" + agent.stderr;
  report.agent = { exitCode: agent.code, signal: agent.signal, timedOut: agent.timedOut, overflow: agent.overflow,
    transcriptSha256: createHash("sha256").update(combined).digest("hex") };
  if (await readFile(markerPath, "utf8") !== markerBytes)
    fail("Agent modified the pinned acceptance marker (transcripts preserved)");
  if (createHash("sha256").update(await readFile(verifier)).digest("hex") !== verifierSha256)
    fail("Independent verifier changed during the agent run (transcripts preserved)");
  if (await treeDigest(skills) !== skillsBefore)
    fail("Agent modified the installed skills (transcripts preserved)");
  if (await readFile(receiptPath, "utf8") !== receiptBytes)
    fail("Agent modified the installed runtime receipt (transcripts preserved)");
  try {
    await verifyBundle(installed.release, installed.pin);
  } catch (error) {
    fail("Agent left the installed runtime bundle modified or invalid (transcripts preserved): " + error.message);
  }
  const cli = installed.commands["artifact-migration-discover"];
  const statusRun = await run({ command: cli[0], argv: [...cli.slice(1), options.target, "--status"],
    cwd: root, timeoutMs: 120000 });
  await writeFile(path.join(output, "engine-status.stdout.log"), statusRun.stdout);
  await writeFile(path.join(output, "engine-status.stderr.log"), statusRun.stderr);
  if (statusRun.code !== 0) fail("Engine status failed after agent invocation; logs preserved");
  const status = JSON.parse(statusRun.stdout);
  const state = JSON.parse(await readFile(record, "utf8"));
  report.engine = { currentStep: status.currentStep, state: status.status, revision: state.revision,
    progressAvailable: typeof status.progressChecklist === "string" && status.progressChecklist.length > 0 };
  if (state.targetModule !== options.target || status.target !== options.target)
    fail("Migration record does not belong to the requested --target");
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
    presentation: { progressAppearsInAgentOutput: combined.includes("progress: " + options.module + " -> " + options.target),
      // This is NOT proof of native UI rendering; that needs a separate recording.
      nativeUiCertified: false },
    independentVerification: verified ? { exitCode: verified.code, timedOut: verified.timedOut,
      verifierSha256 } : null,
    verdict: agent.code !== 0 || agent.timedOut || agent.overflow ? "FAIL" :
      options.goal === "bootstrap" ? (bootstrapped ? "BOOTSTRAP_PASS" : "FAIL") :
      finished && verified?.code === 0 && !verified.timedOut && status.progressChecklist ?
        "E2E_COMPLETE_PASS" : "FAIL" });
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}

main().catch(error => { console.error("AGENT_ACCEPTANCE_ERROR:", error.message); process.exitCode = 1; });
