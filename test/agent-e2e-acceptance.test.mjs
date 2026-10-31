import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildRelease } from "../scripts/release.mjs";
import { CODEX_MCP_TOOLS, commandFor, acceptanceVerdict, run, isolated } from "../scripts/agent-e2e-acceptance.mjs";
import { candidateReleaseRoot } from "../packages/migration-engine/test/support/candidate-release-root.mjs";

import { checkpoint, verifyCheckpoint, snapshotTree, sameTree, openspecLeads, startLockHolder, sha256 } from '../scripts/acceptance-evidence.mjs';
import { acquireModuleLock, lockPathFor } from '../packages/migration-engine/src/lifecycle/index.mjs';

const script = new URL("../scripts/agent-e2e-acceptance.mjs", import.meta.url);

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
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-e2e-negative-"));
  try {
    const argv = ["--provider", "codex", "--cwd", root, "--module", "auth",
      "--target", "auth", "--output", path.join(root, "../" + path.basename(root) + "-report")];
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
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-e2e-no-receipt-"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-e2e-pin-"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-e2e-receipt-"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-e2e-no-status-"));
  try {
    const { target, bin } = await installedCandidate(root);
    // Exits 0 and creates no migration record, so the engine has no status to give.
    await writeFile(path.join(bin, "opencode"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const output = path.join(root, "reports");
    assert.throws(() => execFileSync(process.execPath, [script.pathname, "--provider", "opencode", "--cwd", target,
      "--module", "auth", "--target", "auth", "--output", output, "--isolation", "none"],
    { encoding: "utf8", timeout: 60000, stdio: "pipe", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } }),
    (error) => /Engine status failed/.test(String(error.stderr)));
    const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
    assert.equal(report.verdict, "FAIL");
    assert.match(report.failure, /Engine status failed/);
    assert.equal(report.engine, undefined);
    assert.equal(report.independentVerification, undefined);
    assert.ok((await readFile(path.join(output, "engine-status.stderr.log"), "utf8")).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary first-time record directory creation is not a replacement event", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-e2e-first-record-"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-e2e-record-continuity-"));
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
    (error) => /ACCEPTANCE_RECORD_REPLACED/.test(String(error.stderr)));
    const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
    assert.equal(report.verdict, "FAIL");
    assert.equal(report.security.certified, false);
    assert.match(report.failure, /ACCEPTANCE_RECORD_REPLACED/);
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
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-e2e-isolated-"));
    try {
      // A verifier in its own directory is sealed whole, dependencies included.
      const { target, bin, verifier, release, receiptPath, receipt, pin } = await installedCandidate(root, path.join(root, "verifier"));
      const dependency = path.join(root, "verifier", "driver.mjs");
      await writeFile(dependency, "export default 1;\n");
      const output = path.join(root, "reports");
      const engineFile = path.join(release, "packages/migration-engine/package.json");
      const engineBytes = await readFile(engineFile, "utf8");
      const canary = path.join(root, "late-write");
      // unshare --map-current-user maps the effective IDs, so those are what the agent must see.
      const uid = process.geteuid(), gid = process.getegid();
      const attempt = (label, command) => `(${command}) 2>/dev/null && echo ${label}=WRITABLE >> observed || echo ${label}=DENIED >> observed`;
      await writeFile(path.join(bin, "opencode"), ["#!/bin/sh",
        attempt("receipt", "echo hacked > .artifact-migration-tools/opencode.json"),
        attempt("engine", `printf x >> '${engineFile}'`),
        attempt("verifier", `echo 'process.exit(0)' > '${verifier}'`),
        attempt("dependency", `echo 'export default 0;' > '${dependency}'`),
        attempt("report", `echo forged > '${output}/report.json'`),
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
      { encoding: "utf8", timeout: 60000, stdio: "pipe", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } }),
      // The fake agent creates no record, so the run fails afterwards -- but not on a tamper check.
      (error) => !/modified|Agent left/.test(String(error.stderr)));
      assert.deepEqual((await readFile(path.join(target, "observed"), "utf8")).trim().split("\n"),
        ["receipt=DENIED", "engine=DENIED", "verifier=DENIED", "dependency=DENIED", "report=DENIED", "remount=DENIED"]);
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
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-e2e-isolated-reset-"));
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
      (error) => /ACCEPTANCE_RECORD_REPLACED/.test(String(error.stderr)));
      const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
      assert.equal(report.verdict, "FAIL");
      assert.equal(report.security.isolation, "OS_NAMESPACE");
      assert.equal(report.security.trustedRuntimeIsolated, true);
      assert.equal(report.security.certified, false);
      assert.match(report.failure, /ACCEPTANCE_RECORD_REPLACED/);
      assert.ok(report.security.recordContinuity.targetDirectoryRenameEvents >= 2);
      assert.equal(report.agent.exitCode, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("under OS isolation a verifier in a broad directory (an ancestor of HOME) seals its script and node_modules, not HOME",
  { skip: isolationAvailable ? false : "unprivileged user/mount/PID namespaces are unavailable on this host" }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-e2e-broad-"));
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
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-e2e-uid0-"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-e2e-euid0-"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-e2e-bundle-"));
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

test("Codex approves exactly the nine engine tools, per tool, and keeps approval_policy never", () => {
  const { argv } = commandFor("codex", "$start-migration discounts", "/consumer/target");
  const overrides = argv.filter((_, i) => argv[i - 1] === "-c");
  assert.deepEqual(overrides, [
    'projects={ "/consumer/target" = { trust_level = "trusted" } }', 'approval_policy="never"',
    `mcp_servers.start-migration.enabled_tools=${JSON.stringify(CODEX_MCP_TOOLS)}`,
    ...CODEX_MCP_TOOLS.map((tool) => `mcp_servers.start-migration.tools.${tool}.approval_mode="approve"`),
    'model_reasoning_effort="high"']);
  assert.equal(argv[argv.indexOf("-m") + 1], "gpt-6.1-sol");
  assert.deepEqual(CODEX_MCP_TOOLS, ["artifact_status", "artifact_run", "migration_status", "migration_scan",
    "migration_evidence_binding", "migration_prefill", "migration_capture", "migration_pending_decisions", "migration_run"]);
  // No server-wide default, no relay grant, no sandbox escalation, no other server.
  assert.doesNotMatch(argv.join(" "), /default_tools_approval_mode|migration_relay_decision|danger|bypass|mcp_servers\.(?!start-migration\.)/);
  assert.deepEqual(argv.slice(0, 6), ["exec", "--json", "--sandbox", "workspace-write", "--add-dir", "/consumer/target/.agents"]);
});

test("the runner fails visibly on bad arguments run directly or through a symlink, and importing it runs nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "amt-entry-"));
  try {
    const link = path.join(dir, "acceptance.mjs");
    await symlink(fileURLToPath(script), link);
    for (const entry of [fileURLToPath(script), link]) {
      const run = spawnSync(process.execPath, [entry, "--bogus", "x"], { encoding: "utf8" });
      assert.equal(run.status, 1, entry);
      assert.match(run.stderr, /AGENT_ACCEPTANCE_ERROR: Expected unique --provider/, entry);
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

test('artifact acceptance uses the installed artifact CLI and independent verifier pin', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-e2e-artifact-'));
  try {
    const { target, bin, receipt, verifier } = await installedArtifactCandidate(root);
    const cli = JSON.parse(receipt).commands['artifact-migrate'];
    await writeFile(path.join(bin, 'opencode'), '#!/bin/sh\nexec ' + cli.map(x => "'" + x + "'").join(' ') +
      " legacy/source.js --target src/result.js --mode auto --json\n", { mode: 0o755 });
    const output = path.join(root, 'reports');
    execFileSync(process.execPath, [script.pathname, '--provider', 'opencode', '--cwd', target, '--module', 'auth',
      '--target', 'auth', '--output', output, '--kind', 'artifact', '--source', 'legacy/source.js', '--source-root', target,
      '--artifact-target', 'src/result.js', '--isolation', 'none'],
    { timeout: 60000, stdio: 'pipe', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
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
    await writeFile(verifier, 'process.exit(1);');
    const second = spawnSync(process.execPath, [script.pathname, '--provider', 'opencode', '--cwd', target, '--module', 'auth',
      '--target', 'auth', '--output', path.join(root, 'second'), '--kind', 'artifact', '--source', 'legacy/source.js',
      '--source-root', target, '--artifact-target', 'src/result.js', '--isolation', 'none'], { encoding: 'utf8' });
    assert.match(second.stderr, /verifier digest does not match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('read-only consumer is sealed and unchanged',
  { skip: isolationAvailable ? false : 'unprivileged namespaces unavailable' }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-e2e-readonly-'));
    try {
      const { target, bin, pin } = await installedCandidate(root);
      await writeFile(path.join(bin, 'opencode'), '#!/bin/sh\nif touch should-not-exist; then exit 9; fi\necho read-only filesystem\n', { mode: 0o755 });
      const output = path.join(root, 'report');
      const result = spawnSync(process.execPath, [script.pathname, '--provider', 'opencode', '--cwd', target, '--module', 'auth',
        '--target', 'auth', '--output', output, '--scenario', 'read-only', '--expected-pin', pin],
      { timeout: 60000, stdio: 'pipe', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
      const report = JSON.parse(await readFile(path.join(output, 'report.json')));
      assert.equal(result.status, 0, JSON.stringify(report));
      assert.equal(report.verdict, 'SAFETY_REFUSAL_PASS');
      assert.equal(report.safety.unchanged, true);
      assert.ok(report.security.readOnly.includes(target));
      assert.equal(report.security.certified, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('live and abandoned scenarios retain genuine owner proof across PID isolation',
  { skip: isolationAvailable ? false : 'unprivileged namespaces unavailable' }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-e2e-locks-'));
    try {
      const { target, bin, pin, release } = await installedCandidate(root);
      const lockModule = new URL('../packages/migration-engine/src/lifecycle/lock.mjs', new URL('file://' + release + '/scripts/')).href;
      const probe = path.join(root, 'lock-probe.mjs');
      await writeFile(probe, `const { acquireModuleLock } = await import(${JSON.stringify(lockModule)});\n` +
        `try { await (await acquireModuleLock(process.cwd(), 'auth', { timeoutMs: 50 }))(); console.log('unexpected acquire'); }\n` +
        `catch(e) { console.log(e.message); }\n`);
      await writeFile(path.join(bin, 'opencode'), `#!/bin/sh\nexec '${process.execPath}' '${probe}'\n`, { mode: 0o755 });
      for (const scenario of ['live-lock', 'abandoned-lock']) {
        const output = path.join(root, scenario);
        const result = spawnSync(process.execPath, [script.pathname, '--provider', 'opencode', '--cwd', target, '--module', 'auth',
          '--target', 'auth', '--output', output, '--scenario', scenario, '--expected-pin', pin],
        { timeout: 60000, encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
        const report = JSON.parse(await readFile(path.join(output, 'report.json')));
        assert.equal(report.security.certified, false);
        assert.deepEqual(report.lock.before, report.lock.after);
        if (scenario === 'live-lock') {
          assert.equal(result.status, 0, result.stderr);
          assert.equal(report.lock.holderAliveAfter, true);
          assert.equal(report.verdict, 'SAFETY_REFUSAL_PASS');
        } else {
          assert.equal(result.status, 1);
          assert.equal(report.lock.ownerExited, true);
          assert.equal(report.lock.recovery, 'BLOCKED_OWNER_PROOF');
          assert.match(report.failure, /ACCEPTANCE_LOCK_OWNER_PROOF/);
        }
      }
      // Failure control: an agent that deletes the abandoned lock by hand must never pass.
      await rm(lockPathFor(target, 'auth'), { recursive: true }); // fixture reset: the runner refuses a pre-existing lock
      await writeFile(path.join(bin, 'opencode'), `#!/bin/sh\nrm -rf .agents/knowledge/migrations/locks/auth.lock\nexec '${process.execPath}' '${probe}'\n`, { mode: 0o755 });
      const removed = spawnSync(process.execPath, [script.pathname, '--provider', 'opencode', '--cwd', target, '--module', 'auth',
        '--target', 'auth', '--output', path.join(root, 'removed'), '--scenario', 'abandoned-lock', '--expected-pin', pin],
      { timeout: 60000, encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
      const report = JSON.parse(await readFile(path.join(root, 'removed/report.json')));
      assert.equal(removed.status, 1);
      assert.equal(report.lock.after, null);
      assert.equal(report.lock.recovery, 'REMOVED_WITHOUT_OWNER_PROOF');
      assert.match(report.failure, /ACCEPTANCE_LOCK_REMOVED/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('checkpoint waits for committed state and preserves history, integrity and frozen bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'checkpoint-'));
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'tree-evidence-'));
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
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real lock owner survives contention and only same-realm proven death allows recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owner-proof-'));
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'interrupt-control-'));
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
  const native = commandFor('codex', '/migrate-artifact source.js', '/target', true);
  assert.deepEqual(native.argv.slice(1), headless.argv.slice(2, -1));
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
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-e2e-resume-'));
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

test('native launcher records a real PTY without awarding native UI acceptance',
  { skip: isolationAvailable && process.version === 'v22.13.0' ? false : 'requires namespaces and pinned Node' }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent'e2e-native-"));
    try {
      const { target, bin, receipt } = await installedCandidate(root);
      const installed = JSON.parse(receipt);
      installed.provider = 'codex';
      await writeFile(path.join(target, '.artifact-migration-tools/codex.json'), JSON.stringify(installed));
      await mkdir(path.join(target, '.agents/skills'), { recursive: true });
      await writeFile(path.join(bin, 'codex'), '#!/bin/sh\nif [ "$1" = --version ]; then echo codex-cli 0.165.0; else test -t 0 && echo LOCAL_TEST_PTY_VISIBLE; fi\n', { mode: 0o755 });
      const output = path.join(root, 'report');
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      const command = [process.execPath, script.pathname, '--provider', 'codex', '--cwd', target, '--module', 'auth',
        '--target', 'auth', '--output', output, '--ui', 'native'].map(quote).join(' ');
      const result = spawnSync('script', ['--quiet', '--return', '--command', command, '/dev/null'],
        { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }, encoding: 'utf8', timeout: 60000 });
      assert.equal(result.status, 1); // mock provider cannot create a migration record
      const report = JSON.parse(await readFile(path.join(output, 'report.json')));
      assert.equal(report.presentation.nativeUiCertified, false);
      assert.equal(report.security.certified, false);
      assert.match(await readFile(path.join(output, 'native.typescript'), 'utf8'), /LOCAL_TEST_PTY_VISIBLE/);
      assert.ok((await readFile(path.join(output, 'native.timing'))).length);
      await writeFile(path.join(bin, 'codex'), '#!/bin/sh\necho codex-cli 0.166.0\n', { mode: 0o755 });
      const drift = spawnSync(process.execPath, [script.pathname, '--provider', 'codex', '--cwd', target, '--module', 'auth',
        '--target', 'auth', '--output', path.join(root, 'version-drift')],
      { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }, encoding: 'utf8', timeout: 60000 });
      assert.equal(drift.status, 1);
      assert.match(drift.stderr, /require Codex 0.165.0 and Node 22.13.0/);
      assert.equal(JSON.parse(await readFile(path.join(root, 'version-drift/report.json'))).agent, undefined);

    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('official launcher binds external committed-harness pins and a clean tree; complete patch survives staging and commit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'm15 launcher '));
  const base = 'd7eb28ca9d555c0d2f0d3b7965ef3464c9f7218d';
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const fixture = path.join(root, 'fixture');
  try {
    execFileSync('git', ['clone', '--shared', '--no-checkout', '--quiet', repo, fixture], { stdio: 'pipe' });
    const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: 'pipe' }).trim();
    // Shallow CI checkouts lack the pinned BASE: fetch exactly that commit into the disposable fixture only.
    if (spawnSync('git', ['cat-file', '-e', `${base}^{commit}`], { cwd: fixture, stdio: 'ignore' }).status !== 0)
      git('fetch', '--quiet', '--no-tags', '--depth=1',
        execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim(), base);
    assert.equal(git('rev-parse', '--verify', `${base}^{commit}`), base, 'pinned BASE commit is present');
    git('checkout', '--quiet', '--detach', base);
    for (const file of ['m15-patch.sh', 'm15-official-run.sh'])
      await cp(path.join(repo, 'scripts', file), path.join(fixture, 'scripts', file));
    const added = path.join(fixture, 'new harness file.txt');
    await writeFile(added, 'reviewed bytes\n');
    await appendFile(path.join(fixture, 'README.md'), '\nLocal fixture delta.\n');
    const patch = () => execFileSync('bash', ['scripts/m15-patch.sh'], { cwd: fixture });
    const reviewed = patch();
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
      AMT_HARNESS_COMMIT: approvedCommit, AMT_PATCH_SHA256: digest, AMT_PROFILE: path.join(root, 'unused-profile') };
    const launch = (overrides = {}) => spawnSync('bash', ['scripts/m15-official-run.sh'],
      { cwd: fixture, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000 });
    const accepted = launch();
    assert.notEqual(accepted.status, 0); // Deliberate stop before any binary can execute.
    assert.match(accepted.stderr, /BINARY_CHECK_REACHED/);
    for (const pins of [{ AMT_HARNESS_COMMIT: '' }, { AMT_PATCH_SHA256: '' }, { AMT_HARNESS_COMMIT: base },
      { AMT_HARNESS_COMMIT: approvedCommit.slice(0, 8) }, { AMT_PATCH_SHA256: '0'.repeat(64) }]) {
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
const provisionedPnpm = '/home/utmwac/.cache/amt-pnpm/pnpm-11.21.0.tgz';

test('official launcher puts only the verified pinned pnpm first on PATH; a missing or altered tarball refuses', async (t) => {
  const launcher = await readFile(new URL('../scripts/m15-official-run.sh', import.meta.url), 'utf8');
  assert.match(launcher, /^AMT_PNPM_BIN=\$\(bash "\$AMT_REPO\/scripts\/m15-pnpm\.sh" \/home\/utmwac\/\.cache\/amt-pnpm\/pnpm-11\.21\.0\.tgz\)$/m);
  assert.match(launcher, /^exec env -i PATH="\$AMT_PNPM_BIN:/m);
  assert.match(launcher, /^test "\$\(sha256sum "\$AMT_NODE" \| cut -d' ' -f1\)" = af8d5d1e234beb26b3095e6bebf80edc781f79c9435553a383037eccec2716f8$/m);
  const root = await mkdtemp(path.join(os.tmpdir(), 'm15 pnpm '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = spawnSync('bash', [pnpmHelper, path.join(root, 'pnpm-11.21.0.tgz')], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /PNPM_MISSING/);
  await writeFile(path.join(root, 'forged.tgz'), 'not pnpm\n');
  const altered = spawnSync('bash', [pnpmHelper, path.join(root, 'forged.tgz')], { encoding: 'utf8' });
  assert.notEqual(altered.status, 0);
  assert.match(altered.stderr, /PNPM_HASH_MISMATCH/);
  assert.equal(altered.stdout, '');
  assert.deepEqual(await readdir(root), ['forged.tgz'], 'a refused tarball leaves no unpacked run behind');
});

test('the verified pinned pnpm tarball starts pnpm 11.21.0 and pnpx',
  { skip: existsSync(provisionedPnpm) ? false : `requires the provisioned ${provisionedPnpm}` }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'm15 pnpm '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(provisionedPnpm, path.join(root, 'pnpm-11.21.0.tgz'));
  const bin = execFileSync('bash', [pnpmHelper, path.join(root, 'pnpm-11.21.0.tgz')], { encoding: 'utf8' }).trim();
  assert.ok(bin.startsWith(path.join(root, 'pnpm-11.21.0.tgz.run.')), bin);
  const env = { PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: root };
  assert.equal(execFileSync('pnpm', ['--version'], { cwd: root, env, encoding: 'utf8' }).trim(), '11.21.0');
  assert.equal(execFileSync('bash', ['-c', 'command -v pnpx'], { env, encoding: 'utf8' }).trim(), path.join(bin, 'pnpx'));
});
