import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildRelease } from "../scripts/release.mjs";
import { CODEX_MCP_TOOLS, commandFor } from "../scripts/agent-e2e-acceptance.mjs";
import { candidateReleaseRoot } from "../packages/migration-engine/test/support/candidate-release-root.mjs";

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
      "artifact-migration-discover": [process.execPath,
        path.join(release, "packages/migration-engine", pkg.bin["artifact-migration-discover"])],
    } });
  await writeFile(receiptPath, receipt);
  return { target, bin, verifier, pin, release, receiptPath, receipt };
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
      "--target", "auth", "--output", path.join(os.tmpdir(), "acceptance-report")];
    assert.match(failRun(argv), /ENOENT/);
    const verifier = path.join(root, "trusted-verifier.mjs");
    await writeFile(verifier, "process.exit(0);\n");
    await writeFile(path.join(root, ".artifact-migration-acceptance.json"),
      JSON.stringify({ disposable: true, module: "auth", target: "auth", verifier,
        verifierSha256: createHash("sha256").update("process.exit(0);\n").digest("hex") }));
    assert.match(failRun(argv), /verifier must reside OUTSIDE/);
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
    ...CODEX_MCP_TOOLS.map((tool) => `mcp_servers.start-migration.tools.${tool}.approval_mode="approve"`)]);
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
