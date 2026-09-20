/**
 * Every declared `bin` names a module that exists and runs *through the link*.
 *
 * A package `bin` is a symlink: `npm` points `node_modules/.bin/<name>`
 * straight at the module. Node resolves an ES module to its realpath but
 * leaves `process.argv[1]` as the typed link, so the `import.meta.url ===
 * argv[1]` main-guard every entry point used to carry was false through a bin
 * and the command exited 0 having done nothing. Silence reads as success,
 * which for a fail-closed CLI is the worst shape a defect can take -- so the
 * proof has to invoke the link, not the module.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = path.dirname(new URL(import.meta.url).pathname);
const enginePackage = path.resolve(here, "../..");

const manifest = JSON.parse(
  await readFile(path.join(enginePackage, "package.json"), "utf8"),
);

/** Run a command and return everything it printed, whatever its exit code. */
const run = async (command, args, cwd) => {
  const result = await execFileAsync(process.execPath, [command, ...args], {
    encoding: "utf8",
    cwd,
  }).catch((error) => error);
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    code: result.code ?? 0,
  };
};

test("every bin names a module inside the package", async () => {
  const entries = Object.entries(manifest.bin);
  assert.equal(entries.length, 10, "ten entry points, one per public command");
  for (const [name, relative] of entries) {
    const target = path.join(enginePackage, relative);
    assert.ok(
      target.startsWith(`${enginePackage}${path.sep}`),
      `${name} escapes the package`,
    );
    const source = await readFile(target, "utf8");
    assert.match(
      source,
      /^#!\/usr\/bin\/env node\n/,
      `${name} -> ${relative} needs a shebang: a bin is a symlink on POSIX`,
    );
    assert.ok(
      source.includes("isMainModule(import.meta.url)"),
      `${name} -> ${relative} must use the symlink-safe main guard`,
    );
  }
});

test("each bin does real work when invoked through its symlink", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX bin symlinks; Windows gets a generated cmd shim instead");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "amt bins "));
  try {
    // A consumer-shaped working directory, so `--doctor` has something to
    // answer about and the other commands reach their own argument handling.
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify({ name: "consumer", private: true }, null, 2)}\n`,
    );
    for (const [name, relative] of Object.entries(manifest.bin)) {
      const link = path.join(root, name);
      await symlink(path.join(enginePackage, relative), link);
    }

    // `--doctor` is the one command with a read-only answer that needs no
    // record: through the link it must print its report, not nothing.
    const doctor = await run(path.join(root, "artifact-migration-discover"), ["--doctor"], root);
    assert.match(
      doctor.output,
      /"outcome":/,
      `--doctor through a bin symlink printed nothing:\n${doctor.output}`,
    );
    assert.equal(JSON.parse(doctor.output).checks.length > 0, true);

    // The rest are proven by reaching their own diagnosis rather than by
    // exiting silently. A no-op guard produces empty output and code 0.
    for (const name of [
      "artifact-migration-run",
      "artifact-migration-advance",
      "artifact-migration-validate",
      "artifact-migration-registry",
      "artifact-migration-decision",
      "artifact-migration-upgrade",
      "artifact-migrate",
      "artifact-migration-toolkit",
    ]) {
      const { output } = await run(path.join(root, name), [], root);
      assert.ok(
        output.trim().length > 0,
        `${name} produced no diagnosis through its bin symlink`,
      );
      assert.ok(
        !output.includes("Cannot find module"),
        `${name} did not resolve: ${output}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
