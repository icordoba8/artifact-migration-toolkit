import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildRelease } from "../scripts/release.mjs";
import { CODEX_MCP_TOOLS, commandFor, acceptanceVerdict, run, isolated, installedGrants } from "../scripts/agent-e2e-acceptance.mjs";
import { candidateReleaseRoot } from "../packages/migration-engine/test/support/candidate-release-root.mjs";
import "./support/ledger-observer-tests.mjs";

import { checkpoint, verifyCheckpoint, snapshotTree, sameTree, openspecLeads, startLockHolder, sha256, codexRollout, findCodexRollout } from '../scripts/acceptance-evidence.mjs';
import { acquireModuleLock, lockPathFor } from '../packages/migration-engine/src/lifecycle/index.mjs';

const script = new URL("../scripts/agent-e2e-acceptance.mjs", import.meta.url);
// The runner refuses evidence inside TMPDIR, so runner children get their own TMPDIR; test roots live beside it.
const scratch = os.tmpdir();
process.env.TMPDIR = mkdtempSync(path.join(scratch, "agent-e2e-child-tmp-"));
after(() => rmSync(process.env.TMPDIR, { recursive: true, force: true }));

// Harness-only MCP stand-in: the branch's real 1.6.4 transport ignores --without-relay.
// Agent lifecycle commands still use the real candidate engine.
const FAKE_MCP = `
import { createInterface } from 'node:readline';
let initialized = false;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'notifications/initialized') { initialized = true; continue; }
  const result = message.method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
    : initialized && message.method === 'tools/list'
      ? { tools: ${JSON.stringify(CODEX_MCP_TOOLS)}.concat(process.argv.includes('--without-relay') ? [] : ['migration_relay_decision']).map(name => ({ name })) }
      : null;
  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
}
`;

/** A disposable consumer with a genuinely built, verified candidate installed for opencode. */
const installedCandidate = async (root, verifierHome = root) => {
  const target = path.join(root, "target"), bin = path.join(root, "bin");
  await mkdir(path.join(target, ".opencode/skills"), { recursive: true });
  await mkdir(path.join(target, ".artifact-migration-tools"));
  await mkdir(bin);
  await mkdir(verifierHome, { recursive: true });
  const verifier = path.join(verifierHome, "verify.mjs");
  const verifierBytes = "process.exit(0);\n";
  await writeFile(verifier, verifierBytes);
  await writeFile(path.join(target, ".artifact-migration-acceptance.json"),
    JSON.stringify({ disposable: true, module: "auth", target: "auth", verifier,
      verifierSha256: createHash("sha256").update(verifierBytes).digest("hex") }));
  const candidate = await candidateReleaseRoot(root);
  await writeFile(path.join(candidate, "packages/migration-engine/src/mcp-server.mjs"), FAKE_MCP);
  const staged = await buildRelease({ root: candidate, force: true });
  const manifestBytes = await readFile(path.join(staged.stagingRoot, "release-manifest.json"));
  const pin = "sha256:" + createHash("sha256").update(manifestBytes).digest("hex");
  const store = path.join(root, "store");
  const release = path.join(store, "0.0.1-" + pin.slice(7));
  await mkdir(store);
  await cp(staged.stagingRoot, release, { recursive: true });
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const pkg = JSON.parse(await readFile(path.join(release, "packages/migration-engine/package.json"), "utf8"));
  const receiptPath = path.join(target, ".artifact-migration-tools/opencode.json");
  const receipt = JSON.stringify({ provider: "opencode", root: target, store, release, pin,
    toolkit: manifest.toolkit, commands: {
      "artifact-migrate": [process.execPath, path.join(release, "packages/migration-engine", pkg.bin["artifact-migrate"])],
      "artifact-migration-discover": [process.execPath,
        path.join(release, "packages/migration-engine", pkg.bin["artifact-migration-discover"])],
    } });
  await writeFile(receiptPath, receipt);
  return { target, bin, verifier, pin, release, receiptPath, receipt };
};

const installedArtifactCandidate = async root => {
  const installed = await installedCandidate(root);
  const { target } = installed;
  await mkdir(path.join(target, 'legacy'));
  await writeFile(path.join(target, 'legacy/source.js'), 'export const value = 1;\n');
  await writeFile(path.join(target, 'package.json'), '{"type":"module"}\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Disposable test fixture']])
    execFileSync('git', args, { cwd: target });
  const markerPath = path.join(target, '.artifact-migration-acceptance.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  Object.assign(marker, { kind: 'artifact', source: 'legacy/source.js', sourceRoot: target, artifactTarget: 'src/result.js' });
  await writeFile(markerPath, JSON.stringify(marker));
  return installed;
};
/**
 * A stand-in for Codex 0.165.0: writes a rollout in its format under $CODEX_HOME, prints thread.started (exec),
 * and runs FAKE_CODEX_CMD through bash -lc as one CommandExecution item. Native turns come from FAKE_CODEX_PROMPTS.
 */
