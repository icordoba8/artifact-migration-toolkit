#!/usr/bin/env node
/**
 * Black-box acceptance using a REAL provider CLI, not an LLM-free fixture.
 *
 * Run only inside a disposable, isolated consumer with provider credentials.
 * This harness never edits a skill, registry, lock, or migration artifact.
 * Its single agent invocation gets no rescue prompt. The installed engine
 * decides whether the migration is complete.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const fail = (message) => { throw new Error(message); };
const argsOf = (argv) => {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!["--provider", "--cwd", "--module", "--target", "--output", "--timeout-minutes", "--goal"].includes(name) || !argv[i + 1] || name in options)
      fail("Expected unique --provider, --cwd, --module, --target, --output and optional --timeout-minutes arguments");
    options[name] = argv[i + 1];
  }
  for (const required of ["--provider", "--cwd", "--module", "--target", "--output"]) if (!options[required]) fail("Missing " + required);
  if (!["claude", "codex", "opencode"].includes(options["--provider"])) fail("Unsupported provider");
  for (const key of ["--module", "--target"]) if (!/^[a-z][a-z0-9-]*$/.test(options[key])) fail("Unsafe " + key);
  const goal = options["--goal"] ?? "bootstrap";
  if (!["bootstrap", "complete"].includes(goal)) fail("Goal must be bootstrap or complete");
  const minutes = options["--timeout-minutes"] === undefined ? 50 : Number(options["--timeout-minutes"]);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 90) fail("Timeout must be between 1 and 90 minutes");
  return { provider: options["--provider"], cwd: path.resolve(options["--cwd"]), module: options["--module"],
    target: options["--target"], goal, output: path.resolve(options["--output"]), timeoutMs: minutes * 60000 };
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

// Each host's headless permission model, granting only the installed
// registration and the consumer's own state directory -- never a sandbox bypass.
const commandFor = (provider, invocation, root) => {
  const ask = "Invoke the installed start-migration skill with exactly these arguments: " +
    invocation + ". Follow its existing contract; do not repair or modify the installed toolkit.";
  if (provider === "claude") return { command: "claude",
    argv: ["--print", invocation, "--output-format", "stream-json", "--verbose",
      "--mcp-config", ".mcp.json", "--permission-mode", "acceptEdits",
      "--allowedTools", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "mcp__start-migration"] };
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
  const invocationCommand = commandFor(options.provider, invocation, root);
  const skills = path.join(root, SKILL_DIRS[options.provider]);
  const skillsBefore = await treeDigest(skills);
  const startedAt = new Date().toISOString();
  const agent = await run({ ...invocationCommand, cwd: root, timeoutMs: options.timeoutMs });
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "agent.stdout.log"), agent.stdout);
  await writeFile(path.join(output, "agent.stderr.log"), agent.stderr);
  if (await readFile(markerPath, "utf8") !== markerBytes)
    fail("Agent modified the pinned acceptance marker (transcripts preserved)");
  if (createHash("sha256").update(await readFile(verifier)).digest("hex") !== verifierSha256)
    fail("Independent verifier changed during the agent run (transcripts preserved)");
  if (await treeDigest(skills) !== skillsBefore)
    fail("Agent modified the installed skills (transcripts preserved)");
  // The receipt is produced by the real skill runtime, never by this harness.
  const receipt = JSON.parse(await readFile(path.join(root, ".artifact-migration-tools",
    options.provider + ".json"), "utf8"));
  const cli = receipt.commands?.["artifact-migration-discover"];
  if (!Array.isArray(cli) || cli.length < 2 || !path.isAbsolute(cli[0]) || !path.isAbsolute(cli[1]))
    fail("Installed receipt did not provide a verified absolute discover command");
  const statusRun = await run({ command: cli[0], argv: [...cli.slice(1), options.target, "--status"],
    cwd: root, timeoutMs: 120000 });
  await writeFile(path.join(output, "engine-status.stdout.log"), statusRun.stdout);
  await writeFile(path.join(output, "engine-status.stderr.log"), statusRun.stderr);
  if (statusRun.code !== 0) fail("Engine status failed after agent invocation; logs preserved");
  const status = JSON.parse(statusRun.stdout);
  const state = JSON.parse(await readFile(record, "utf8"));
  if (state.targetModule !== options.target || status.target !== options.target)
    fail("Migration record does not belong to the requested --target");
  const finished = state.currentStep === "COMPLETE" && status.currentStep === "COMPLETE";
  const bootstrapped = state.completedSteps?.includes("RESOLVE") &&
    status.progressChecklist?.includes("DISCOVER_LEGACY") && status.currentStep !== "RESOLVE";
  const verified = finished ? await run({
    command: process.execPath, argv: [verifier, root], cwd: root, timeoutMs: 300000,
  }) : null;
  if (verified) {
    await writeFile(path.join(output, "independent-verify.stdout.log"), verified.stdout);
    await writeFile(path.join(output, "independent-verify.stderr.log"), verified.stderr);
  }
  const combined = agent.stdout + "\n" + agent.stderr;
  const report = {
    schemaVersion: 1, provider: options.provider, module: options.module, target: options.target, goal: options.goal,
    startedAt, completedAt: new Date().toISOString(), invocation, toolkit: receipt.toolkit ?? null,
    agent: { exitCode: agent.code, signal: agent.signal, timedOut: agent.timedOut, overflow: agent.overflow,
      transcriptSha256: createHash("sha256").update(combined).digest("hex") },
    engine: { currentStep: status.currentStep, state: status.status, revision: state.revision,
      progressAvailable: typeof status.progressChecklist === "string" && status.progressChecklist.length > 0 },
    presentation: { progressAppearsInAgentOutput: combined.includes("progress: " + options.module + " -> " + options.target),
      // This is NOT proof of native UI rendering; that needs a separate recording.
      nativeUiCertified: false },
    independentVerification: verified ? { exitCode: verified.code, timedOut: verified.timedOut,
      verifierSha256 } : null,
    verdict: agent.code !== 0 || agent.timedOut || agent.overflow ? "FAIL" :
      options.goal === "bootstrap" ? (bootstrapped ? "BOOTSTRAP_PASS" : "FAIL") :
      finished && verified?.code === 0 && !verified.timedOut && status.progressChecklist ?
        "E2E_COMPLETE_PASS" : "FAIL",
  };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ output, verdict: report.verdict, currentStep: report.engine.currentStep,
    progressDisplayed: report.presentation.progressAppearsInAgentOutput }, null, 2) + "\n");
  if (!["BOOTSTRAP_PASS", "E2E_COMPLETE_PASS"].includes(report.verdict)) process.exitCode = 1;
}

main().catch(error => { console.error("AGENT_ACCEPTANCE_ERROR:", error.message); process.exitCode = 1; });
