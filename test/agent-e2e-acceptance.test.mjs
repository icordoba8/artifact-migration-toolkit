import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRelease } from "../scripts/release.mjs";
import { candidateReleaseRoot } from "../packages/migration-engine/test/support/candidate-release-root.mjs";

const script = new URL("../scripts/agent-e2e-acceptance.mjs", import.meta.url);

/** A disposable consumer with a genuinely built, verified candidate installed for opencode. */
const installedCandidate = async (root) => {
  const target = path.join(root, "target"), bin = path.join(root, "bin");
  await mkdir(path.join(target, ".opencode/skills"), { recursive: true });
  await mkdir(path.join(target, ".artifact-migration-tools"));
  await mkdir(bin);
  const verifier = path.join(root, "verify.mjs");
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

const isolationAvailable = (() => {
  try {
    execFileSync("unshare", ["--user", "--map-root-user", "--mount", "--pid", "--fork", "--mount-proc", "--kill-child",
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
      const { target, bin, verifier, release, receiptPath, receipt } = await installedCandidate(root);
      const output = path.join(root, "reports");
      const engineFile = path.join(release, "packages/migration-engine/package.json");
      const engineBytes = await readFile(engineFile, "utf8");
      const canary = path.join(root, "late-write");
      const attempt = (label, command) => `(${command}) 2>/dev/null && echo ${label}=WRITABLE >> observed || echo ${label}=DENIED >> observed`;
      await writeFile(path.join(bin, "opencode"), ["#!/bin/sh",
        attempt("receipt", "echo hacked > .artifact-migration-tools/opencode.json"),
        attempt("engine", `printf x >> '${engineFile}'`),
        attempt("verifier", `echo 'process.exit(0)' > '${verifier}'`),
        attempt("report", `echo forged > '${output}/report.json'`),
        attempt("remount", `mount -o remount,bind,rw '${release}'`),
        `(sleep 1; echo late > '${canary}') &`, ""].join("\n"), { mode: 0o755 });
      assert.throws(() => execFileSync(process.execPath, [script.pathname, "--provider", "opencode", "--cwd", target,
        "--module", "auth", "--target", "auth", "--output", output],
      { encoding: "utf8", timeout: 60000, stdio: "pipe", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } }),
      // The fake agent creates no record, so the run fails afterwards -- but not on a tamper check.
      (error) => !/modified|Agent left/.test(String(error.stderr)));
      assert.deepEqual((await readFile(path.join(target, "observed"), "utf8")).trim().split("\n"),
        ["receipt=DENIED", "engine=DENIED", "verifier=DENIED", "report=DENIED", "remount=DENIED"]);
      assert.equal(await readFile(receiptPath, "utf8"), receipt);
      assert.equal(await readFile(engineFile, "utf8"), engineBytes);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await assert.rejects(readFile(canary), { code: "ENOENT" });
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