const FAKE_CODEX = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.165.0'); process.exit(0); }
const id = require('node:crypto').randomUUID(), now = new Date().toISOString(), headless = args[0] === 'exec';
const dir = path.join(process.env.CODEX_HOME, 'sessions', now.slice(0, 10).replaceAll('-', '/'));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'rollout-' + now.replace(/[:.]/g, '-') + '-' + id + '.jsonl');
const log = (type, payload) => fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\\n');
const item = item => log('event_msg', { type: 'item_completed', item });
log('session_meta', { id, cwd: process.cwd(), timestamp: now });
if (headless) console.log(JSON.stringify({ type: 'thread.started', thread_id: id }));
else {
  if (process.stdin.isTTY) console.log('LOCAL_TEST_PTY_VISIBLE');
  if (args.some(arg => arg.startsWith('mcp_servers.start-migration.command='))) console.log('TRANSPORT_RESTATED');
}
for (const [index, text] of (headless ? [args.at(-1)] : JSON.parse(process.env.FAKE_CODEX_PROMPTS || '[]')).entries()) {
  log('event_msg', { type: 'task_started' });
  item({ type: 'UserMessage', content: [{ type: 'text', text }] });
  if (process.env.FAKE_CODEX_TEMPLATE_REFUSAL) item({
    type: 'McpToolCall', server: 'start-migration', tool: 'artifact_run', status: 'completed',
    result: { isError: true, content: [{ type: 'text', text: "EROFS: read-only file system, mkdir '/fixture'" }] }
  });
  if (index === 0 && process.env.FAKE_CODEX_CMD) {
    const run = spawnSync('/bin/bash', ['-lc', process.env.FAKE_CODEX_CMD], { encoding: 'utf8' });
    console.log(run.stdout + run.stderr);
    item({ type: 'CommandExecution', command: ['/bin/bash', '-lc', process.env.FAKE_CODEX_CMD], exit_code: run.status,
      aggregated_output: run.stdout + run.stderr, status: 'completed' });
  }
  log('event_msg', { type: 'task_complete' });
}
`;

/** The E7 installed Codex entry (`--without-relay` + enabled_tools) for a receipt's release. */
const codexEntry = (receipt, { server = 'mcp-server.mjs', tools = CODEX_MCP_TOOLS, withoutRelay = true } = {}) =>
  '# BEGIN artifact-migration-tools\n[mcp_servers.start-migration]\ncommand = ' + JSON.stringify(receipt.commands['artifact-migration-discover'][0]) +
  '\nargs = ' + JSON.stringify([path.join(receipt.release, 'packages/migration-engine/src', server), ...(withoutRelay ? ['--without-relay'] : [])]) +
  '\nenabled_tools = ' + JSON.stringify(tools) + '\n# END artifact-migration-tools\n';
/** The installed candidate as a Codex consumer, driven by FAKE_CODEX with its own CODEX_HOME. */
const codexCandidate = async (root, install = installedCandidate) => {
  const installed = await install(root);
  const receipt = JSON.parse(installed.receipt);
  receipt.provider = 'codex';
  await writeFile(path.join(installed.target, '.artifact-migration-tools/codex.json'), JSON.stringify(receipt));
  await mkdir(path.join(installed.target, '.agents/skills'), { recursive: true });
  await mkdir(path.join(installed.target, '.codex'));
  await writeFile(path.join(installed.target, '.codex/config.toml'), codexEntry(receipt));
  await writeFile(path.join(installed.bin, 'codex'), FAKE_CODEX, { mode: 0o755 });
  const quoted = name => receipt.commands[name].map(x => "'" + x + "'").join(' ');
  const env = { ...process.env, PATH: installed.bin + path.delimiter + process.env.PATH, CODEX_HOME: path.join(root, 'codex-home') };
  const runCodex = (output, argv, cmd, extraEnv = {}) => spawnSync(process.execPath, [script.pathname, '--provider', 'codex', '--cwd', installed.target,
    '--module', 'auth', '--target', 'auth', '--output', output, '--expected-pin', installed.pin, ...argv],
  { timeout: 90000, encoding: 'utf8', env: { ...env, FAKE_CODEX_CMD: cmd, ...extraEnv } });
  return { ...installed, receipt: JSON.stringify(receipt), quoted, env, runCodex };
};
// The engine under test: the joint candidate has refusal codes, a liveness token and mkdir errno recovery; 1.6.4 has none.
const codedEngine = (await readFile(new URL('../packages/migration-engine/src/store/files.mjs', import.meta.url), 'utf8')).includes('FS_ERRNO_UNKNOWN');
const registryUnboundEngine = (await readFile(new URL('../packages/migration-engine/src/store/registry.mjs', import.meta.url), 'utf8')).includes('REGISTRY_UNBOUND');
const codexReady = isolationAvailable => isolationAvailable && process.version === 'v22.13.0' ? false
  : 'requires unprivileged namespaces and Node 22.13.0 (the Codex preflight pin)';

const failRun = argv => {
  try {
    execFileSync(process.execPath, [script.pathname, ...argv], { encoding: "utf8", timeout: 10000, stdio: "pipe" });
    assert.fail("Acceptance should have refused invalid preconditions");
  } catch (error) {
    if (error.code === "ERR_ASSERTION") throw error;
    assert.notEqual(error.status, 0);
    return String(error.stderr);
  }
};

test("black-box acceptance refuses incomplete and invalid invocations", () => {
  assert.match(failRun([]), /Missing --provider/);
  assert.match(failRun(["--provider", "invalid", "--cwd", ".", "--module", "auth",
    "--target", "auth", "--output", "/tmp/acceptance"]), /Unsupported provider/);
  assert.match(failRun(["--provider", "codex", "--cwd", ".", "--module", "../auth",
    "--target", "auth", "--output", "/tmp/acceptance"]), /Unsafe --module/);
});

test("complete acceptance requires a pin from outside the consumer", () => {
  assert.match(failRun(["--provider", "opencode", "--cwd", ".", "--module", "auth",
    "--target", "auth", "--output", "/tmp/acceptance", "--goal", "complete"]),
    /requires --expected-pin/);
  assert.match(failRun(["--provider", "opencode", "--cwd", ".", "--module", "auth",
    "--target", "auth", "--output", "/tmp/acceptance", "--goal", "complete",
    "--expected-pin", "sha256:untrusted"]),
    /must be an exact SHA-256/);
});

test("black-box acceptance requires an explicitly disposable consumer", async () => {
  const root = await mkdtemp(path.join(scratch, "agent-e2e-negative-"));
  try {
    const argv = ["--provider", "codex", "--cwd", root, "--module", "auth",
      "--target", "auth", "--output", path.join(root, "../" + path.basename(root) + "-report")];
    assert.match(failRun([...argv.slice(0, -1), path.join(process.env.TMPDIR, "report")]), /Output must be outside TMPDIR/);
    assert.match(failRun(argv), /ENOENT/);
    const verifier = path.join(root, "trusted-verifier.mjs");
    await writeFile(verifier, "process.exit(0);\n");
    await writeFile(path.join(root, ".artifact-migration-acceptance.json"),
      JSON.stringify({ disposable: true, module: "auth", target: "auth", verifier,
        verifierSha256: createHash("sha256").update("process.exit(0);\n").digest("hex") }));
    await rm(argv.at(-1), { recursive: true, force: true });
    assert.match(failRun(argv), /verifier must reside OUTSIDE/);
    await rm(argv.at(-1), { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("black-box acceptance reports a missing installed runtime receipt", async () => {
  const root = await mkdtemp(path.join(scratch, "agent-e2e-no-receipt-"));
  try {
    const target = path.join(root, "target");
    await mkdir(target);
    const verifier = path.join(root, "verify.mjs");
    const data = "process.exit(0);\n";
    await writeFile(verifier, data);
    await writeFile(path.join(target, ".artifact-migration-acceptance.json"),
      JSON.stringify({ disposable: true, module: "auth", target: "auth", verifier,
        verifierSha256: createHash("sha256").update(data).digest("hex") }));
    assert.match(failRun(["--provider", "opencode", "--cwd", target, "--module", "auth",
      "--target", "auth", "--output", path.join(root, "reports")]),
      /ACCEPTANCE_PRECONDITION:.*runtime receipt is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("black-box acceptance refuses a changed independent verifier before agent execution", async () => {
  const root = await mkdtemp(path.join(scratch, "agent-e2e-pin-"));
  try {
    const target = path.join(root, "target");
    await mkdir(target);
    const verifier = path.join(root, "verify.mjs");
    await writeFile(verifier, "process.exit(0);\n");
    await writeFile(path.join(target, ".artifact-migration-acceptance.json"),
      JSON.stringify({ disposable: true, module: "auth", target: "auth", verifier,
        verifierSha256: "0".repeat(64) }));
    assert.match(failRun(["--provider", "claude", "--cwd", target, "--module", "auth",
      "--target", "auth", "--output", path.join(root, "reports")]), /verifier digest does not match/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("without OS isolation, a rewritten receipt or engine bundle is still caught after the run", async () => {
  const root = await mkdtemp(path.join(scratch, "agent-e2e-receipt-"));
  try {
    // A legitimate staged candidate is required: the runner verifies the
    // installed bundle BEFORE invoking the provider. Only the agent's write
    // after that preflight may be classified as a malicious mutation.
    const { target, bin, release, receiptPath, receipt } = await installedCandidate(root);
    const unisolated = (output, env = {}) => execFileSync(process.execPath, [script.pathname, "--provider", "opencode",
      "--cwd", target, "--module", "auth", "--target", "auth", "--output", path.join(root, output), "--isolation", "none"],
    { encoding: "utf8", timeout: 60000, stdio: "pipe", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ...env } });
    // Fake provider maliciously rewrites the installed receipt after preflight.
    await writeFile(path.join(bin, "opencode"), "#!/bin/sh\necho hacked > .artifact-migration-tools/opencode.json\n", { mode: 0o755 });
    assert.throws(() => unisolated("reports"), (error) => /modified the installed runtime receipt/.test(String(error.stderr)));
    const tampered = JSON.parse(await readFile(path.join(root, "reports/report.json"), "utf8"));
    assert.equal(tampered.verdict, "FAIL");
    assert.match(tampered.failure, /modified the installed runtime receipt/);
    assert.equal(tampered.agent.exitCode, 0);
    // Restore the verified receipt, then tamper with the actual engine bundle.
    // The independent pre/post manifest check must reject this run too.
    await writeFile(receiptPath, receipt);
    await writeFile(path.join(bin, "opencode"), '#!/bin/sh\nprintf x >> "$TEST_TAMPER_FILE"\n', { mode: 0o755 });
    assert.throws(() => unisolated("tamper-reports", { TEST_TAMPER_FILE: path.join(release, "packages/migration-engine/package.json") }),
      (error) => /installed runtime bundle modified or invalid/.test(String(error.stderr)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an agent that leaves no readable engine status still gets a fail-closed report", async () => {
  const root = await mkdtemp(path.join(scratch, "agent-e2e-no-status-"));
  try {
    const { target, bin } = await installedCandidate(root);
    // Exits 0 and creates no migration record, so the engine has no status to give. An engine that resolves the
    // (here absent) registry first exits 2 with BLOCKED/NOT_STARTED: typed as "nothing ran" (scoring change 2).
    const expected = registryUnboundEngine ? /ENGINE_BLOCKED_NOT_STARTED: the engine reports nothing ran \(Migration registry is not configured/
      : /Engine status failed/;
    await writeFile(path.join(target, "package.json"), '{"type":"module"}\n');
    await writeFile(path.join(bin, "opencode"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const output = path.join(root, "reports");
    assert.throws(() => execFileSync(process.execPath, [script.pathname, "--provider", "opencode", "--cwd", target,
      "--module", "auth", "--target", "auth", "--output", output, "--isolation", "none"],
    { encoding: "utf8", timeout: 60000, stdio: "pipe", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } }),
    (error) => expected.test(String(error.stderr)));
    const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
    assert.equal(report.verdict, "FAIL");
    assert.match(report.failure, expected);
    assert.equal(report.engine, undefined);
    assert.equal(report.independentVerification, undefined);
    assert.ok((await readFile(path.join(output, "engine-status.stderr.log"), "utf8")).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary first-time record directory creation is not a replacement event", async () => {
  const root = await mkdtemp(path.join(scratch, "agent-e2e-first-record-"));
  try {
    const { target, bin } = await installedCandidate(root);
    await writeFile(path.join(bin, "opencode"), [
      "#!/bin/sh",
      "mkdir -p .agents/knowledge/migrations/modules/auth",
      "printf first > .agents/knowledge/migrations/modules/auth/marker",
      "exit 0", "",
    ].join("\n"), { mode: 0o755 });
    const output = path.join(root, "reports");
    assert.throws(() => execFileSync(process.execPath, [script.pathname,
      "--provider", "opencode", "--cwd", target, "--module", "auth",
      "--target", "auth", "--output", output, "--isolation", "none"],
    { encoding: "utf8", timeout: 60000, stdio: "pipe",
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } }),
    (error) => /Engine status failed/.test(String(error.stderr)));
    const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
    assert.equal(report.verdict, "FAIL"); // fake provider did not bootstrap a real engine record
    assert.deepEqual(report.security.recordContinuity.violations, []);
    assert.equal(report.security.recordContinuity.targetDirectoryRenameEvents, 1);
    assert.equal(report.security.certified, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("record deletion and recreation is detected by a trusted observer and never certified", async () => {
  const root = await mkdtemp(path.join(scratch, "agent-e2e-record-continuity-"));
  try {
    const { target, bin } = await installedCandidate(root);
    // One normal bootstrap mkdir, a destructive rm -rf, and a forged bootstrap.
    // The real installed engine would treat the final record as new unless an
    // external observer witnessed the previous record's destruction.
    await writeFile(path.join(bin, "opencode"), [
      "#!/bin/sh",
      "mkdir -p .agents/knowledge/migrations/modules/auth",
      "printf first > .agents/knowledge/migrations/modules/auth/old",
      "rm -rf .agents/knowledge/migrations/modules/auth",
      "mkdir -p .agents/knowledge/migrations/modules/auth",
      "printf forged > .agents/knowledge/migrations/modules/auth/new",
      "exit 0", "",
    ].join("\n"), { mode: 0o755 });
    const output = path.join(root, "reports");
    assert.throws(() => execFileSync(process.execPath, [script.pathname,
      "--provider", "opencode", "--cwd", target, "--module", "auth",
      "--target", "auth", "--output", output, "--isolation", "none"],
    { encoding: "utf8", timeout: 60000, stdio: "pipe",
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } }),
    (error) => /ACCEPTANCE_RECORD_REPLACED|LEDGER_CHANGE/.test(String(error.stderr)));
    const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
    assert.equal(report.verdict, "FAIL");
    assert.equal(report.security.certified, false);
    assert.match(report.failure, /ACCEPTANCE_RECORD_REPLACED|LEDGER_CHANGE/);
    assert.ok(report.security.recordContinuity.targetDirectoryRenameEvents >= 2);
    assert.notEqual(report.security.recordContinuity.violations.length, 0);
    assert.equal(report.agent.exitCode, 0);
    assert.equal(report.engine, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const isolationAvailable = (() => {
  try {
    execFileSync("unshare", ["--user", "--map-current-user", "--keep-caps", "--mount", "--pid", "--fork", "--mount-proc", "--kill-child",
      "setpriv", "--no-new-privs", "--inh-caps=-all", "--bounding-set=-all", "--", "true"], { stdio: "ignore", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
})();

test("under OS isolation the agent cannot write the runtime, receipt, verifier or report, and nothing it starts outlives it",
  { skip: isolationAvailable ? false : "unprivileged user/mount/PID namespaces are unavailable on this host" }, async () => {
    const root = await mkdtemp(path.join(scratch, "agent-e2e-isolated-"));
    try {
      // A verifier in its own directory is sealed whole, dependencies included.
      const { target, bin, verifier, release, receiptPath, receipt, pin } = await installedCandidate(root, path.join(root, "verifier"));
      const dependency = path.join(root, "verifier", "driver.mjs");
      await writeFile(dependency, "export default 1;\n");
      const output = path.join(root, "reports");
      const engineFile = path.join(release, "packages/migration-engine/package.json");
      const engineBytes = await readFile(engineFile, "utf8");
      const canary = path.join(root, "late-write");
      const pnpmDir = path.join(root, "pnpm-run");
      await mkdir(pnpmDir);
      // unshare --map-current-user maps the effective IDs, so those are what the agent must see.
      const uid = process.geteuid(), gid = process.getegid();
      const attempt = (label, command) => `(${command}) 2>/dev/null && echo ${label}=WRITABLE >> observed || echo ${label}=DENIED >> observed`;
      await writeFile(path.join(bin, "opencode"), ["#!/bin/sh",
        attempt("receipt", "echo hacked > .artifact-migration-tools/opencode.json"),
        attempt("engine", `printf x >> '${engineFile}'`),
        attempt("verifier", `echo 'process.exit(0)' > '${verifier}'`),
        attempt("dependency", `echo 'export default 0;' > '${dependency}'`),
        attempt("report", `echo forged > '${output}/report.json'`),
        attempt("pnpm", `echo forged > '${pnpmDir}/pnpm'`),
        attempt("observer", `: >> '${fileURLToPath(new URL('../scripts/ledger-trace.py', import.meta.url))}'`),
        attempt("remount", `mount -o remount,bind,rw '${release}'`),
        // The agent's own identity, and the nested map a provider sandbox (bubblewrap) makes:
        // first its own UID as root, then back to that UID one level deeper.
        "awk '{print \"uid_map=\" $1 \" \" $2 \" \" $3}' /proc/$$/uid_map >> identity",
        "awk '{print \"gid_map=\" $1 \" \" $2 \" \" $3}' /proc/$$/gid_map >> identity",
        "grep -E '^(Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs):' /proc/$$/status | tr -d ' \\t' >> identity",
        `(unshare --user --map-root-user unshare --user --map-user=${uid} --map-group=${gid} true) 2>/dev/null ` +
          "&& echo nested=MAPPED >> identity || echo nested=REFUSED >> identity",
        `(sleep 1; echo late > '${canary}') &`, ""].join("\n"), { mode: 0o755 });
      assert.throws(() => execFileSync(process.execPath, [script.pathname, "--provider", "opencode", "--cwd", target,
        "--module", "auth", "--target", "auth", "--output", output, "--goal", "complete", "--expected-pin", pin],
      { encoding: "utf8", timeout: 60000, stdio: "pipe", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, AMT_PNPM_DIR: pnpmDir } }),
      // The fake agent creates no record, so the run fails afterwards -- but not on a tamper check.
      (error) => !/modified|Agent left/.test(String(error.stderr)));
      assert.deepEqual((await readFile(path.join(target, "observed"), "utf8")).trim().split("\n"),
        ["receipt=DENIED", "engine=DENIED", "verifier=DENIED", "dependency=DENIED", "report=DENIED", "pnpm=DENIED", "observer=DENIED", "remount=DENIED"]);
      // ponytail: map-root-user would read "uid_map=0 <uid> 1" and nested=REFUSED (EPERM without CAP_SETFCAP).
      assert.deepEqual((await readFile(path.join(target, "identity"), "utf8")).trim().split("\n"),
        [`uid_map=${uid} ${uid} 1`, `gid_map=${gid} ${gid} 1`, ...["Inh", "Prm", "Eff", "Bnd", "Amb"]
          .map((set) => `Cap${set}:0000000000000000`), "NoNewPrivs:1", "nested=MAPPED"]);
      assert.equal(await readFile(receiptPath, "utf8"), receipt);
      assert.equal(await readFile(engineFile, "utf8"), engineBytes);
      const blocked = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
      assert.equal(blocked.verdict, "FAIL");
      assert.equal(blocked.security.trustedRuntimeIsolated, true);
      assert.equal(blocked.security.certified, false);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await assert.rejects(readFile(canary), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("OS-isolated agent deleting and recreating its migration record cannot obtain certification",
  { skip: isolationAvailable ? false : "unprivileged user/mount/PID namespaces are unavailable on this host" }, async () => {
    const root = await mkdtemp(path.join(scratch, "agent-e2e-isolated-reset-"));
    try {
      const { target, bin, pin } = await installedCandidate(root, path.join(root, "verifier"));
      await writeFile(path.join(bin, "opencode"), [
        "#!/bin/sh",
        "mkdir -p .agents/knowledge/migrations/modules/auth",
        "printf original > .agents/knowledge/migrations/modules/auth/first",
        "rm -rf .agents/knowledge/migrations/modules/auth",
        "mkdir -p .agents/knowledge/migrations/modules/auth",
        "printf replacement > .agents/knowledge/migrations/modules/auth/second",
        "exit 0", "",
      ].join("\n"), { mode: 0o755 });
      const output = path.join(root, "reports");
      assert.throws(() => execFileSync(process.execPath, [script.pathname,
        "--provider", "opencode", "--cwd", target, "--module", "auth",
        "--target", "auth", "--output", output, "--goal", "complete", "--expected-pin", pin],
      { encoding: "utf8", timeout: 60000, stdio: "pipe",
        env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } }),
      (error) => /ACCEPTANCE_RECORD_REPLACED|LEDGER_CHANGE/.test(String(error.stderr)));
      const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
      assert.equal(report.verdict, "FAIL");
      assert.equal(report.security.isolation, "OS_NAMESPACE");
      assert.equal(report.security.trustedRuntimeIsolated, true);
      assert.equal(report.security.certified, false);
      assert.match(report.failure, /ACCEPTANCE_RECORD_REPLACED|LEDGER_CHANGE/);
      assert.ok(report.security.recordContinuity.targetDirectoryRenameEvents >= 2);
      assert.equal(report.agent.exitCode, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("under OS isolation a verifier in a broad directory (an ancestor of HOME) seals its script and node_modules, not HOME",
  { skip: isolationAvailable ? false : "unprivileged user/mount/PID namespaces are unavailable on this host" }, async () => {
    const root = await mkdtemp(path.join(scratch, "agent-e2e-broad-"));
    try {
      const broad = path.join(root, "broad"), home = path.join(broad, "home");
      const { target, bin, verifier } = await installedCandidate(root, broad);
      const dependency = path.join(broad, "node_modules", "driver.mjs");
      await mkdir(path.dirname(dependency), { recursive: true });
      await writeFile(dependency, "export default 1;\n");
      await mkdir(home);
      const session = path.join(home, ".local/share/opencode/session.json");
      const attempt = (label, command) => `(${command}) 2>/dev/null && echo ${label}=WRITABLE >> observed || echo ${label}=DENIED >> observed`;
      await writeFile(path.join(bin, "opencode"), ["#!/bin/sh",
        attempt("session", `mkdir -p '${path.dirname(session)}' && echo '{}' > '${session}'`),
        attempt("verifier", `echo 'process.exit(0)' > '${verifier}'`),
        attempt("dependency", `echo 'export default 0;' > '${dependency}'`), ""].join("\n"), { mode: 0o755 });
      assert.throws(() => execFileSync(process.execPath, [script.pathname, "--provider", "opencode", "--cwd", target,
        "--module", "auth", "--target", "auth", "--output", path.join(root, "reports")],
      { encoding: "utf8", timeout: 60000, stdio: "pipe", env: { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH } }),
      (error) => !/modified|Agent left/.test(String(error.stderr)));
      assert.deepEqual((await readFile(path.join(target, "observed"), "utf8")).trim().split("\n"),
        ["session=WRITABLE", "verifier=DENIED", "dependency=DENIED"]);
      assert.equal(await readFile(session, "utf8"), "{}\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("OS isolation refuses a UID-0 runner before the provider starts",
  { skip: isolationAvailable ? false : "unprivileged user/mount/PID namespaces are unavailable on this host" }, async () => {
    const root = await mkdtemp(path.join(scratch, "agent-e2e-uid0-"));
    try {
      const { target, bin, pin } = await installedCandidate(root, path.join(root, "verifier"));
      const started = path.join(root, "agent-started");
      await writeFile(path.join(bin, "opencode"), `#!/bin/sh\necho yes > '${started}'\n`, { mode: 0o755 });
      const output = path.join(root, "reports");
      // Namespace root stands in for a root launch: the runner then sees UID 0.
      assert.throws(() => execFileSync("unshare", ["--user", "--map-root-user", process.execPath, script.pathname,
        "--provider", "opencode", "--cwd", target, "--module", "auth", "--target", "auth", "--output", output,
        "--goal", "complete", "--expected-pin", pin],
      { encoding: "utf8", timeout: 60000, stdio: "pipe", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } }),
      (error) => /ACCEPTANCE_PRECONDITION: OS isolation refuses to run with a real or effective UID of 0/.test(String(error.stderr)));
      const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
      assert.equal(report.verdict, "FAIL");
      assert.equal(report.security.certified, false);
      await assert.rejects(readFile(started), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

// Simulated credentials: an --import shim makes process.geteuid() report 0 while
// the real UID stays the caller's own (non-root), the setuid-root launcher shape.
test("OS isolation refuses an effective UID 0 with a non-root real UID before the provider starts", async () => {
  const root = await mkdtemp(path.join(scratch, "agent-e2e-euid0-"));
  try {
    const { target, bin, pin } = await installedCandidate(root, path.join(root, "verifier"));
    const started = path.join(root, "agent-started");
    await writeFile(path.join(bin, "opencode"), `#!/bin/sh\necho yes > '${started}'\n`, { mode: 0o755 });
    const output = path.join(root, "reports");
    assert.throws(() => execFileSync(process.execPath, ["--import", "data:text/javascript,process.geteuid=()=>0",
      script.pathname, "--provider", "opencode", "--cwd", target, "--module", "auth", "--target", "auth",
      "--output", output, "--goal", "complete", "--expected-pin", pin],
    { encoding: "utf8", timeout: 60000, stdio: "pipe", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } }),
    (error) => /ACCEPTANCE_PRECONDITION: OS isolation refuses to run with a real or effective UID of 0/.test(String(error.stderr)));
    const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
    assert.equal(report.verdict, "FAIL");
    assert.equal(report.security.certified, false);
    await assert.rejects(readFile(started), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("black-box acceptance refuses an unverified installed engine before starting the agent", async () => {
  const root = await mkdtemp(path.join(scratch, "agent-e2e-bundle-"));
  try {
    const target = path.join(root, "target");
    const store = path.join(root, "store");
    await mkdir(target);
    await mkdir(path.join(target, ".opencode/skills"), { recursive: true });
    await mkdir(path.join(target, ".artifact-migration-tools"));
    const verifier = path.join(root, "verify.mjs");
    const verifierBytes = "process.exit(0);\n";
    await writeFile(verifier, verifierBytes);
    await writeFile(path.join(target, ".artifact-migration-acceptance.json"),
      JSON.stringify({ disposable: true, module: "auth", target: "auth", verifier,
        verifierSha256: createHash("sha256").update(verifierBytes).digest("hex") }));
    const manifestBytes = '{"toolkit":{"name":"forged"}}\n';
    const pin = "sha256:" + createHash("sha256").update(manifestBytes).digest("hex");
    const release = path.join(store, "0.0.1-" + pin.slice(7));
    await mkdir(release, { recursive: true });
    await writeFile(path.join(release, "release-manifest.json"), manifestBytes);
    await writeFile(path.join(target, ".artifact-migration-tools/opencode.json"),
      JSON.stringify({ provider: "opencode", root: target, store, release, pin,
        toolkit: { version: "0.0.1", name: "artifact-migration-tools" } }));
    const result = failRun(["--provider", "opencode", "--cwd", target, "--module", "auth",
      "--target", "auth", "--output", path.join(root, "reports")]);
    assert.match(result, /Invalid exact toolkit identity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex approves exactly the nine engine tools, per tool, keeps approval_policy never, and injects no tool filter", () => {
  const { argv } = commandFor("codex", "$start-migration discounts", "/consumer/target");
  const native = commandFor("codex", "$start-migration discounts", "/consumer/target", true, { command: "/node", args: ["/r/mcp-server.mjs", "--without-relay"] }).argv;
  // The installed server supplies the tool surface, headless and native.
  for (const command of [argv, native]) assert.doesNotMatch(command.join(" "), /enabled_tools|disabled_tools|\.tools=|--(?:allow|deny|available|excluded)-tools?/);
  assert.ok(native.includes('mcp_servers.start-migration.args=["/r/mcp-server.mjs","--without-relay"]'));
  const overrides = argv.filter((_, i) => argv[i - 1] === "-c");
  assert.deepEqual(overrides, [
    'projects={ "/consumer/target" = { trust_level = "trusted" } }', 'approval_policy="never"',
    ...CODEX_MCP_TOOLS.map((tool) => `mcp_servers.start-migration.tools.${tool}.approval_mode="approve"`),
    'mcp_servers.start-migration.env_vars=["pnpm_config_pm_on_fail"]', 'model_reasoning_effort="high"']);
  assert.equal(argv[argv.indexOf("-m") + 1], "gpt-6.1-sol");
  assert.deepEqual(CODEX_MCP_TOOLS, ["artifact_status", "artifact_run", "migration_status", "migration_scan",
    "migration_evidence_binding", "migration_prefill", "migration_capture", "migration_pending_decisions", "migration_run"]);
  // No server-wide default, no relay grant, no sandbox escalation, no other server.
  assert.doesNotMatch(argv.join(" "), /default_tools_approval_mode|migration_relay_decision|danger|bypass|mcp_servers\.(?!start-migration\.)/);
  assert.deepEqual(argv.slice(0, 6), ["exec", "--json", "--sandbox", "workspace-write", "--add-dir", "/consumer/target/.agents"]);
});

test("installed Codex and Copilot grants: effective nine proceeds, declared nine and legacy ten refuse before spawn",
  { skip: process.version === "v22.13.0" ? false : "requires the pinned Node 22.13.0 MCP executable" }, async () => {
  const root = await mkdtemp(path.join(scratch, "agent-e2e-grants-"));
  try {
    const { target, bin, receipt } = await installedCandidate(root);
    const parsed = JSON.parse(receipt);
    for (const host of ["codex", "copilot"])
      await writeFile(path.join(target, `.artifact-migration-tools/${host}.json`), JSON.stringify({ ...parsed, provider: host }));
    await mkdir(path.join(target, ".codex"));
    await mkdir(path.join(target, ".github"));
    const install = async (codex, copilot, legacy = false) => {
      const entry = codexEntry(parsed, { withoutRelay: codex });
      await writeFile(path.join(target, ".codex/config.toml"), legacy ? entry.replace(/^enabled_tools = .*\n/m, "") : entry);
      await writeFile(path.join(target, ".github/mcp.json"), JSON.stringify({ mcpServers: { "start-migration": {
        command: process.execPath, args: [path.join(parsed.release, "packages/migration-engine/src/mcp-server.mjs"), ...(copilot ? ["--without-relay"] : [])],
        tools: legacy ? ["*"] : CODEX_MCP_TOOLS,
      } } }));
    };
    const spawned = path.join(root, "spawned");
    await writeFile(path.join(bin, "opencode"), `#!/bin/sh\ntouch '${spawned}'\n`, { mode: 0o755 });
    const runner = (output) => spawnSync(process.execPath, [script.pathname, "--provider", "opencode", "--cwd", target, "--module", "auth",
      "--target", "auth", "--output", path.join(root, output), "--isolation", "none"],
    { encoding: "utf8", timeout: 60000, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
    for (const legacy of [false, true]) for (const [host, codex, copilot] of [["codex", false, true], ["copilot", true, false]]) {
      await install(codex, copilot, legacy);
      assert.match(runner(host + "-ten-" + legacy).stderr, new RegExp(`ACCEPTANCE_INSTALLED_GRANTS: installed ${host} start-migration grants are 10 `));
      await assert.rejects(stat(spawned), { code: "ENOENT" });
    }
    await install(true, true);
    // A relay-bearing .mcp.json must shadow the safe .github/mcp.json.
    const shadow = JSON.parse(await readFile(path.join(target, ".github/mcp.json"), "utf8"));
    shadow.mcpServers["start-migration"].args.pop();
    await writeFile(path.join(target, ".mcp.json"), JSON.stringify(shadow));
    assert.match(runner("shadow").stderr, /ACCEPTANCE_INSTALLED_GRANTS: installed copilot.*grants are 10/);
    await assert.rejects(stat(spawned), { code: "ENOENT" });
    await rm(path.join(target, ".mcp.json"));
    // Nine advertised tools are insufficient when the provider narrows the effective surface.
    for (const filter of ["enabled_tools", "disabled_tools", "copilot", "malformed"]) {
      await install(true, true);
      const codexFile = path.join(target, ".codex/config.toml");
      if (filter === "copilot") {
        const file = path.join(target, ".github/mcp.json");
        const config = JSON.parse(await readFile(file, "utf8"));
        config.mcpServers["start-migration"].tools = ["artifact_status"];
        await writeFile(file, JSON.stringify(config));
      } else {
        const config = (await readFile(codexFile, "utf8")).replace(/^enabled_tools = .*\n/m, "");
        await writeFile(codexFile, config +
          (filter === "malformed" ? 'disabled_tools = "migration_run"\n'
            : `${filter}=${JSON.stringify([filter === "enabled_tools" ? "artifact_status" : "migration_run"])}\n`));
      }
      assert.match(runner("filtered-" + filter).stderr, /ACCEPTANCE_INSTALLED_GRANTS/);
      await assert.rejects(stat(spawned), { code: "ENOENT" });
    }
    await install(true, true);
    assert.doesNotMatch(runner("nine").stderr, /ACCEPTANCE_INSTALLED_GRANTS/);
    await stat(spawned);
    // Probe this branch's actual legacy server too, not just the MCP stand-in.
    shadow.mcpServers["start-migration"].args = [fileURLToPath(new URL("../packages/migration-engine/src/mcp-server.mjs", import.meta.url))];
    await writeFile(path.join(target, ".mcp.json"), JSON.stringify(shadow));
    const probed = await installedGrants(target, "copilot");
    assert.ok(probed.advertised.includes("migration_relay_decision"));
    assert.deepEqual(probed.grants, CODEX_MCP_TOOLS);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the runner fails visibly on bad arguments run directly or through a symlink, and importing it runs nothing", async () => {
  const dir = await mkdtemp(path.join(scratch, "amt-entry-"));
  try {
    const link = path.join(dir, "acceptance.mjs");
    await symlink(fileURLToPath(script), link);
    for (const entry of [fileURLToPath(script), link]) {
      const run = spawnSync(process.execPath, [entry, "--bogus", "x"], { encoding: "utf8" });
      assert.equal(run.status, 1, entry);
      assert.match(run.stderr, /AGENT_ACCEPTANCE_ERROR: Expected unique --provider/, entry);
    }
    for (const scenario of ['read-only', 'live-lock', 'abandoned-lock']) {
      const run = spawnSync(process.execPath, [fileURLToPath(script), '--provider', 'opencode', '--cwd', dir, '--module', 'auth',
        '--target', 'auth', '--output', path.join(dir, 'out'), '--scenario', scenario], { encoding: 'utf8' });
      assert.match(run.stderr, /Refusal scenarios require --provider codex/, scenario);
    }
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const m = await import(${JSON.stringify(script.href)}); console.log(typeof m.commandFor);`], { encoding: "utf8" });
    assert.equal(imported.status, 0);
    assert.equal(imported.stdout, "function\n");
    assert.equal(imported.stderr, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("headless refuses substitute MCP servers before probing and detects changed registrations after the run",
  { skip: process.version === "v22.13.0" ? false : "requires the pinned Node 22.13.0 MCP executable" }, async () => {
  const root = await mkdtemp(path.join(scratch, "agent-e2e-transport-"));
  try {
    const { target, bin, receipt } = await installedCandidate(root);
    const parsed = JSON.parse(receipt);
    await mkdir(path.join(target, ".codex"));
    await mkdir(path.join(target, ".github"));
    const codexFile = path.join(target, ".codex/config.toml");
    const copilotFile = path.join(target, ".github/mcp.json");
    const shadowFile = path.join(target, ".mcp.json");
    for (const host of ["codex", "copilot"])
      await writeFile(path.join(target, `.artifact-migration-tools/${host}.json`), JSON.stringify({ ...parsed, provider: host }));
    const configs = new Map([
      [codexFile, codexEntry(parsed)],
      [copilotFile, JSON.stringify({ mcpServers: { "start-migration": {
        command: process.execPath, args: [path.join(parsed.release, "packages/migration-engine/src/mcp-server.mjs"), "--without-relay"],
        tools: CODEX_MCP_TOOLS,
      } } })],
    ]);
    const restore = async () => { for (const [file, bytes] of configs) await writeFile(file, bytes); };
    const started = path.join(root, "started");
    await writeFile(path.join(bin, "opencode"), `#!/bin/sh\ntouch '${started}'\n`, { mode: 0o755 });
    const runner = (name, isolation = "none") => spawnSync(process.execPath, [script.pathname, "--provider", "opencode",
      "--cwd", target, "--module", "auth", "--target", "auth", "--output", path.join(root, name), "--isolation", isolation],
    { encoding: "utf8", timeout: 60000, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
    const foreign = path.join(root, "foreign.mjs");
    await writeFile(foreign, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(started)}, 'probed');\n` + FAKE_MCP);
    for (const host of ["codex", "copilot"]) {
      await restore();
      if (host === "codex") await writeFile(codexFile, codexEntry(parsed, {
        server: path.relative(path.join(parsed.release, "packages/migration-engine/src"), foreign),
      }));
      else {
        const config = JSON.parse(configs.get(copilotFile));
        config.mcpServers["start-migration"].args[0] = foreign;
        await writeFile(copilotFile, JSON.stringify(config));
      }
      assert.match(runner("foreign-" + host).stderr, /not the verified release's MCP server/);
      await assert.rejects(stat(started), { code: "ENOENT" });
    }
    // A mutable alias of today's verified entry can be redirected after preflight without changing config bytes.
    const alias = path.join(root, "server-alias.mjs");
    await symlink(path.join(parsed.release, "packages/migration-engine/src/mcp-server.mjs"), alias);
    await restore();
    await writeFile(codexFile, codexEntry(parsed, {
      server: path.relative(path.join(parsed.release, "packages/migration-engine/src"), alias),
    }));
    assert.match(runner("mutable-server-alias").stderr, /not the verified release's MCP server/);
    await assert.rejects(stat(started), { code: "ENOENT" });
    await restore();
    await rm(codexFile);
    const configAlias = path.join(root, "aliased-config.toml");
    await writeFile(configAlias, configs.get(codexFile));
    await symlink(configAlias, codexFile);
    assert.match(runner("mutable-config-alias").stderr, /registration must not use a mutable symlink/);
    await assert.rejects(stat(started), { code: "ENOENT" });
    await rm(codexFile);
    for (const [i, file] of [codexFile, copilotFile, shadowFile].entries()) {
      await restore();
      await writeFile(path.join(bin, "opencode"), `#!/bin/sh\nprintf changed >> '${file}'\n`, { mode: 0o755 });
      assert.match(runner("changed-" + i).stderr, /ACCEPTANCE_REGISTRATION_CHANGED/);
      const report = JSON.parse(await readFile(path.join(root, "changed-" + i, "report.json")));
      assert.equal(report.verdict, "FAIL");
      assert.equal(report.rerunEligible, false);
    }
    await rm(shadowFile);
    if (isolationAvailable) {
      await restore();
      await writeFile(path.join(bin, "opencode"), '#!/bin/sh\n' + [codexFile, copilotFile].map(file =>
        `(printf changed >> '${file}') 2>/dev/null && echo WRITABLE || echo DENIED`).join('\n') + '\n', { mode: 0o755 });
      runner("sealed", "os");
      assert.equal(await readFile(path.join(root, "sealed/agent.stdout.log"), "utf8"), "DENIED\nDENIED\n");
      const report = JSON.parse(await readFile(path.join(root, "sealed/report.json")));
      for (const [file, bytes] of configs) {
        assert.ok(report.security.readOnly.includes(file));
        assert.equal(await readFile(file, "utf8"), bytes);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a substituted executable with matching receipt and registration is refused before spawn in both UIs", async () => {
  const root = await mkdtemp(path.join(scratch, "agent-e2e-executable-pin-"));
  try {
    const { target, bin, receipt, receiptPath, pin } = await installedCandidate(root);
    const parsed = JSON.parse(receipt);
    const started = path.join(root, "substitute-started");
    const executable = path.join(bin, "substitute-node");
    await writeFile(executable, `#!${process.execPath}\n` +
      `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'UNTRUSTED_EXECUTABLE_STARTED');\n`, { mode: 0o755 });
    for (const command of Object.values(parsed.commands)) command[0] = executable;
    await writeFile(receiptPath, JSON.stringify(parsed));
    await mkdir(path.join(target, ".codex"));
    await mkdir(path.join(target, ".github"));
    for (const host of ["codex", "copilot"]) {
      const hostReceipt = path.join(target, `.artifact-migration-tools/${host}.json`);
      await writeFile(hostReceipt, JSON.stringify({ ...parsed, provider: host }));
      if (host === "codex") await writeFile(path.join(target, ".codex/config.toml"), codexEntry(parsed));
      else await writeFile(path.join(target, ".github/mcp.json"), JSON.stringify({ mcpServers: { "start-migration": {
        command: executable, args: [path.join(parsed.release, "packages/migration-engine/src/mcp-server.mjs"), "--without-relay"],
        tools: CODEX_MCP_TOOLS,
      } } }));
      for (const ui of host === "codex" ? ["headless", "native"] : ["headless"]) {
        const output = path.join(root, host + "-" + ui);
        const result = spawnSync(process.execPath, [script.pathname, "--provider", host === "codex" ? "codex" : "opencode",
          "--cwd", target, "--module", "auth", "--target", "auth", "--output", output, "--ui", ui, "--expected-pin", pin],
        { encoding: "utf8", timeout: 60000 });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /ACCEPTANCE_MCP_EXECUTABLE:.*independently pinned Node 22.13.0/);
        assert.equal(JSON.parse(await readFile(path.join(output, "report.json"))).agent, undefined);
        await assert.rejects(stat(started), { code: "ENOENT" });
      }
      await rm(hostReceipt);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('artifact acceptance uses the installed artifact CLI and independent verifier pin', async () => {
  const root = await mkdtemp(path.join(scratch, 'agent-e2e-artifact-'));
  try {
    const consumer = await installedArtifactCandidate(root), { target, verifier } = consumer;
    // The fake agent runs the installed artifact CLI, then any extra shell.
    const artifactRun = async ({ target, bin, receipt }, output, extra = '') => {
      await writeFile(path.join(bin, 'opencode'), '#!/bin/sh\n' + JSON.parse(receipt).commands['artifact-migrate'].map(x => "'" + x + "'").join(' ') +
        ' legacy/source.js --target src/result.js --mode auto --json\n' + extra, { mode: 0o755 });
      return spawnSync(process.execPath, [script.pathname, '--provider', 'opencode', '--cwd', target, '--module', 'auth', '--target', 'auth',
        '--output', output, '--kind', 'artifact', '--source', 'legacy/source.js', '--source-root', target, '--artifact-target', 'src/result.js',
        '--isolation', 'none'], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
    };
    const output = path.join(root, 'reports');
    await artifactRun(consumer, output);
    const report = JSON.parse(await readFile(path.join(output, 'report.json')));
    assert.equal(report.verdict, 'BOOTSTRAP_PASS');
    assert.match(report.record, /artifacts\/source-/);
    assert.match(report.invocation, /^\/migrate-artifact /);
    assert.equal(report.engine.currentStep, 'DISCOVER_LEGACY');
    assert.equal(report.presentation.progressAppearsInAgentOutput, true);
    assert.equal(report.security.certified, false);
    assert.equal(report.independentVerification, null); // Bootstrap must not call the verifier or claim completion.
    assert.equal(report.presentation.nativeUiCertified, false);
    assert.equal(report.openspec.status, 'NOT_TESTED');
    assert.equal(report.decisionLedgers.verdict, null);
    // A9: a decision line forged by plain file I/O during a scored run is a functional FAIL, never rerun.
    const forgedRun = await artifactRun(await installedArtifactCandidate(path.join(root, 'forged')), path.join(root, 'forged-report'),
      'for d in .agents/knowledge/migrations/artifacts/*/; do mkdir -p "$d/decisions"; ' +
      'echo \'{"id":"DEC-forged","principal":"AGENT_RELAYED","decision":"APPROVE"}\' >> "$d/decisions/operator-decisions.ndjson"; done\n');
    const forgedReport = JSON.parse(await readFile(path.join(root, 'forged-report/report.json')));
    assert.equal(forgedRun.status, 1);
    assert.equal(forgedReport.verdict, 'FAIL');
    assert.match(forgedReport.failure, /^LEDGER_CHANGE/);
    assert.equal(forgedReport.rerunEligible, false);
    assert.match(await readFile(path.join(root, 'forged-report/ledger-observer.json'), 'utf8'), /AGENT_RELAYED/);
    await writeFile(verifier, 'process.exit(1);');
    const second = await artifactRun(consumer, path.join(root, 'second'));
    assert.match(second.stderr, /verifier digest does not match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('A9 scored invocation rejects every ledger change, including forged legacy human decisions', async t => {
  for (const mutation of ['restore', 'rapid-restore', 'replace', 'engine-append', 'legacy-human', 'relay', 'other-line']) await t.test(mutation, async () => {
    const root = await mkdtemp(path.join(scratch, 'agent-e2e-ledger-'));
    try {
      const { target, bin, receipt, release } = await installedArtifactCandidate(root);
      const ledger = path.join(target, '.agents/knowledge/migrations/modules/other/decisions/operator-decisions.ndjson');
      await mkdir(path.dirname(ledger), { recursive: true });
      await writeFile(ledger, '');
      const program = `
        import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
        const ledger = ${JSON.stringify(ledger)};
        const { buildDecision, readOperatorDecisions } = await import(${JSON.stringify(path.join(release, 'packages/migration-engine/src/decisions/index.mjs'))});
        const fixture = { previous: null, kind: 'EXCLUSION', subjectType: 'FILE', subject: 'fixture.js',
          statement: 'Disposable test fixture only', rationale: 'Observer regression', operator: 'test-fixture',
          boundTo: { module: 'other', legacyRevision: 'fixture', discoveryDigest: 'sha256:fixture', algorithmVersion: 1 } };
        const relay = JSON.stringify(buildDecision({ ...fixture, principal: 'AGENT_RELAYED', result: 'APPROVED',
          candidateId: 'fixture-candidate', candidateDigest: 'sha256:' + '0'.repeat(64) })) + '\\n';
        if (${JSON.stringify(mutation)} === 'engine-append') {
          const { appendDurably } = await import(${JSON.stringify(path.join(release, 'packages/migration-engine/src/store/index.mjs'))});
          await appendDurably(${JSON.stringify(target)}, ledger, JSON.stringify(buildDecision(fixture)) + '\\n');
          if ((await readOperatorDecisions(${JSON.stringify(path.dirname(path.dirname(ledger)))})).decisions.length !== 1)
            throw new Error('engine did not accept the non-relay line');
        } else if (${JSON.stringify(mutation)} === 'legacy-human') {
          appendFileSync(ledger, JSON.stringify(buildDecision(fixture)) + '\\n');
          const read = await readOperatorDecisions(${JSON.stringify(path.dirname(path.dirname(ledger)))});
          if (read.decisions.length !== 1 || read.decisions[0].v !== undefined) throw new Error('not a legacy human decision');
        } else if (${JSON.stringify(mutation)} === 'relay') {
          appendFileSync(ledger, relay);
        } else if (${JSON.stringify(mutation)} === 'other-line') {
          appendFileSync(ledger, '{"unrecognized":"line"}\\n');
        } else if (${JSON.stringify(mutation)} === 'replace') {
          writeFileSync(ledger + '.new', '');
          renameSync(ledger + '.new', ledger);
        } else {
          appendFileSync(ledger, relay);
          if (!readFileSync(ledger, 'utf8').includes('AGENT_RELAYED')) throw new Error('relay not available for use');
          if (${JSON.stringify(mutation)} === 'restore') {
            const read = await readOperatorDecisions(${JSON.stringify(path.dirname(path.dirname(ledger)))});
            if (read.decisions[0]?.principal !== 'AGENT_RELAYED') throw new Error('engine did not read relay');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          writeFileSync(ledger, '');
        }
      `;
      const action = path.join(root, 'mutation.mjs');
      await writeFile(action, program);
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      await writeFile(path.join(bin, 'opencode'), '#!/bin/sh\nset -e\n' +
        JSON.parse(receipt).commands['artifact-migrate'].map(quote).join(' ') +
        ' legacy/source.js --target src/result.js --mode auto --json\n' +
        [process.execPath, action].map(quote).join(' ') + '\n', { mode: 0o755 });
      const output = path.join(root, 'report');
      const result = spawnSync(process.execPath, [script.pathname, '--provider', 'opencode', '--cwd', target,
        '--module', 'auth', '--target', 'auth', '--output', output, '--kind', 'artifact', '--source', 'legacy/source.js',
        '--source-root', target, '--artifact-target', 'src/result.js', '--isolation', 'none'],
      { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
      const report = JSON.parse(await readFile(path.join(output, 'report.json')));
      assert.equal(result.status, 1, report.failure ?? result.stderr);
      assert.equal(report.verdict, 'FAIL');
      assert.match(report.failure, /^LEDGER_CHANGE:/);
      assert.equal(report.rerunEligible, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test('A9 scored invocation fails when its outside-sandbox ledger observer dies during execution', async () => {
  const root = await mkdtemp(path.join(scratch, 'agent-e2e-watcher-failure-'));
  let completed;
  try {
    const { target, bin, receipt } = await installedArtifactCandidate(root);
    const marker = path.join(target, '.agent-running');
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(path.join(bin, 'opencode'), '#!/bin/sh\nset -e\n' +
      JSON.parse(receipt).commands['artifact-migrate'].map(quote).join(' ') +
      ' legacy/source.js --target src/result.js --mode auto --json\n' +
      'touch ' + quote(marker) + '\nsleep 2\n', { mode: 0o755 });
    const output = path.join(root, 'report');
    let child;
    completed = new Promise(resolve => {
      child = execFile(process.execPath, [script.pathname, '--provider', 'opencode', '--cwd', target,
        '--module', 'auth', '--target', 'auth', '--output', output, '--kind', 'artifact', '--source', 'legacy/source.js',
        '--source-root', target, '--artifact-target', 'src/result.js', '--isolation', 'none'],
      { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } },
      error => resolve(error?.code ?? 0));
    });
    const deadline = Date.now() + 30000;
    while (!await stat(marker).catch(() => null) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(await stat(marker).catch(() => null), 'provider did not reach its execution window');
    const children = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).trim().split(/\s+/);
    let killed = false;
    for (const pid of children) {
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0');
      if (argv.some(arg => arg.endsWith('/ledger-observer.py'))) {
        process.kill(Number(pid), 'SIGKILL');
        killed = true;
      }
    }
    assert.equal(killed, true, 'trusted observer was not a separate harness child');
    assert.equal(await completed, 1);
    const report = JSON.parse(await readFile(path.join(output, 'report.json')));
    assert.equal(report.verdict, 'FAIL');
    assert.match(report.failure, /^LEDGER_CHANGE:/);
    assert.equal(report.rerunEligible, false);
  } finally {
    await completed;
    await rm(root, { recursive: true, force: true });
  }
});

test('classifier: only engine tool results carry refusal codes; structured codes win; rollouts bind to their thread', async () => {
  const engine = ['/opt/node', '/store/r/src/cli/run.mjs'];
  const mcpFailed = message => ({ type: 'McpToolCall', server: 'start-migration', tool: 'migration_run', status: 'failed',
    error: { message: 'tool call error: tool call failed for `start-migration/migration_run`\n\nCaused by:\n    Mcp error: -32603: ' + message } });
  const shell = (line, exit_code, aggregated_output) => ({ type: 'CommandExecution', command: ['/bin/bash', '-lc', line], exit_code, aggregated_output, status: 'completed' });
  const held = "Another migration command holds the lock for 'auth' at /c/locks/auth.lock (pid 7). Wait for it to finish; the lock is reclaimed automatically once that process is gone.";
  const items = [
    mcpFailed(held),                                                                              // MCP template
    { type: 'McpToolCall', server: 'start-migration', tool: 'migration_run', status: 'completed',  // MCP structured (E6)
      result: { isError: true, content: [{ type: 'text', text: 'x' }], structuredContent: { code: 'LOCK_HELD' } } },
    shell("'/opt/node' '/store/r/src/cli/run.mjs' auth 2>&1", 1, "EROFS: read-only file system, access '/c/.agents'\n"),
    shell("/opt/node /store/r/src/cli/run.mjs auth", 2, '{\n  "outcome": "BLOCKED",\n  "status": "NOT_STARTED"\n}\n'),
    shell('/opt/node /store/r/src/cli/run.mjs auth', 1, "Cannot create '/c/x': mkdir reported ENOENT and no syscall recovered the real cause.\n"),
    shell("echo 'EROFS: read-only file system, mkdir ' /x", 1, "EROFS: read-only file system, mkdir '/x'\n"),           // echo
    shell("/opt/node /store/r/src/cli/run.mjs auth | cat", 1, "EROFS: read-only file system, mkdir '/x'\n"),           // pipe
    shell('bwrap --ro-bind / / true', 1, "bwrap: EROFS: read-only file system, mkdir '/x'\n"),                       // sandbox line
    shell('/opt/node /store/r/src/cli/run.mjs auth', 0, "EROFS: read-only file system, mkdir '/x'\n"),             // exit 0
    { ...mcpFailed(held), server: 'playwright' },                                                                    // other server
    { type: 'AgentMessage', content: [{ type: 'text', text: held }] },                                               // prose
  ];
  const lines = [{ type: 'session_meta', payload: { id: 't1', cwd: '/c', timestamp: '2026-11-02T20:00:00.000Z' } },
    ...items.map(item => ({ type: 'event_msg', payload: { type: 'item_completed', item } }))].map(line => JSON.stringify(line));
  const rollout = codexRollout(lines.join('\n') + '\n', [engine]);
  assert.deepEqual(rollout.refusals.map(({ line, source, code, codeSource }) => [line, source, code, codeSource]), [
    [2, 'mcp', 'LOCK_HELD', 'template'], [3, 'mcp', 'LOCK_HELD', 'structured'], [4, 'cli', 'EROFS', 'template'],
    [5, 'cli', 'BLOCKED_NOT_STARTED', 'structured'], [6, 'cli', 'FS_ERRNO_UNKNOWN', 'template']]);
  assert.equal(rollout.refusals[0].sha256, sha256(lines[1]));
  assert.throws(() => codexRollout(lines[0] + '\n' + lines[0], [engine]), /more than one session/);
  const home = await mkdtemp(path.join(scratch, 'codex-home-'));
  try {
    await mkdir(path.join(home, 'sessions/2026/11/02'), { recursive: true });
    await writeFile(path.join(home, 'sessions/2026/11/02/rollout-2026-11-02T20-00-00-t1.jsonl'), lines.join('\n') + '\n');
    assert.equal((await findCodexRollout(home, { threadId: 't1', cwd: '/c' })).text, lines.join('\n') + '\n');
    await assert.rejects(findCodexRollout(home, { threadId: 't1', cwd: '/other' }), /another thread or consumer/);
    assert.equal(await findCodexRollout(home, { threadId: 't2', cwd: '/c' }), null);
    assert.equal((await findCodexRollout(home, { cwd: '/c', startedAt: '2026-11-02T19:59:00Z', endedAt: '2026-11-02T20:01:00Z' })).text.length > 0, true);
    assert.equal(await findCodexRollout(home, { cwd: '/c', startedAt: '2026-11-02T20:00:01Z', endedAt: '2026-11-02T20:01:00Z' }), null);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a run past --not-after starts nothing and is NOT_RUN; one rerun, on a fresh consumer only', async () => {
  const root = await mkdtemp(path.join(scratch, 'agent-e2e-deadline-'));
  try {
    const consumers = [];
    for (const name of ['first', 'fresh']) {
      const installed = await installedCandidate(path.join(root, name));
      await writeFile(path.join(installed.bin, 'opencode'), '#!/bin/sh\ntouch "$0.started"\n', { mode: 0o755 });
      consumers.push(installed);
    }
    const runAt = (consumer, output, extra, env = {}) => spawnSync(process.execPath, [script.pathname, '--provider', 'opencode', '--cwd', consumer.target,
      '--module', 'auth', '--target', 'auth', '--output', output, '--isolation', 'none', ...extra],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env, PATH: consumer.bin + path.delimiter + process.env.PATH } });
    const past = ['--not-after', '2000-01-01T00:00:00Z'];
    assert.match(runAt(consumers[0], path.join(root, 'bad'), ['--not-after', '2000-01-01 00:00']).stderr, /ISO-8601 UTC/);
    const late = runAt(consumers[0], path.join(root, 'late'), past);
    const report = JSON.parse(await readFile(path.join(root, 'late/report.json')));
    assert.equal(late.status, 1);
    assert.equal(report.verdict, 'NOT_RUN');
    assert.equal(report.notRun.reason, 'DEADLINE');
    assert.equal(report.rerunEligible, true);
    assert.equal(report.agent, undefined);
    assert.equal(await stat(path.join(consumers[0].bin, 'opencode.started')).catch(() => null), null);
    assert.equal(JSON.parse(late.stdout.trim().split('\n').at(-1)).verdict, 'NOT_RUN');
    // Two drivers racing for one output: one atomic reservation wins, the other writes nothing.
    const race = () => new Promise(resolve => execFile(process.execPath, [script.pathname, '--provider', 'opencode', '--cwd', consumers[0].target,
      '--module', 'auth', '--target', 'auth', '--output', path.join(root, 'race'), '--isolation', 'none', ...past],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: consumers[0].bin + path.delimiter + process.env.PATH } }, (error, stdout, stderr) => resolve(stderr)));
    const raced = await Promise.all([race(), race()]);
    assert.equal(raced.filter(stderr => /Output already exists/.test(stderr)).length, 1, raced.join('\n'));
    assert.equal(JSON.parse(await readFile(path.join(root, 'race/report.json'))).verdict, 'NOT_RUN');
    // Never on the same consumer.
    runAt(consumers[0], path.join(root, 'same'), [...past, '--rerun-of', path.join(root, 'late/report.json')]);
    assert.match(JSON.parse(await readFile(path.join(root, 'same/report.json'))).failure, /ACCEPTANCE_PRECONDITION: --rerun-of/);
    // The rerun binds the prior report and is never itself rerunnable.
    const rerun = runAt(consumers[1], path.join(root, 'rerun'), [...past, '--rerun-of', path.join(root, 'late/report.json')]);
    const rerunReport = JSON.parse(await readFile(path.join(root, 'rerun/report.json')));
    assert.equal(rerun.status, 1);
    assert.equal(rerunReport.verdict, 'NOT_RUN');
    assert.equal(rerunReport.rerunOf.sha256, sha256(await readFile(path.join(root, 'late/report.json'))));
    assert.equal(rerunReport.rerunEligible, false);
    const again = runAt(consumers[1], path.join(root, 'again'), ['--rerun-of', path.join(root, 'rerun/report.json')]);
    assert.equal(again.status, 1);
    assert.match(JSON.parse(await readFile(path.join(root, 'again/report.json'))).failure, /not itself a rerun/);
    // A launched run records the launcher identity it was given (A2), never a default.
    const base = 'b'.repeat(40);
    runAt(consumers[1], path.join(root, 'launched'), [], { AMT_BASE: base, AMT_HARNESS_COMMIT: 'c'.repeat(40), AMT_PATCH_SHA256: 'd'.repeat(64) });
    const { launch } = JSON.parse(await readFile(path.join(root, 'launched/report.json')));
    assert.deepEqual([launch.base, launch.harnessCommit, launch.patchSha256, launch.node], [base, 'c'.repeat(40), 'd'.repeat(64), process.version]);
    assert.ok(Date.parse(launch.startedAt) <= Date.parse(launch.endedAt));
    assert.ok(await stat(path.join(consumers[1].bin, 'opencode.started')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('read-only refusal is scored from a bound engine tool result, never from prose',
  { skip: codexReady(isolationAvailable) }, async () => {
    const root = await mkdtemp(path.join(scratch, 'agent-e2e-readonly-'));
    try {
      const { target, quoted, runCodex } = await codexCandidate(root, installedArtifactCandidate);
      const artifact = ['--kind', 'artifact', '--source', 'legacy/source.js', '--source-root', target, '--artifact-target', 'src/result.js'];
      const engine = quoted('artifact-migrate') + ' legacy/source.js --target src/result.js --mode auto --json';
      const output = path.join(root, 'report');
      const result = runCodex(output, [...artifact, '--scenario', 'read-only'], engine);
      const report = JSON.parse(await readFile(path.join(output, 'report.json')));
      assert.equal(report.scoring, 'scored');
      assert.equal(report.safety.codeSourceRequired, 'structured');
      assert.equal(report.safety.unchanged, true);
      if (codedEngine) {
        assert.equal(result.status, 0, JSON.stringify(report.safety));
        assert.equal(report.verdict, 'SAFETY_REFUSAL_PASS');
        assert.ok(['EROFS', 'EACCES', 'EPERM'].includes(report.safety.refusal.code), JSON.stringify(report.safety));
        assert.equal(report.safety.refusal.source, 'cli');
      } else {
        // 1.6.4 reports Node's recursive-mkdir ENOENT for a read-only mount: recorded, never normalized to a refusal.
        assert.equal(result.status, 1);
        assert.deepEqual(report.rollout.refusals.map(entry => entry.code), ['ENOENT']);
      }
      assert.ok(report.security.readOnly.includes(target));
      assert.equal(report.security.certified, false);
      assert.equal(report.rollout.sha256, sha256(await readFile(path.join(output, 'codex-rollout.jsonl'))));
      // The last stdout line is the driver summary, on every verdict.
      assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).report, path.join(output, 'report.json'));
      // Prose is not a refusal: an agent that only echoes the engine's message fails.
      const echoed = runCodex(path.join(root, 'echoed'), [...artifact, '--scenario', 'read-only'],
        "echo \"EROFS: read-only file system, mkdir '/x'\"; exit 1");
      const echoReport = JSON.parse(await readFile(path.join(root, 'echoed/report.json')));
      assert.equal(echoed.status, 1);
      assert.equal(echoReport.safety.refusalObserved, false);
      assert.match(echoReport.failure, /Safety refusal not proven/);
      assert.equal(JSON.parse(echoed.stdout.trim().split('\n').at(-1)).verdict, 'FAIL');
      // A3: a scored joint run requires the engine's structured code; a template match does not satisfy it.
      const strict = runCodex(path.join(root, 'strict'), [...artifact, '--scenario', 'read-only', '--code-source', 'structured'],
        engine);
      const strictReport = JSON.parse(await readFile(path.join(root, 'strict/report.json')));
      assert.equal(strictReport.safety.codeSourceRequired, 'structured');
      if (codedEngine) {
        // E6: the joint candidate's own structured code satisfies a structured-only run.
        assert.equal(strict.status, 0, JSON.stringify(strictReport.safety));
        assert.equal(strictReport.verdict, 'SAFETY_REFUSAL_PASS');
        assert.equal(strictReport.safety.refusal.codeSource, 'structured');
      } else {
        assert.equal(strict.status, 1);
        assert.equal(strictReport.safety.refusal, null);
        // Without E6 every engine refusal is template-matched, so a structured-only run cannot pass.
        assert.deepEqual(strictReport.rollout.refusals.map(entry => entry.codeSource), ['template']);
      }
      // An existing output directory, even empty, is never reused.
      await mkdir(path.join(root, 'taken'));
      const taken = runCodex(path.join(root, 'taken'), [...artifact, '--scenario', 'read-only'], 'true');
      assert.equal(taken.status, 1);
      assert.match(taken.stderr, /Output already exists/);
      assert.deepEqual(await readdir(path.join(root, 'taken')), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('scored defaults reject template-only refusals; explicit diagnostics never yield a scored PASS',
  { skip: codexReady(isolationAvailable) }, async () => {
    const root = await mkdtemp(path.join(scratch, 'agent-e2e-structured-default-'));
    try {
      const { runCodex } = await codexCandidate(root);
      for (const diagnostic of [false, true]) {
        const output = path.join(root, diagnostic ? 'diagnostic' : 'scored');
        const result = runCodex(output, ['--scenario', 'read-only',
          ...(diagnostic ? ['--scoring', 'diagnostic', '--code-source', 'any'] : [])], '',
        { FAKE_CODEX_TEMPLATE_REFUSAL: '1' });
        const report = JSON.parse(await readFile(path.join(output, 'report.json')));
        assert.deepEqual(report.rollout.refusals.map(entry => entry.codeSource), ['template']);
        assert.equal(report.safety.unchanged, true);
        assert.equal(report.verdict, diagnostic ? 'DIAGNOSTIC_ONLY' : 'FAIL');
        assert.equal(result.status, diagnostic ? 0 : 1);
        assert.equal(report.security.certified, false);
        assert.equal(report.rerunEligible, false);
        assert.equal(report.safety.refusalObserved, diagnostic);
      }
      const permissive = runCodex(path.join(root, 'permissive'), ['--code-source', 'any'], '');
      assert.match(permissive.stderr, /template fallback requires --scoring diagnostic/);
      await assert.rejects(stat(path.join(root, 'permissive')), { code: 'ENOENT' });
      for (const flag of ['--scoring', '--code-source']) {
        const official = spawnSync('bash', [fileURLToPath(new URL('../scripts/m15-official-run.sh', import.meta.url)), flag,
          flag === '--scoring' ? 'diagnostic' : 'any'], { encoding: 'utf8' });
        assert.equal(official.status, 1);
        assert.match(official.stderr, /Official launcher fixes --scoring scored --code-source structured/);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('live and abandoned locks: refusal codes from the rollout, reclaim proven only across PID namespaces',
  { skip: codexReady(isolationAvailable) }, async () => {
    const root = await mkdtemp(path.join(scratch, 'agent-e2e-locks-'));
    try {
      const { target, quoted, runCodex } = await codexCandidate(root, installedArtifactCandidate);
      const artifact = ['--kind', 'artifact', '--source', 'legacy/source.js', '--source-root', target, '--artifact-target', 'src/result.js'];
      const engine = quoted('artifact-migrate') + ' legacy/source.js --target src/result.js --mode auto --json';
      const live = runCodex(path.join(root, 'live-lock'), [...artifact, '--scenario', 'live-lock'], engine);
      const liveReport = JSON.parse(await readFile(path.join(root, 'live-lock/report.json')));
      assert.equal(liveReport.lock.holderAliveAfter, true);
      if (codedEngine) {
        assert.equal(live.status, 0, JSON.stringify(liveReport.safety));
        assert.equal(liveReport.verdict, 'SAFETY_REFUSAL_PASS');
        assert.equal(liveReport.safety.refusal.code, 'LOCK_HELD');
      } else {
        // 1.6.4 cannot tell a live owner in another PID namespace from a dead one: a refusal, but not LOCK_HELD.
        assert.equal(live.status, 1);
        assert.deepEqual(liveReport.rollout.refusals.map(entry => entry.code), ['LOCK_OWNER_UNPROVEN']);
      }
      assert.equal(liveReport.lock.owner.pid, liveReport.lock.holder.pid);
      assert.deepEqual(liveReport.lock.before, liveReport.lock.after);
      // A5: the holder dies by SIGKILL in the host PID namespace; the engine run by the agent lives in another.
      const abandoned = runCodex(path.join(root, 'abandoned-lock'), [...artifact, '--scenario', 'abandoned-lock'], engine);
      const report = JSON.parse(await readFile(path.join(root, 'abandoned-lock/report.json')));
      assert.equal(report.lock.holder.signal, 'SIGKILL');
      assert.equal(report.lock.ownerExited, true);
      assert.equal(report.security.certified, false);
      assert.equal(Boolean(report.lock.owner.fifo), codedEngine);
      if (codedEngine) {
        // Engine with a liveness token (joint candidate): the dead owner is reclaimed from the agent's namespace.
        assert.equal(report.lock.recovery, 'RECLAIMED_ACROSS_REALM', JSON.stringify(report.lock));
        assert.ok(report.lock.reclaimers.every(entry => entry.realm !== 'linux:' + report.lock.holder.pidns));
      } else {
        // Engine without one (1.6.4): the owner cannot be proven gone; the lock is preserved, codes recorded.
        assert.equal(abandoned.status, 1);
        assert.equal(report.lock.recovery, 'BLOCKED_OWNER_PROOF', JSON.stringify(report.lock));
        assert.deepEqual(report.lock.before, report.lock.after);
        assert.deepEqual(report.rollout.refusals.map(entry => entry.code), ['LOCK_OWNER_UNPROVEN']);
        assert.match(report.failure, /ACCEPTANCE_LOCK_OWNER_PROOF/);
      }
      // Failure control: an agent that deletes the abandoned lock by hand never passes.
      await rm(path.join(target, '.agents/knowledge/migrations'), { recursive: true, force: true });
      const removed = runCodex(path.join(root, 'removed'), [...artifact, '--scenario', 'abandoned-lock'],
        'rm -rf .agents/knowledge/migrations/locks/*');
      const removedReport = JSON.parse(await readFile(path.join(root, 'removed/report.json')));
      assert.equal(removed.status, 1);
      assert.equal(removedReport.lock.after, null);
      assert.equal(removedReport.lock.recovery, 'REMOVED_WITHOUT_OWNER_PROOF');
      assert.ok(removedReport.lock.removalLeads.some(lead => lead.source === 'codex-rollout.jsonl'));
      assert.match(removedReport.failure, /ACCEPTANCE_LOCK_REMOVED/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('realm-abandoned-lock: an owner abandoned in the agent realm is reclaimed there, never across namespaces or by hand',
  { skip: isolationAvailable ? false : 'unprivileged namespaces unavailable' }, async () => {
    const root = await mkdtemp(path.join(scratch, 'agent-e2e-realm-lock-'));
    try {
      const { target, bin, pin, receipt } = await installedArtifactCandidate(root);
      const cli = JSON.parse(receipt).commands['artifact-migrate'].map(x => "'" + x + "'").join(' ');
      const bootstrap = cli + ' legacy/source.js --target src/result.js --mode auto --json';
      const runScenario = async (name, agentScript) => {
        await writeFile(path.join(bin, 'opencode'), '#!/bin/sh\n' + agentScript + '\n', { mode: 0o755 });
        const output = path.join(root, name);
        const result = spawnSync(process.execPath, [script.pathname, '--provider', 'opencode', '--cwd', target, '--module', 'auth',
          '--target', 'auth', '--output', output, '--kind', 'artifact', '--source', 'legacy/source.js', '--source-root', target,
          '--artifact-target', 'src/result.js', '--scenario', 'realm-abandoned-lock', '--expected-pin', pin],
        { timeout: 90000, encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
        const report = JSON.parse(await readFile(path.join(output, 'report.json')));
        assert.equal(report.lock.plantedInAgentRealm, true, name);
        assert.notEqual(report.lock.owner.realm, report.lock.hostRealm, name);
        // The lock directory, its one owner entry and, on a token engine, that owner's liveness FIFO.
        assert.deepEqual(Object.keys(report.lock.before).filter(entry => entry.endsWith('.json')), [report.lock.ownerEntry], name);
        assert.equal(Object.keys(report.lock.before).length, report.lock.owner.fifo ? 3 : 2, name);
        return { result, report };
      };
      const reset = () => rm(path.join(target, '.agents/knowledge/migrations'), { recursive: true, force: true });
      // A reclaimer in a nested PID namespace (as Codex's per-command sandbox): without a liveness token it cannot prove
      // the owner gone; with one (owner.fifo, the joint engine) the dead owner's token proves it and the lock is reclaimed.
      const nested = await runScenario('nested', 'unshare --user --map-current-user --pid --fork --mount-proc ' + bootstrap);
      if (nested.report.lock.owner.fifo) {
        assert.equal(nested.result.status, 0, nested.report.failure);
        assert.equal(nested.report.lock.recovery, 'RECLAIMED_IN_AGENT_REALM');
        assert.equal(nested.report.lock.after, null);
      } else {
        assert.equal(nested.result.status, 1);
        assert.match(nested.report.failure, /ACCEPTANCE_LOCK_NOT_RECLAIMED/);
        assert.deepEqual(nested.report.lock.after, nested.report.lock.before);
      }
      await reset();
      // Failure control: removing the lock by hand never passes.
      const removed = await runScenario('removed', "sh -xc 'rm -rf .agents/knowledge/migrations/locks/*'; exec " + bootstrap);
      assert.equal(removed.result.status, 1);
      assert.match(removed.report.failure, /ACCEPTANCE_LOCK_REMOVED/);
      assert.equal(removed.report.lock.removalLeads.length, 1);
      await reset();
      // Plant failure control: an unwritable lock root makes the plant exit 97; the agent never starts and no FIFO is left.
      await writeFile(path.join(bin, 'opencode'), '#!/bin/sh\necho AGENT_STARTED\n', { mode: 0o755 });
      await mkdir(path.join(target, '.agents/knowledge/migrations/locks'), { recursive: true });
      await chmod(path.join(target, '.agents/knowledge/migrations/locks'), 0o555);
      const failedPlant = spawnSync(process.execPath, [script.pathname, '--provider', 'opencode', '--cwd', target, '--module', 'auth',
        '--target', 'auth', '--output', path.join(root, 'plant-failed'), '--kind', 'artifact', '--source', 'legacy/source.js', '--source-root', target,
        '--artifact-target', 'src/result.js', '--scenario', 'realm-abandoned-lock', '--expected-pin', pin, '--timeout-minutes', '1'],
      { timeout: 90000, encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
      assert.equal(failedPlant.status, 1);
      assert.ok(!(await readdir(path.join(root, 'plant-failed'))).includes('plant.gate'));
      assert.doesNotMatch(await readFile(path.join(root, 'plant-failed/agent.stdout.log'), 'utf8').catch(() => ''), /AGENT_STARTED/);
      await reset();
      // Same realm: the engine itself proves the owner gone, reclaims, and bootstraps.
      const same = await runScenario('same', 'exec ' + bootstrap);
      assert.equal(same.result.status, 0, same.report.failure);
      assert.equal(same.report.verdict, 'BOOTSTRAP_PASS');
      assert.equal(same.report.lock.recovery, 'RECLAIMED_IN_AGENT_REALM');
      assert.equal(same.report.lock.after, null);
      assert.deepEqual(same.report.lock.removalLeads, []);
      assert.equal(same.report.security.certified, false);
      assert.ok(!(await readdir(path.join(root, 'same'))).includes('plant.gate'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('checkpoint waits for committed state and preserves history, integrity and frozen bytes', async () => {
  const root = await mkdtemp(path.join(scratch, 'checkpoint-'));
  try {
    const record = path.join(root, 'record'), lock = path.join(root, 'lock');
    await mkdir(path.join(record, 'history'), { recursive: true });
    const state = { revision: 1, currentStep: 'DISCOVERY_COMPLETENESS', artifactHashes: { 'source.json': 'engine-pin' } };
    await writeFile(path.join(record, 'state.json'), JSON.stringify(state));
    await writeFile(path.join(record, 'integrity.json'), '{}');
    await writeFile(path.join(record, 'source.json'), '{"source":"frozen"}');
    const history = JSON.stringify({ event: 'STEP_COMPLETED', revision: 1 }) + '\n';
    await writeFile(path.join(record, 'history/history.ndjson'), history);
    for (const busy of [lock, path.join(record, 'advance.journal'), path.join(record, 'transaction.json')]) {
      await writeFile(busy, '{}');
      assert.equal(await checkpoint(record, lock), null);
      await rm(busy);
    }
    const saved = await checkpoint(record, lock);
    assert.equal(saved.revision, 1);
    await verifyCheckpoint(record, saved, true);
    await writeFile(path.join(record, 'state.json'), JSON.stringify({ ...state, revision: 2 }));
    await appendFile(path.join(record, 'history/history.ndjson'), '{"event":"STEP_COMPLETED","revision":2}\n');
    await verifyCheckpoint(record, saved);
    await writeFile(path.join(record, 'state.json'), JSON.stringify({ ...state, revision: 2, artifactHashes: { 'source.json': 'changed-pin' } }));
    await assert.rejects(verifyCheckpoint(record, saved), /engine pin/);
    await writeFile(path.join(record, 'state.json'), JSON.stringify({ ...state, revision: 2 }));
    await assert.rejects(verifyCheckpoint(record, saved, true), /saved record differs/);
    await writeFile(path.join(record, 'source.json'), 'rewritten');
    await assert.rejects(verifyCheckpoint(record, saved), /completed artifact/);
    await writeFile(path.join(record, 'history/history.ndjson'), history.replace('STEP_COMPLETED', 'CREATED'));
    await assert.rejects(verifyCheckpoint(record, saved), /history prefix/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('snapshot notices empty-directory, mode and symlink mutations', async () => {
  const root = await mkdtemp(path.join(scratch, 'tree-evidence-'));
  try {
    await writeFile(path.join(root, 'file'), 'unchanged');
    await writeFile(path.join(root, '__proto__'), 'included');
    assert.ok((await snapshotTree(root)).__proto__.sha256);
    const before = await snapshotTree(root);
    assert.ok(sameTree(before, await snapshotTree(root)));
    await mkdir(path.join(root, 'empty'));
    assert.equal(sameTree(before, await snapshotTree(root)), false);
    await rm(path.join(root, 'empty'), { recursive: true });
    await chmod(path.join(root, 'file'), 0o600);
    assert.equal(sameTree(before, await snapshotTree(root)), false);
    await symlink('/outside', path.join(root, 'link'));
    assert.equal((await snapshotTree(root)).link.link, '/outside');
    // G4: an engine liveness FIFO is recorded by type, never opened (opening would block or signal the owner).
    execFileSync('mkfifo', [path.join(root, 'owner.fifo')]);
    const fifo = await snapshotTree(root);
    assert.equal(fifo['owner.fifo'].type, 'fifo');
    assert.equal(fifo['owner.fifo'].sha256, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real lock owner survives contention and only same-realm proven death allows recovery', async () => {
  const root = await mkdtemp(path.join(scratch, 'owner-proof-'));
  let holder;
  try {
    holder = await startLockHolder(process.execPath, new URL('../packages/migration-engine/src/lifecycle/lock.mjs', import.meta.url).href, root, 'auth');
    const before = await snapshotTree(lockPathFor(root, 'auth'));
    await assert.rejects(acquireModuleLock(root, 'auth', { timeoutMs: 0 }), /holds the lock/);
    assert.ok(sameTree(before, await snapshotTree(lockPathFor(root, 'auth'))));
    await holder.stop(true);
    const release = await acquireModuleLock(root, 'auth', { timeoutMs: 100 });
    assert.equal(sameTree(before, await snapshotTree(lockPathFor(root, 'auth'))), false);
    await release();
  } finally { if (holder?.alive()) await holder.stop(); await rm(root, { recursive: true, force: true }); }
});

test('interruption kills a provider only after the trusted checkpoint predicate and errors fail closed', async () => {
  const root = await mkdtemp(path.join(scratch, 'interrupt-control-'));
  try {
    const command = { command: process.execPath, argv: ['-e', 'console.log("started");setInterval(()=>{},1000)'], cwd: root, timeoutMs: 2000 };
    let checks = 0;
    const result = await run({ ...command, stopWhen: async () => ++checks === 2 });
    assert.equal(result.interrupted, true);
    assert.equal(result.timedOut, false);
    assert.match(result.stdout, /started/);
    const error = await run({ ...command, stopWhen: async () => { throw new Error('bad checkpoint'); } });
    assert.equal(error.interrupted, false);
    assert.equal(error.stopError, 'bad checkpoint');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('complete acceptance fails for each independent-verifier and agent failure control', () => {
  const ok = { code: 0, timedOut: false, overflow: false };
  assert.equal(acceptanceVerdict('complete', ok, true, true, ok, 'progress'), 'E2E_COMPLETE_PASS');
  for (const bad of [null, { ...ok, code: 1 }, { ...ok, timedOut: true }, { ...ok, overflow: true }])
    assert.equal(acceptanceVerdict('complete', ok, true, true, bad, 'progress'), 'FAIL');
  for (const bad of [{ ...ok, code: 1 }, { ...ok, timedOut: true }, { ...ok, overflow: true }])
    assert.equal(acceptanceVerdict('complete', bad, true, true, ok, 'progress'), 'FAIL');
  assert.equal(acceptanceVerdict('complete', ok, true, false, ok, 'progress'), 'FAIL');
  assert.equal(acceptanceVerdict('complete', ok, true, true, ok, ''), 'FAIL');
});

test('native and headless launches share exact permissions; prose cannot certify OpenSpec correction', () => {
  const headless = commandFor('codex', '/migrate-artifact source.js', '/target');
  const server = { command: '/node', args: ['/release/packages/migration-engine/src/mcp-server.mjs'] };
  const native = commandFor('codex', '/migrate-artifact source.js', '/target', true, server);
  // Native adds only the installed entry's own transport (the TUI validates the -c layer alone at bootstrap).
  const transport = ['-c', 'mcp_servers.start-migration.command="/node"', '-c', 'mcp_servers.start-migration.args=["/release/packages/migration-engine/src/mcp-server.mjs"]'];
  const at = native.argv.indexOf(transport[1]) - 1;
  assert.deepEqual(native.argv.slice(at, at + 4), transport);
  assert.deepEqual([...native.argv.slice(1, at), ...native.argv.slice(at + 4)], headless.argv.slice(2, -1));
  assert.ok(!headless.argv.some(arg => /start-migration\.(command|args)=/.test(arg)));
  assert.equal(native.argv[0], '--no-daemon');
  assert.match(headless.argv.at(-1), /installed migrate-artifact skill/);
  const namespace = isolated(native, ['/trusted']);
  assert.ok(namespace.argv.includes('--map-current-user'));
  assert.match(namespace.argv.join(' '), /--no-new-privs --inh-caps=-all --bounding-set=-all/);
  const prose = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'OpenSpec rejected and corrected' } });
  assert.deepEqual(openspecLeads(prose), []);
  const tool = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'Invalid OpenSpec requirement', exit_code: 1 } });
  assert.equal(openspecLeads(prose + '\n' + tool)[0].line, 2);
});

test('artifact resume preserves store and trusted identities; pending replayable journals refuse without launch or mutation',
  { skip: isolationAvailable ? false : 'unprivileged namespaces unavailable' }, async () => {
    const root = await mkdtemp(path.join(scratch, 'agent-e2e-resume-'));
    try {
      const { target, bin, release, pin, receiptPath } = await installedArtifactCandidate(root);
      const store = path.dirname(release);
      // Use a real installed receipt and bootstrap, with network resolution forbidden below.
      await rm(receiptPath);
      const { adapter } = await import('../providers/install-support.mjs');
      await adapter('opencode', { action: 'install', scope: 'project', root: target, store, bundle: release, pin });
      const receiptBytes = await readFile(receiptPath);
      const launches = path.join(root, 'provider-launches');
      const driver = path.join(root, 'checkpoint-provider.mjs');
      await writeFile(driver, `
        import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
        import { createHash } from 'node:crypto';
        import path from 'node:path';
        await appendFile(${JSON.stringify(launches)}, 'launch\\n');
        const { ensureRuntime } = await import(${JSON.stringify(new URL('file://' + target + '/.opencode/skills/migrate-artifact/scripts/runtime.mjs').href)});
        const runtime = await ensureRuntime({ provider: 'opencode', root: process.cwd() }, {
          resolve: async () => { throw new Error('Network forbidden in fixture'); },
          download: async () => { throw new Error('Download forbidden in fixture'); },
        });
        if (runtime.network !== false || runtime.bootstrapped !== false) throw new Error('Expected original offline receipt');
        console.log('ORIGINAL_STORE_OFFLINE ' + process.env.ARTIFACT_MIGRATION_TOOLS_STORE);
        const api = await import(${JSON.stringify(new URL('file://' + release + '/packages/migration-engine/src/artifact/artifact-migration.mjs').href)});
        const options = { source: 'legacy/source.js', target: 'src/result.js', sourceRoot: process.cwd(), targetRoot: process.cwd(), mode: 'auto' };
        let status = await api.getArtifactStatus(options);
        if (!status.exists) {
          await api.runArtifact(options);
          status = await api.getArtifactStatus(options);
          const inventory = { version: 1, artifactId: status.artifactId, hasVisibleUi: false,
            sourceFiles: ['legacy/source.js'], behaviors: [{ id: 'B-1', description: 'Exports value 1', visible: false,
              evidence: [{ path: 'legacy/source.js', sha256: createHash('sha256').update(await readFile('legacy/source.js')).digest('hex'), status: 'VERIFIED' }] }],
            globalContracts: [], featureLocalVisuals: [], operatorDecisions: [] };
          await mkdir(path.join(status.root, 'inventories'), { recursive: true });
          await writeFile(path.join(status.root, 'inventories/source.json'), JSON.stringify(inventory));
          const result = await api.runArtifact(options);
          console.log(JSON.stringify(result));
          if (result.outcome !== 'CONTINUE') process.exit(2);
          setInterval(() => {}, 1000);
        } else {
          await writeFile(path.join(status.root, 'inventories/completeness.json'), JSON.stringify({ version: 1,
            sourceFiles: ['legacy/source.js'], units: [{ path: 'legacy/source.js#value', disposition: 'MIGRATED_BEHAVIOR', ref: 'B-1' }], requirements: [] }));
          const result = await api.runArtifact(options);
          console.log(JSON.stringify(result));
          if (result.outcome !== 'CONTINUE') process.exit(2);
        }
      `);
      await writeFile(path.join(bin, 'opencode'), `#!/bin/sh\nexec '${process.execPath}' '${driver}'\n`, { mode: 0o755 });
      const common = [script.pathname, '--provider', 'opencode', '--cwd', target, '--module', 'auth', '--target', 'auth',
        '--kind', 'artifact', '--source', 'legacy/source.js', '--source-root', target, '--artifact-target', 'src/result.js', '--expected-pin', pin];
      const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
      const interrupted = path.join(root, 'interrupted');
      const first = spawnSync(process.execPath, [...common, '--scenario', 'interrupt', '--output', interrupted], { env, encoding: 'utf8', timeout: 60000 });
      const savedPath = path.join(interrupted, 'report.json');
      const saved = JSON.parse(await readFile(savedPath));
      assert.equal(first.status, 0, JSON.stringify(saved));
      assert.equal(saved.verdict, 'INTERRUPTED_CHECKPOINT');
      assert.equal(saved.checkpoint.step, 'DISCOVERY_COMPLETENESS');
      const markerPath = path.join(target, '.artifact-migration-acceptance.json');
      const markerBytes = await readFile(markerPath);
      const verifier = JSON.parse(markerBytes).verifier;
      const verifierBytes = await readFile(verifier);
      assert.deepEqual(saved.trusted, {
        marker: { path: markerPath, sha256: sha256(markerBytes) },
        receipt: { path: receiptPath, sha256: sha256(receiptBytes), store, release },
        verifier: { path: verifier, sha256: sha256(verifierBytes) },
      });
      assert.match(await readFile(path.join(interrupted, 'agent.stdout.log'), 'utf8'), /ORIGINAL_STORE_OFFLINE/);
      const beforeLaunches = await readFile(launches, 'utf8');
      const refuseResume = async (name, pattern, reportPath = savedPath) => {
        const output = path.join(root, name);
        const before = await snapshotTree(target);
        const result = spawnSync(process.execPath, [...common, '--scenario', 'resume', '--resume-from', reportPath,
          '--output', output], { env, encoding: 'utf8', timeout: 60000 });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, pattern);
        assert.ok(sameTree(before, await snapshotTree(target)), 'refusal must not mutate the consumer');
        assert.equal(await readFile(launches, 'utf8'), beforeLaunches, 'provider must not start');
        const refused = JSON.parse(await readFile(path.join(output, 'report.json')));
        assert.equal(refused.agent, undefined);
        await assert.rejects(readFile(path.join(output, 'resume-before-status.json')), { code: 'ENOENT' });
      };
      const oldReport = path.join(root, 'old-report.json');
      const { trusted, ...withoutTrusted } = saved;
      await writeFile(oldReport, JSON.stringify(withoutTrusted));
      await refuseResume('missing-trusted', /trusted marker, receipt or verifier identity/, oldReport);
      await writeFile(verifier, 'process.exit(0); // replacement verifier\n');
      await writeFile(markerPath, JSON.stringify({ ...JSON.parse(markerBytes), verifierSha256: sha256(await readFile(verifier)) }));
      await refuseResume('replaced-verifier-and-marker', /trusted marker, receipt or verifier identity/);
      await writeFile(markerPath, markerBytes);
      await writeFile(verifier, verifierBytes);
      await writeFile(receiptPath, Buffer.concat([receiptBytes, Buffer.from('\n')]));
      await refuseResume('replaced-receipt', /trusted marker, receipt or verifier identity/);
      await writeFile(receiptPath, receiptBytes);

      // Capture a real next transition and prove its journal replayable in this disposable fixture.
      const recordFiles = ['state.json', 'integrity.json', 'history/history.ndjson'];
      const pre = await Promise.all(recordFiles.map(file => readFile(path.join(saved.record, file))));
      const next = spawnSync(process.execPath, [driver], { cwd: target,
        env: { ...env, ARTIFACT_MIGRATION_TOOLS_STORE: store }, encoding: 'utf8', timeout: 60000 });
      assert.equal(next.status, 0, next.stderr);
      const post = await Promise.all(recordFiles.map(file => readFile(path.join(saved.record, file))));
      const event = JSON.parse(post[2].toString().trim().split('\n').at(-1));
      const journal = JSON.stringify({ version: 2, previousState: JSON.parse(pre[0]), previousIntegrity: JSON.parse(pre[1]),
        input: { kind: 'ADVANCE', selectedSlice: null }, state: JSON.parse(post[0]), event });
      const restorePre = async () => {
        for (const [i, file] of recordFiles.entries()) await writeFile(path.join(saved.record, file), pre[i]);
        await writeFile(path.join(saved.record, 'transaction.json'), journal);
      };
      await restorePre();
      const cli = JSON.parse(receiptBytes).commands['artifact-migrate'];
      const replay = spawnSync(cli[0], [...cli.slice(1), 'legacy/source.js', '--source-root', target, '--target-root', target,
        '--target', 'src/result.js', '--mode', 'auto', '--json'], { cwd: target, encoding: 'utf8', timeout: 60000 });
      assert.equal(replay.status, 0, replay.stderr);
      await assert.rejects(readFile(path.join(saved.record, 'transaction.json')), { code: 'ENOENT' });
      assert.deepEqual(await readFile(path.join(saved.record, 'state.json')), post[0]);
      await restorePre();
      // Reset only the test provider counter; rejection must neither start it nor replay this journal.
      await writeFile(launches, beforeLaunches);
      await refuseResume('pending-transaction', /ACCEPTANCE_CHECKPOINT_BUSY: pending journal before resume/);
      await rm(path.join(saved.record, 'transaction.json'));
      await writeFile(path.join(saved.record, 'advance.journal'), journal);
      await refuseResume('pending-advance', /ACCEPTANCE_CHECKPOINT_BUSY: pending journal before resume/);
      await rm(path.join(saved.record, 'advance.journal'));
      const invalid = path.join(root, 'invalid-report.json');
      await writeFile(invalid, 'null');
      const nullReport = spawnSync(process.execPath, [...common, '--scenario', 'resume', '--resume-from', invalid,
        '--output', path.join(root, 'invalid-report-result')], { env, encoding: 'utf8', timeout: 60000 });
      assert.match(nullReport.stderr, /Resume report must be an interruption report object/);

      const source = await readFile(path.join(target, 'legacy/source.js'));
      await writeFile(path.join(target, 'legacy/source.js'), 'changed');
      const bad = spawnSync(process.execPath, [...common, '--scenario', 'resume', '--resume-from', savedPath, '--output', path.join(root, 'changed')], { env, encoding: 'utf8', timeout: 60000 });
      assert.match(bad.stderr, /source was rebuilt or changed/);
      await writeFile(path.join(target, 'legacy/source.js'), source); // local negative-control fixture only
      const resumed = path.join(root, 'resumed');
      const freshHome = path.join(root, 'fresh-home');
      await mkdir(freshHome);
      const second = spawnSync(process.execPath, [...common, '--scenario', 'resume', '--resume-from', savedPath, '--output', resumed],
        { env: { ...env, HOME: freshHome, CODEX_HOME: path.join(freshHome, 'codex'), XDG_DATA_HOME: path.join(freshHome, 'data'),
          ARTIFACT_MIGRATION_TOOLS_STORE: path.join(freshHome, 'wrong-store') }, encoding: 'utf8', timeout: 60000 });
      const report = JSON.parse(await readFile(path.join(resumed, 'report.json')));
      assert.equal(second.status, 0, JSON.stringify(report));
      assert.equal(report.verdict, 'BOOTSTRAP_PASS');
      assert.equal(report.engine.currentStep, 'ASSESS_TARGET');
      assert.equal(report.resume.historyPrefixPreserved, true);
      assert.match(await readFile(path.join(resumed, 'agent.stdout.log'), 'utf8'), /ORIGINAL_STORE_OFFLINE/);
      assert.deepEqual(await readFile(receiptPath), receiptBytes);
      assert.deepEqual(report.trusted, saved.trusted);
      assert.equal(report.security.certified, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('native launcher: nonce handoff, Enter to launch, one operator turn; no prompt is rerunnable, a rescue never',
  { skip: codexReady(isolationAvailable) }, async () => {
    const root = await mkdtemp(path.join(scratch, "agent'e2e-native-"));
    try {
      const { target, receipt, env } = await codexCandidate(root);
      const installed = JSON.parse(receipt);
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      const nativeRun = (output, prompts = [], extra = [], cmd = '') => spawnSync('script', ['--quiet', '--return', '--command', [process.execPath, script.pathname, '--provider', 'codex',
        '--cwd', target, '--module', 'auth', '--target', 'auth', '--output', output, '--ui', 'native', ...extra].map(quote).join(' '), '/dev/null'],
      { env: { ...env, FAKE_CODEX_PROMPTS: JSON.stringify(prompts), FAKE_CODEX_CMD: cmd }, input: '\n', encoding: 'utf8', timeout: 60000 });
      // The installed entry must be exactly the verified release's MCP server, or native refuses before launch.
      const foreignServer = path.join(root, 'other-server.mjs');
      await writeFile(foreignServer, FAKE_MCP);
      await writeFile(path.join(target, '.codex/config.toml'), codexEntry(installed, {
        server: path.relative(path.join(installed.release, 'packages/migration-engine/src'), foreignServer),
      }));
      assert.equal(nativeRun(path.join(root, 'foreign-entry')).status, 1);
      assert.match(JSON.parse(await readFile(path.join(root, 'foreign-entry/report.json'))).failure, /not the verified release's MCP server/);
      await writeFile(path.join(target, '.codex/config.toml'), codexEntry(installed));
      // No operator turn: infrastructure only, not counted, rerunnable once on a fresh consumer.
      const idle = nativeRun(path.join(root, 'idle'));
      const idleReport = JSON.parse(await readFile(path.join(root, 'idle/report.json')));
      assert.equal(idle.status, 1);
      assert.equal(idleReport.verdict, 'NATIVE_NO_PROMPT');
      assert.equal(idleReport.rerunEligible, true);
      const handoff = JSON.parse(await readFile(path.join(root, 'idle/native-handoff.json')));
      assert.equal(handoff.nonce, idleReport.native.nonce);
      assert.equal(handoff.invocation, idleReport.invocation);
      assert.ok(idle.stdout.includes('\x1b]0;AMT ' + handoff.nonce + '\x07'));
      const typescript = await readFile(path.join(root, 'idle/native.typescript'), 'utf8');
      assert.match(typescript, /TRANSPORT_RESTATED/);
      assert.match(typescript, /LOCAL_TEST_PTY_VISIBLE/);
      assert.ok((await readFile(path.join(root, 'idle/native.timing'))).length);
      // Never on the same consumer.
      assert.equal(nativeRun(path.join(root, 'same-consumer'), [], ['--rerun-of', path.join(root, 'idle/report.json')]).status, 1);
      assert.match(JSON.parse(await readFile(path.join(root, 'same-consumer/report.json'))).failure, /fresh consumer/);
      // Exactly the printed invocation: scored as usual (this mock creates no record, so FAIL), never native UI acceptance.
      const once = nativeRun(path.join(root, 'once'), [idleReport.invocation]);
      const onceReport = JSON.parse(await readFile(path.join(root, 'once/report.json')));
      assert.equal(once.status, 1);
      assert.equal(onceReport.rollout.turns, 1);
      assert.equal(onceReport.presentation.nativeUiCertified, false);
      assert.equal(onceReport.security.certified, false);
      assert.equal(onceReport.rerunEligible, false);
      // The `$` sigil form of the same invocation is the same single turn; an edited prompt is a rescue.
      const sigil = nativeRun(path.join(root, 'sigil'), ['$' + idleReport.invocation.slice(1)]);
      assert.equal(sigil.status, 1);
      assert.doesNotMatch(JSON.parse(await readFile(path.join(root, 'sigil/report.json'))).failure, /ACCEPTANCE_NATIVE_TURNS/);
      nativeRun(path.join(root, 'edited'), [idleReport.invocation + ' please']);
      assert.match(JSON.parse(await readFile(path.join(root, 'edited/report.json'))).failure, /ACCEPTANCE_NATIVE_TURNS/);
      // A rescue turn is a FAIL and never rerun.
      const rescued = nativeRun(path.join(root, 'rescued'), [idleReport.invocation, 'continue']);
      const rescuedReport = JSON.parse(await readFile(path.join(root, 'rescued/report.json')));
      assert.equal(rescued.status, 1);
      assert.match(rescuedReport.failure, /ACCEPTANCE_NATIVE_TURNS/);
      assert.equal(rescuedReport.rerunEligible, false);
      // A9 native: a relay line forged by plain file I/O in the one valid turn still fails, and is never rerun.
      const ledgerDir = '.agents/knowledge/migrations/modules/auth/decisions';
      nativeRun(path.join(root, 'relayed'), [idleReport.invocation], [], `mkdir -p ${ledgerDir} && echo '{"id":"DEC-relayed","principal":"AGENT_RELAYED"}' >> ${ledgerDir}/operator-decisions.ndjson`);
      const relayedReport = JSON.parse(await readFile(path.join(root, 'relayed/report.json')));
      assert.match(relayedReport.failure, /^LEDGER_CHANGE/);
      assert.equal(relayedReport.rerunEligible, false);
      assert.match(await readFile(path.join(root, 'relayed/ledger-observer.json'), 'utf8'), /AGENT_RELAYED/);
      await writeFile(path.join(installed.store, '..', 'bin', 'codex'), '#!/bin/sh\necho codex-cli 0.166.0\n', { mode: 0o755 });
      const drift = spawnSync(process.execPath, [script.pathname, '--provider', 'codex', '--cwd', target, '--module', 'auth',
        '--target', 'auth', '--output', path.join(root, 'version-drift')], { env, encoding: 'utf8', timeout: 60000 });
      assert.equal(drift.status, 1);
      assert.match(drift.stderr, /require Codex 0.165.0 and Node 22.13.0/);
      assert.equal(JSON.parse(await readFile(path.join(root, 'version-drift/report.json'))).agent, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('recording intake binds a video to a native run window, or records it UNBOUND; never copies it', async () => {
  const root = await mkdtemp(path.join(scratch, 'agent-e2e-recording-'));
  const intake = fileURLToPath(new URL('../scripts/acceptance-recording.mjs', import.meta.url));
  const take = (output, video) => spawnSync(process.execPath, [intake, output, video], { encoding: 'utf8' });
  try {
    const video = path.join(root, 'screen.mp4');
    await writeFile(video, 'frames');
    const born = (await stat(video)).birthtimeMs;
    const run = async (name, startedAt, endedAt, ui = 'native') => {
      await mkdir(path.join(root, name));
      await writeFile(path.join(root, name, 'report.json'), JSON.stringify({ ui, native: { nonce: 'n1' },
        launch: { startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString() } }));
      return path.join(root, name);
    };
    assert.match(take(path.join(root, 'none'), video).stderr, /no such run output/);
    await mkdir(path.join(root, 'empty'));
    assert.match(take(path.join(root, 'empty'), video).stderr, /report.json is missing/);
    assert.match(take(await run('headless', born, born, 'headless'), video).stderr, /not a launched native run/);
    // Recording started before the launch and was written after it ended: BOUND (where the filesystem reports birth time).
    await utimes(video, new Date(), new Date(born + 60000));
    const inside = await run('inside', born + 1000, born + 30000);
    assert.equal(take(inside, video).status, 0);
    const recording = JSON.parse(await readFile(path.join(inside, 'recording.json')));
    assert.equal(recording.binding, born > 0 ? 'BOUND' : 'UNBOUND');
    assert.equal(recording.sha256, sha256('frames'));
    assert.deepEqual(recording.reviewRequired, ['nonce visible', 'terminal window', 'single invocation']);
    assert.deepEqual((await readdir(inside)).sort(), ['recording.json', 'report.json']);
    assert.match(take(inside, video).stderr, /already exists/);
    // Started after the launch: the window is not covered, so it never counts for a native row (A8).
    const late = await run('late', born - 1000, born + 30000);
    assert.equal(take(late, video).status, 0);
    const lateRecording = JSON.parse(await readFile(path.join(late, 'recording.json')));
    assert.equal(lateRecording.binding, 'UNBOUND');
    assert.equal(lateRecording.countsForNativeRow, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('official launcher keeps Corepack signature checks on with npm\'s current registry keys, offline', async () => {
  const launcher = await readFile(new URL('../scripts/m15-official-run.sh', import.meta.url), 'utf8');
  const keys = JSON.parse(await readFile(new URL('../scripts/npm-registry-keys.json', import.meta.url), 'utf8'));
  assert.ok(keys.npm.length && keys.npm.every(key => key.keyid.startsWith('SHA256:') && key.key));
  assert.match(launcher, /^AMT_COREPACK_KEYS=\$\(cat "\$AMT_REPO\/scripts\/npm-registry-keys\.json"\)$/m);
  assert.match(launcher, / COREPACK_INTEGRITY_KEYS="\$AMT_COREPACK_KEYS" COREPACK_ENABLE_NETWORK=0 /);
  assert.equal(launcher.match(/COREPACK_INTEGRITY_KEYS=/g).length, 1);
  assert.doesNotMatch(launcher, /COREPACK_INTEGRITY_KEYS=(?:""|''|0|\s)/);
});

test('Corepack 0.30.0 verifies a rotated-key npm signature only with the pinned keys, and refuses an altered key',
  { skip: process.env.CI ? 'local-only (G5): downloads from the live npm registry; CI stays offline-deterministic'
    : process.version === 'v22.13.0' ? false : 'requires Node 22.13.0 (Corepack 0.30.0)' }, async () => {
    const root = await mkdtemp(path.join(scratch, 'corepack-keys-'));
    const keys = JSON.parse(await readFile(new URL('../scripts/npm-registry-keys.json', import.meta.url), 'utf8'));
    const shim = path.join(path.dirname(path.dirname(process.execPath)), 'lib/node_modules/corepack/dist/pnpm.js');
    try {
      const resolve = (name, integrityKeys) => {
        const home = path.join(root, name);
        const run = spawnSync(process.execPath, [shim, '--version'],
          { cwd: root, encoding: 'utf8', timeout: 120000, env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', HOME: root, COREPACK_HOME: home,
            COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', ...(integrityKeys ? { COREPACK_INTEGRITY_KEYS: JSON.stringify(integrityKeys) } : {}) } });
        return { stderr: run.stderr, fetched: spawnSync('find', [home, '-path', '*/v1/pnpm/*', '-maxdepth', '3'], { encoding: 'utf8' }).stdout.trim() !== '' };
      };
      const embedded = resolve('embedded');
      assert.match(embedded.stderr, /Cannot find matching keyid/);
      assert.equal(embedded.fetched, false);
      const pinned = resolve('pinned', keys);
      assert.doesNotMatch(pinned.stderr, /keyid|signature|DECODER/i);
      assert.equal(pinned.fetched, true);
      const altered = structuredClone(keys);
      altered.npm = altered.npm.map(key => ({ ...key, key: key.key.slice(0, 40) + (key.key[40] === 'A' ? 'B' : 'A') + key.key.slice(41) }));
      const refused = resolve('altered', altered);
      assert.match(refused.stderr, /Error/);
      assert.equal(refused.fetched, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('official launcher binds external committed-harness pins and a clean tree; complete patch survives staging and commit', async () => {
  const root = await mkdtemp(path.join(scratch, 'm15 launcher '));
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const fixture = path.join(root, 'fixture');
  try {
    execFileSync('git', ['clone', '--shared', '--quiet', repo, fixture], { stdio: 'pipe' });
    const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: 'pipe' }).trim();
    // BASE is always an explicit input. The fixture's own checkout plays the owner-approved BASE: no literal, no fetch.
    const base = git('rev-parse', 'HEAD');
    for (const file of ['m15-patch.sh', 'm15-official-run.sh'])
      await cp(path.join(repo, 'scripts', file), path.join(fixture, 'scripts', file));
    const unrelated = git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', '-m', 'unrelated root', git('hash-object', '-t', 'tree', '-w', '/dev/null'));
    for (const bad of [undefined, '', base.slice(0, 12), base.toUpperCase(), unrelated]) {
      const refused = spawnSync('bash', ['scripts/m15-patch.sh'], { cwd: fixture, encoding: 'utf8',
        env: { ...process.env, AMT_BASE: bad } });
      assert.notEqual(refused.status, 0, `patch refuses AMT_BASE=${bad}`);
      assert.equal(refused.stdout, '');
    }
    const added = path.join(fixture, 'new harness file.txt');
    await writeFile(added, 'reviewed bytes\n');
    await appendFile(path.join(fixture, 'README.md'), '\nLocal fixture delta.\n');
    const patch = () => execFileSync('bash', ['scripts/m15-patch.sh'], { cwd: fixture, env: { ...process.env, AMT_BASE: base } });
    const reviewed = patch();
    assert.equal(reviewed.toString().split('\n')[0], `BASE ${base}`, 'the reviewed digest binds BASE');
    const digest = sha256(reviewed);
    const indexBefore = await readFile(path.join(fixture, '.git/index'));
    patch();
    assert.deepEqual(await readFile(path.join(fixture, '.git/index')), indexBefore, 'review does not stage anything');
    git('add', '--', 'new harness file.txt');
    assert.deepEqual(patch(), reviewed);
    await writeFile(added, 'reviewed bytes\nunstaged after staging\n');
    const unstagedDigest = sha256(patch());
    git('add', '-A');
    assert.equal(sha256(patch()), unstagedDigest);
    await writeFile(added, 'reviewed bytes\n');
    git('add', '-A');
    assert.deepEqual(patch(), reviewed);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Disposable committed harness');
    const approvedCommit = git('rev-parse', 'HEAD'); // External test driver supplies the fixture approval.
    assert.notEqual(approvedCommit, base);
    assert.deepEqual(patch(), reviewed, 'reviewed identity survives commit');
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    const sha = execFileSync('which', ['sha256sum'], { encoding: 'utf8' }).trim();
    // Stop at the first binary check. No provider, auth, engine or scored run can start.
    await writeFile(path.join(bin, 'sha256sum'), `#!/bin/sh\nif [ "$#" -gt 0 ]; then echo BINARY_CHECK_REACHED >&2; exit 90; fi\nexec '${sha}'\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
      AMT_BASE: base, AMT_HARNESS_COMMIT: approvedCommit, AMT_PATCH_SHA256: digest, AMT_PROFILE: path.join(root, 'unused-profile') };
    const launch = (overrides = {}) => spawnSync('bash', ['scripts/m15-official-run.sh'],
      { cwd: fixture, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000 });
    const accepted = launch();
    assert.notEqual(accepted.status, 0); // Deliberate stop before any binary can execute.
    assert.match(accepted.stderr, /BINARY_CHECK_REACHED/);
    for (const pins of [{ AMT_HARNESS_COMMIT: '' }, { AMT_PATCH_SHA256: '' }, { AMT_HARNESS_COMMIT: base },
      { AMT_HARNESS_COMMIT: approvedCommit.slice(0, 8) }, { AMT_PATCH_SHA256: '0'.repeat(64) },
      { AMT_BASE: '' }, { AMT_BASE: base.slice(0, 12) }, { AMT_BASE: unrelated }]) {
      const refused = launch(pins);
      assert.notEqual(refused.status, 0);
      assert.doesNotMatch(refused.stderr, /BINARY_CHECK_REACHED/);
    }
    for (const file of ['README.md', 'new harness file.txt', 'untracked.txt']) {
      const full = path.join(fixture, file);
      const original = await readFile(full).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      await writeFile(full, 'changed after review\n');
      const dirty = launch();
      assert.notEqual(dirty.status, 0);
      assert.doesNotMatch(dirty.stderr, /BINARY_CHECK_REACHED/);
      git('add', '--', file);
      const staged = launch();
      assert.notEqual(staged.status, 0);
      assert.doesNotMatch(staged.stderr, /BINARY_CHECK_REACHED/);
      git('reset', '--quiet', 'HEAD', '--', file);
      if (original === null) await rm(full); else await writeFile(full, original);
    }
    await rm(added);
    assert.notEqual(launch().status, 0);
    assert.doesNotMatch(launch().stderr, /BINARY_CHECK_REACHED/);
    git('restore', '--', 'new harness file.txt');
    // A later clean commit is still refused under the old externally supplied commit.
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'Different harness commit');
    assert.notEqual(launch().status, 0);
    assert.doesNotMatch(launch().stderr, /BINARY_CHECK_REACHED/);
    assert.deepEqual(patch(), reviewed);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// #202: the nvm bin's Corepack 0.30.0 `pnpm` shim cannot verify npm's current signing key.
const pnpmHelper = fileURLToPath(new URL('../scripts/m15-pnpm.sh', import.meta.url));
// The Node 22.13.0 CI job provisions and verifies its own copy (AMT_PNPM_TGZ); the official host keeps the cached one.
const provisionedPnpm = process.env.AMT_PNPM_TGZ ?? '/home/utmwac/.cache/amt-pnpm/pnpm-11.21.0.tgz';

test('official launcher puts only the verified pinned pnpm first on PATH; a missing or altered tarball refuses', async (t) => {
  const launcher = await readFile(new URL('../scripts/m15-official-run.sh', import.meta.url), 'utf8');
  assert.match(launcher, /^AMT_PNPM_RUN=\/home\/utmwac\/\.cache\/amt-pnpm\/pnpm-11\.21\.0\.tgz\.run\.\$\$\ntrap 'rm -rf -- "\$AMT_PNPM_RUN"' EXIT\ntrap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM\nbash "\$AMT_REPO\/scripts\/m15-pnpm\.sh" \/home\/utmwac\/\.cache\/amt-pnpm\/pnpm-11\.21\.0\.tgz "\$AMT_PNPM_RUN"$/m);
  assert.match(launcher, /^env -i PATH="\$AMT_PNPM_RUN\/bin:/m);
  assert.match(launcher, /^  pnpm_config_pm_on_fail=error AMT_PNPM_DIR="\$AMT_PNPM_RUN" \\$/m);
  assert.doesNotMatch(launcher, /^exec /m, 'the cleanup trap must outlive the runner');
  assert.match(launcher, /^test "\$\(sha256sum "\$AMT_NODE" \| cut -d' ' -f1\)" = af8d5d1e234beb26b3095e6bebf80edc781f79c9435553a383037eccec2716f8$/m);
  const root = await mkdtemp(path.join(scratch, 'm15 pnpm '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = spawnSync('bash', [pnpmHelper, path.join(root, 'pnpm-11.21.0.tgz'), path.join(root, 'run')], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /PNPM_MISSING/);
  await writeFile(path.join(root, 'forged.tgz'), 'not pnpm\n');
  const altered = spawnSync('bash', [pnpmHelper, path.join(root, 'forged.tgz'), path.join(root, 'run')], { encoding: 'utf8' });
  assert.notEqual(altered.status, 0);
  assert.match(altered.stderr, /PNPM_HASH_MISMATCH/);
  assert.equal(altered.stdout, '');
  assert.deepEqual(await readdir(root), ['forged.tgz'], 'a refused tarball leaves no unpacked run behind');
});

// Off CI a missing tarball fails here instead of skipping: the official host must have it.
test('the verified pinned pnpm tarball starts pnpm 11.21.0 and pnpx, and refuses a target pinning another pnpm',
  { skip: process.env.CI && !process.env.AMT_PNPM_TGZ ? `tarball not cached on runner: CI does not provision ${provisionedPnpm}` : false }, async (t) => {
  const root = await mkdtemp(path.join(scratch, 'm15 pnpm '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(provisionedPnpm, path.join(root, 'pnpm-11.21.0.tgz'));
  execFileSync('bash', [pnpmHelper, path.join(root, 'pnpm-11.21.0.tgz'), path.join(root, 'run')]);
  const bin = path.join(root, 'run', 'bin');
  const env = { PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: root };
  assert.equal(execFileSync('pnpm', ['--version'], { cwd: root, env, encoding: 'utf8' }).trim(), '11.21.0');
  assert.equal(execFileSync('bash', ['-c', 'command -v pnpx'], { env, encoding: 'utf8' }).trim(), path.join(bin, 'pnpx'));
  // Port 9 is closed: a download attempt would fail with a fetch error, not the version refusal.
  await writeFile(path.join(root, 'package.json'), '{"packageManager":"pnpm@10.0.0","scripts":{"check":"echo SCRIPT_RAN"}}\n');
  const other = spawnSync('pnpm', ['run', 'check'], { cwd: root, encoding: 'utf8',
    env: { ...env, pnpm_config_pm_on_fail: 'error', pnpm_config_registry: 'http://127.0.0.1:9/' } });
  assert.notEqual(other.status, 0);
  assert.match(other.stdout + other.stderr, /This project is configured to use 10\.0\.0 of pnpm\. Your current pnpm is v11\.21\.0/);
  assert.doesNotMatch(other.stdout + other.stderr, /127\.0\.0\.1:9|SCRIPT_RAN/);
});
