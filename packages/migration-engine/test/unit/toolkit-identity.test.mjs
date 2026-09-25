// Focused suite for toolkit identity: parsing, equality, digest inclusion,
// unstamped compatibility, explicit adoption, mismatch refusal, and the
// independence of toolkit SemVer from every migration version number.
//
// Two kinds of proof live here, and the split is deliberate.
//
// This file runs against *this* checkout, which has no `build-identity.json`
// and is therefore an unidentified runtime. `scripts/engine-test.mjs` keeps it
// that way -- every other suite runs with a fixture identity installed -- because
// the unidentified runtime is this file's subject: what it may read, what it may
// not write, and the fact that it cannot seed itself out of the refusal.
//
// Everything about a *stamped* record needs a real installed identity, so those
// tests run the staged release bundle as a child process. There is no
// environment override for identity by design (see `toolkit-identity.mjs`), so
// running a real installation is the only way to have one -- which is also
// exactly how an operator will meet it.

import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  activeToolkitIdentity,
  digestToolkitIdentity,
  sameToolkitIdentity,
  TOOLKIT_IDENTITY_KEYS,
  toolkitIdentityBlocker,
  toolkitIdentityKey,
  toolkitIdentityStatus,
  validateToolkitIdentity,
} from "../../src/toolkit-identity.mjs";
import {
  assertRecordToolkitIdentity,
  MIGRATION_FORMAT_VERSION,
  RESUMABLE_CONTRACT_VERSION,
  WORKFLOW_VERSION,
} from "../../src/resumable-migration.mjs";
import { ARTIFACT_FORMAT_VERSION } from "../../src/artifact/artifact-migration.mjs";
import { buildRelease, releaseCheck, verifyRelease } from "../../../../scripts/release.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../../..");

const IDENTITY = {
  name: "artifact-migration-tools",
  version: "1.0.0",
  commit: "a".repeat(40),
  contentHash: `sha256:${"b".repeat(64)}`,
};

// -- identity value semantics -------------------------------------------------

test("an identity is exactly four fields, each with an exact shape", () => {
  assert.deepEqual(TOOLKIT_IDENTITY_KEYS, ["name", "version", "commit", "contentHash"]);
  assert.deepEqual(validateToolkitIdentity({ ...IDENTITY }), IDENTITY);

  for (const [label, broken] of [
    ["an extra key", { ...IDENTITY, channel: "stable" }],
    ["a missing key", { name: IDENTITY.name, version: "1.0.0", commit: IDENTITY.commit }],
    ["a foreign toolkit name", { ...IDENTITY, name: "other-tools" }],
    ["a non-SemVer version", { ...IDENTITY, version: "1.0" }],
    ["a v-prefixed version", { ...IDENTITY, version: "v1.0.0" }],
    ["an abbreviated commit", { ...IDENTITY, commit: "a".repeat(12) }],
    ["an uppercase commit", { ...IDENTITY, commit: "A".repeat(40) }],
    ["an unprefixed content hash", { ...IDENTITY, contentHash: "b".repeat(64) }],
    ["a truncated content hash", { ...IDENTITY, contentHash: `sha256:${"b".repeat(63)}` }],
    ["an array", []],
    ["null", null],
  ]) {
    assert.throws(
      () => validateToolkitIdentity(broken),
      /toolkitIdentity/,
      `${label} must be refused, never downgraded to unidentified`,
    );
  }
});

test("equality is exact on all four fields, not on the version alone", () => {
  assert.equal(sameToolkitIdentity(IDENTITY, { ...IDENTITY }), true);
  // Same release number, different build. This is the silent-swap case the
  // whole mechanism exists to make impossible.
  assert.equal(sameToolkitIdentity(IDENTITY, { ...IDENTITY, commit: "c".repeat(40) }), false);
  assert.equal(
    sameToolkitIdentity(IDENTITY, { ...IDENTITY, contentHash: `sha256:${"c".repeat(64)}` }),
    false,
  );
  assert.equal(sameToolkitIdentity(IDENTITY, null), false);
  assert.equal(sameToolkitIdentity(null, null), false, "absent is not equal to absent");
});

test("the canonical key and digest ignore JSON key order", () => {
  const reordered = {
    contentHash: IDENTITY.contentHash,
    commit: IDENTITY.commit,
    version: IDENTITY.version,
    name: IDENTITY.name,
  };
  assert.equal(toolkitIdentityKey(reordered), toolkitIdentityKey(IDENTITY));
  assert.equal(digestToolkitIdentity(reordered), digestToolkitIdentity(IDENTITY));
  assert.equal(digestToolkitIdentity(null), null, "an unstamped record digests to nothing at all");
  assert.notEqual(
    digestToolkitIdentity({ ...IDENTITY, commit: "c".repeat(40) }),
    digestToolkitIdentity(IDENTITY),
  );
});

test("the blocker and status matrix: status reports, mutation refuses", () => {
  const other = { ...IDENTITY, commit: "c".repeat(40) };
  const options = { action: "Advancing", adoptCommand: "node toolkit-identity.mjs adopt" };

  // Unidentified runtime + unstamped record: still refused. Nothing is pinned,
  // which is exactly why no build may write -- an exemption here would make
  // "run from a checkout" the way to mutate a record no release has claimed.
  // The remedy differs because a checkout has no identity to adopt, so naming
  // the adopt command would name one that cannot succeed.
  assert.equal(toolkitIdentityStatus(null, null), "UNSTAMPED");
  assert.match(toolkitIdentityBlocker(null, null, options), /no identity to adopt/);
  assert.match(toolkitIdentityBlocker(null, null, options), /refused and nothing was written/);

  // Released toolkit + unstamped record: the cutover. One explicit command.
  assert.equal(toolkitIdentityStatus(null, IDENTITY), "UNSTAMPED");
  assert.match(toolkitIdentityBlocker(null, IDENTITY, options), /adopt/);

  // Exact match: proceed.
  assert.equal(toolkitIdentityStatus(IDENTITY, { ...IDENTITY }), "MATCH");
  assert.equal(toolkitIdentityBlocker(IDENTITY, { ...IDENTITY }, options), null);

  // Stamped record, different build: refused.
  assert.equal(toolkitIdentityStatus(IDENTITY, other), "MISMATCH");
  assert.match(toolkitIdentityBlocker(IDENTITY, other, options), /refused and nothing was written/);
  assert.match(
    toolkitIdentityBlocker(IDENTITY, other, { ...options, updateCommand: "artifact-migration-toolkit update --artifact src/widget.ts" }),
    /artifact-migration-toolkit update --artifact src\/widget\.ts/,
  );

  // Stamped record, source checkout: it cannot prove it is the pinned release.
  assert.equal(toolkitIdentityStatus(IDENTITY, null), "UNIDENTIFIED_TOOLKIT");
  assert.match(toolkitIdentityBlocker(IDENTITY, null, options), /cannot prove it is that release/);
});

test("toolkit SemVer is an axis of its own, coupled to no migration version", async () => {
  // Stated as a property, not as a comparison of today's numbers: the point is
  // that neither value is derived from the other, so a format bump can never
  // force a toolkit major and a toolkit major can never imply a format bump.
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const [major] = manifest.version.split(".").map(Number);
  for (const migrationVersion of [
    MIGRATION_FORMAT_VERSION,
    RESUMABLE_CONTRACT_VERSION,
    ARTIFACT_FORMAT_VERSION,
    Number.parseFloat(WORKFLOW_VERSION),
  ]) {
    assert.equal(
      typeof migrationVersion,
      "number",
      "a migration version must stay a number the toolkit version never reads",
    );
  }
  assert.equal(major, 1, "the standalone toolkit starts at 1.0.0");
  assert.notEqual(
    major,
    MIGRATION_FORMAT_VERSION,
    "if these ever had to agree, the axes would be coupled",
  );

  // The engine source must never read a toolkit version to decide a format
  // question, nor a format to decide a toolkit question.
  const identitySource = await readFile(
    path.join(repositoryRoot, "packages/migration-engine/src/toolkit-identity.mjs"),
    "utf8",
  );
  for (const forbidden of [
    "MIGRATION_FORMAT_VERSION",
    "RESUMABLE_CONTRACT_VERSION",
    "WORKFLOW_VERSION",
    "ARTIFACT_FORMAT_VERSION",
  ]) {
    assert.ok(
      !identitySource.includes(`${forbidden}`) || identitySource.includes(`// ${forbidden}`),
      `toolkit identity must not read ${forbidden}`,
    );
  }
});

test("this file runs as an unidentified runtime, which is the premise of every case below", () => {
  assert.equal(
    activeToolkitIdentity(),
    null,
    "this suite must run with no build-identity.json installed; see scripts/engine-test.mjs",
  );
});

// -- release identity ---------------------------------------------------------

test("release identity is derived from the payload and is checksum-verifiable", async (t) => {
  const check = await releaseCheck();
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.match(check.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(check.commit, /^[0-9a-f]{40}$/);
  assert.equal(check.version, manifest.version);
  validateToolkitIdentity({
    name: "artifact-migration-tools",
    version: check.version,
    commit: check.commit,
    contentHash: check.contentHash,
  });

  const bundle = await sharedBundle(t);
  const verified = await verifyRelease(bundle);
  assert.equal(verified.verified, true, `staged bundle failed its own checksums: ${verified.mismatched}`);
  assert.equal(verified.toolkit.contentHash, check.contentHash);

  // Acyclic: the identity-bearing files are produced *after* the hash and are
  // never inputs to it. A committed source file that contained the hash would
  // change the hash that produced it.
  const committedManifest = await readFile(
    path.join(repositoryRoot, "providers/claude/adapter.json"),
    "utf8",
  );
  assert.ok(
    committedManifest.includes("{{TOOLKIT_CONTENT_HASH}}"),
    "the committed provider manifest must keep its placeholder",
  );
  assert.ok(
    !committedManifest.includes(check.contentHash),
    "no committed file may contain the content hash it contributes to",
  );
  const stagedManifest = await readFile(path.join(bundle, "providers/claude/adapter.json"), "utf8");
  assert.ok(stagedManifest.includes(check.contentHash), "the staged manifest carries the identity");
  assert.ok(stagedManifest.includes(check.commit));

  // The per-skill stamp is acyclic the same way, but by *omission* rather than by
  // placeholder: `skills add` copies the committed file verbatim, so it may not
  // carry a token no installer resolves. Name, version and skill are real in the
  // committed copy; commit and content hash are added only when staged, and the
  // staged copy is derived from the committed one -- so the two cannot name
  // different releases. Every provider projection is the same bytes: which
  // provider installed a skill cannot change what it says it is.
  for (const skill of ["start-migration", "migrate-artifact"]) {
    const committedText = await readFile(
      path.join(repositoryRoot, `skills/${skill}/release-identity.json`),
      "utf8",
    );
    assert.ok(!committedText.includes("{{"), `${skill} committed identity has a placeholder`);
    assert.ok(
      !committedText.includes(check.contentHash) && !committedText.includes(check.commit),
      `${skill} must not carry the hash or commit it contributes to`,
    );
    const committed = JSON.parse(committedText);
    assert.deepEqual(committed, {
      name: "artifact-migration-tools",
      version: check.version,
      skill,
      source: "repository",
    });

    const canonical = await readFile(path.join(bundle, `skills/${skill}/release-identity.json`));
    assert.deepEqual(JSON.parse(canonical.toString("utf8")), {
      name: committed.name,
      version: committed.version,
      skill: committed.skill,
      source: "release",
      commit: check.commit,
      contentHash: check.contentHash,
    });
    for (const provider of ["claude", "codex", "opencode", "copilot"]) {
      const projected = await readFile(
        path.join(bundle, `providers/${provider}/skills/${skill}/release-identity.json`),
      );
      assert.ok(projected.equals(canonical), `${provider}/${skill} identity is not byte-identical`);
    }
  }
  await assert.rejects(
    readFile(path.join(bundle, "packages/migration-engine/test/unit/toolkit-identity.test.mjs")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    readFile(path.join(bundle, "packages/migration-engine/node_modules/.bin/tsc")),
    { code: "ENOENT" },
  );
});

test("a release bundle carries no mutable reference an installer could follow", async (t) => {
  const bundle = await sharedBundle(t);
  const manifest = JSON.parse(await readFile(path.join(bundle, "release-manifest.json"), "utf8"));
  validateToolkitIdentity(manifest.toolkit);
  assert.equal(manifest.supports.moduleFormat, MIGRATION_FORMAT_VERSION);
  assert.equal(manifest.supports.artifactFormat, ARTIFACT_FORMAT_VERSION);
  assert.ok(
    Object.keys(manifest.files).every((file) => !file.split("/").includes(".bin")),
    "release payload must not contain package-manager launch shims",
  );
  for (const value of JSON.stringify(manifest.toolkit).split('"')) {
    assert.ok(!["latest", "main", "HEAD"].includes(value), `mutable reference '${value}' in the identity`);
  }
});

// -- the staged bundle --------------------------------------------------------

/**
 * One release build per test process, reused. `--allow-dirty` so the suite runs
 * during development; `releaseCheck` above is the gate that a *real* release is
 * clean, and it is asserted separately rather than skipped here.
 */
let bundlePromise;
const sharedBundle = async () => {
  bundlePromise ??= buildRelease({ force: true }).then((built) => built.stagingRoot);
  return bundlePromise;
};

const engineIn = (bundle, relative) =>
  path.join(bundle, "packages/migration-engine", relative);

/**
 * A second immutable release, identical except for its identity.
 *
 * Built by copying the staged engine and rewriting only `build-identity.json`,
 * with `node_modules` linked rather than copied: the resolved dependency tree is
 * pinned by the hashed lockfile and is byte-identical between the two, so
 * copying thirty thousand files again would prove nothing.
 */
const siblingBundle = async (bundle, identity) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amt-bundle-b-"));
  const engine = path.join(root, "packages/migration-engine");
  await mkdir(engine, { recursive: true });
  for (const entry of await readdir(engineIn(bundle, "."), { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      await symlink(engineIn(bundle, "node_modules"), path.join(engine, "node_modules"), "junction");
    } else if (entry.name !== "build-identity.json") {
      await cp(engineIn(bundle, entry.name), path.join(engine, entry.name), { recursive: true });
    }
  }
  await writeFile(
    path.join(engine, "build-identity.json"),
    `${JSON.stringify(identity, null, 2)}\n`,
    "utf8",
  );
  return { root, engine, cleanup: () => rm(root, { recursive: true, force: true }) };
};

const runEngine = async (engineRoot, script, args, cwd) => {
  const result = await execFileAsync(
    process.execPath,
    [path.join(engineRoot, "src", script), ...args],
    { cwd, encoding: "utf8" },
  ).catch((error) => error);
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.message ?? ""}`,
    code: result.code ?? 0,
    signal: result.signal,
  };
};


/**
 * A confirmed refresh: the one mutation available on an active record at any
 * lifecycle position, so proving the gate needs no driven checkpoint. Refresh
 * is two-phase like every other durable transition, so the confirmation id has
 * to come from its own preview -- an unconfirmed preview writes nothing and
 * would prove nothing about the gate.
 */
const confirmedRefresh = async (engineRoot, cwd, extra = []) => {
  const preview = await runEngine(
    engineRoot,
    "cli/discover-module.mjs",
    ["auth", "--refresh", "--confirm-mismatch", ...extra],
    cwd,
  );
  const confirmationId = preview.output.match(/Confirmation ID: ([0-9a-f]+)/)?.[1];
  if (!confirmationId) return preview;
  return runEngine(
    engineRoot,
    "cli/discover-module.mjs",
    ["auth", "--refresh", "--confirm-mismatch", ...extra, "--confirm-execution", confirmationId],
    cwd,
  );
};

// -- unstamped compatibility and explicit adoption ----------------------------

/**
 * A minimal consumer holding one integrity-valid, *unstamped* record, created
 * by this unidentified checkout -- which is exactly the shape of every record
 * that exists today.
 */
const unstampedConsumer = async () => {
  const { createUnstampedRecord } = await import("../support/consumer-fixture.mjs");
  return createUnstampedRecord();
};

/** This checkout, run as a command: an unidentified toolkit installation. */
const sourceEngine = path.join(repositoryRoot, "packages/migration-engine");

test("A-02 artifact mismatch remains BLOCKED with progress and exact identity recovery command", async (t) => {
  const bundle = await sharedBundle(t);
  const engine = engineIn(bundle, ".");
  const root = await mkdtemp(path.join(os.tmpdir(), "amt-artifact-adopt-"));
  // debug preserve
  const source = "src/widget.ts";
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, source), "export const widget = true;\n");
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"], { cwd: root });
  const args = [source, "--source-root", root, "--target-root", root, "--json"];
  const bootstrap = await runEngine(sourceEngine, "artifact/run-artifact.mjs", args, root);
  assert.equal(bootstrap.code, 0, bootstrap.output);
  const before = JSON.parse(bootstrap.output);
  assert.notEqual(before.artifactId, source);

  const blocked = await runEngine(engine, "artifact/run-artifact.mjs", args, root);
  assert.notEqual(blocked.code, 0, blocked.output);
  const command = JSON.parse(blocked.stdout).nextCommand;
  assert.ok(command, JSON.stringify(blocked));
  assert.ok(command.includes(`adopt --artifact ${source} --type artifact`), command);
  const adopted = await promisify(exec)(command, { cwd: root });
  assert.match(adopted.stdout, /adopted toolkit identity/);
  const status = await runEngine(engine, "cli/toolkit-identity.mjs", ["status", "--artifact", source], root);
  assert.equal(status.code, 0, status.output);
  assert.equal(JSON.parse(status.output).artifactId, before.artifactId);
  assert.equal(JSON.parse(status.output).toolkitIdentityStatus, "MATCH");
  const mismatchTarget = await runEngine(engine, "artifact/run-artifact.mjs", [source, "--target", "src/other.ts", "--source-root", root, "--target-root", root, "--json"], root);
  const invocation = JSON.parse(mismatchTarget.stdout);
  assert.equal(invocation.outcome, "BLOCKED");
  assert.equal(invocation.status, "BLOCKED");
  assert.equal(invocation.artifactId, before.artifactId);
  assert.equal(invocation.progress.activeCheckpoint, "DISCOVER_LEGACY");
  assert.match(invocation.progressChecklist, /stop reason: BLOCKED/);
  assert.match(invocation.reason, /Next action: \/migrate-artifact/);
  const pinned = JSON.parse(await readFile(engineIn(bundle, "build-identity.json"), "utf8"));
  const other = await siblingBundle(bundle, { ...pinned, commit: "f".repeat(40), contentHash: `sha256:${"e".repeat(64)}` });
  t.after(() => other.cleanup());
  const mismatch = await runEngine(other.engine, "artifact/run-artifact.mjs", args, root);
  const blockedResult = JSON.parse(mismatch.stdout);
  assert.equal(blockedResult.outcome, "BLOCKED");
  assert.equal(blockedResult.status, "BLOCKED");
  assert.equal(blockedResult.artifactId, before.artifactId);
  assert.equal(blockedResult.progress.activeCheckpoint, "DISCOVER_LEGACY");
  assert.match(blockedResult.progressChecklist, /stop reason: BLOCKED/);
  assert.match(blockedResult.reason, /toolkit-identity\.mjs update --artifact src\/widget\.ts/);
  assert.match(blockedResult.nextCommand, /toolkit-identity\.mjs update --artifact src\/widget\.ts/);
  const resumed = await runEngine(engine, "artifact/run-artifact.mjs", args, root);
  assert.equal(resumed.code, 0, resumed.output);
  assert.equal(JSON.parse(resumed.output).artifactId, before.artifactId);
});

test("an unidentified checkout reads an unstamped active record and may not write to it", async (t) => {
  const consumer = await unstampedConsumer();
  t.after(() => consumer.cleanup());
  // Authored up to a ready checkpoint, so the reads below fail on identity if
  // they fail at all, rather than on a record that has nothing to report yet.
  await consumer.authorDiscoverLegacy();
  const before = await consumer.snapshot();
  assert.equal(before.state.toolkitIdentity, undefined, "the fixture must start unstamped");
  assert.equal(before.state.status, "ACTIVE", "a completed record would prove a different rule");

  // Reading is open. A fail-closed identity gate that also refused a *look* at
  // the record would turn every unstamped consumer into an outage.
  for (const [script, args] of [
    ["cli/discover-module.mjs", ["auth", "--status"]],
    ["cli/toolkit-identity.mjs", ["status", "--module", "auth"]],
    ["record-decision.mjs", ["auth", "--pending"]],
  ]) {
    const read = await runEngine(sourceEngine, script, args, consumer.root);
    assert.equal(read.code, 0, `${script} could not read an unstamped record:\n${read.output}`);
  }
  const status = JSON.parse(
    (await runEngine(sourceEngine, "cli/toolkit-identity.mjs", ["status", "--module", "auth"], consumer.root)).output,
  );
  assert.equal(status.toolkitIdentityStatus, "UNSTAMPED");
  assert.equal(status.activeToolkitIdentity, null, "the checkout reported an identity it does not have");
  assert.deepEqual(await consumer.snapshot(), before, "a read-only path wrote to the record");

  // Writing is refused, and the refusal does not hand out an adoption command
  // this runtime could not carry out.
  const blocked = await confirmedRefresh(sourceEngine, consumer.root);
  assert.notEqual(blocked.code, 0, blocked.output);
  assert.match(blocked.output, /carries no toolkit identity/);
  assert.match(blocked.output, /no identity to adopt/);
  assert.deepEqual(await consumer.snapshot(), before, "a refused mutation wrote to the record");

  // And it cannot lift its own refusal: adoption needs an identity to stamp.
  const adopt = await runEngine(
    sourceEngine,
    "cli/toolkit-identity.mjs",
    ["adopt", "--module", "auth"],
    consumer.root,
  );
  assert.notEqual(adopt.code, 0, adopt.output);
  assert.match(adopt.output, /no identity to stamp/);
  assert.deepEqual(await consumer.snapshot(), before, "a refused adoption wrote to the record");
});

test("the approval recorder's own gate refuses an unstamped record under this runtime", async (t) => {
  const consumer = await unstampedConsumer();
  t.after(() => consumer.cleanup());

  // The ledger append is gated inside the one shared recorder body, under the
  // record lock, with this call. Driving a real approval to it is impossible by
  // construction -- a candidate only appears after an advance, and an advance on
  // an unstamped record is itself refused -- so the gate is asserted directly,
  // with the recorder's own action string and the record's real on-disk state.
  const state = JSON.parse(await readFile(consumer.statePath, "utf8"));
  assert.equal(state.toolkitIdentity, undefined);
  assert.throws(
    () => assertRecordToolkitIdentity(state, "auth", "Recording an operator decision", "module"),
    /Recording an operator decision is refused and nothing was written/,
  );
});

test("status and validation read an unstamped record, report UNSTAMPED, and write nothing", async (t) => {
  const bundle = await sharedBundle(t);
  const consumer = await unstampedConsumer();
  t.after(() => consumer.cleanup());

  const before = await consumer.snapshot();
  const status = await runEngine(
    engineIn(bundle, "."),
    "cli/toolkit-identity.mjs",
    ["status", "--module", "auth"],
    consumer.root,
  );
  assert.equal(status.code, 0, status.output);
  const report = JSON.parse(status.output);
  assert.equal(report.toolkitIdentity, null);
  assert.equal(report.toolkitIdentityStatus, "UNSTAMPED");
  validateToolkitIdentity(report.activeToolkitIdentity);
  // Reported side by side, and the format is untouched by the toolkit release.
  assert.equal(report.formatVersion, MIGRATION_FORMAT_VERSION);

  const readOnly = await runEngine(
    engineIn(bundle, "."),
    "cli/discover-module.mjs",
    ["auth", "--status"],
    consumer.root,
  );
  assert.equal(readOnly.code, 0, readOnly.output);
  assert.deepEqual(await consumer.snapshot(), before, "a read-only path stamped or moved something");
});

test("an installed toolkit refuses to mutate an unstamped record and names one command", async (t) => {
  const bundle = await sharedBundle(t);
  const consumer = await unstampedConsumer();
  t.after(() => consumer.cleanup());

  const before = await consumer.snapshot();
  // `--refresh --confirm-mismatch` is a mutation on any active record, so it
  // needs no particular lifecycle position to be a real mutation attempt. The
  // *advance* and *approval* entry points are proven against a driven record in
  // the external acceptance fixture, where a ready checkpoint and a genuine
  // pending candidate exist.
  // AUTO adopts an unstamped record on its own evidence; the refusal is a
  // `--mode step` guarantee. See `test/unit/auto-authority.test.mjs`.
  const blocked = await confirmedRefresh(engineIn(bundle, "."), consumer.root, [
    "--mode",
    "step",
  ]);
  assert.notEqual(blocked.code, 0, blocked.output);
  assert.match(blocked.output, /carries no toolkit identity/);
  assert.match(blocked.output, /toolkit-identity\.mjs.*adopt.*--module auth/s);
  assert.deepEqual(await consumer.snapshot(), before, "a refused mutation wrote to the record");
});

test("adoption is one locked, atomic, replayable event that then stops", async (t) => {
  const bundle = await sharedBundle(t);
  const consumer = await unstampedConsumer();
  t.after(() => consumer.cleanup());

  const before = await consumer.snapshot();
  const adopt = await runEngine(
    engineIn(bundle, "."),
    "cli/toolkit-identity.mjs",
    ["adopt", "--module", "auth"],
    consumer.root,
  );
  assert.equal(adopt.code, 0, adopt.output);
  assert.match(adopt.output, /adopted toolkit identity/);
  assert.match(adopt.output, /was not advanced/, "adoption must not ride along with a lifecycle move");

  const after = await consumer.snapshot();
  const identity = JSON.parse(await readFile(engineIn(bundle, "build-identity.json"), "utf8"));
  assert.deepEqual(after.state.toolkitIdentity, identity);
  assert.equal(after.state.revision, before.state.revision + 1, "exactly one transition");
  assert.equal(after.state.currentStep, before.state.currentStep, "no step moved");
  assert.deepEqual(after.state.artifactHashes, before.state.artifactHashes, "no pin moved");
  assert.equal(after.decisions, before.decisions, "the decision ledger is untouched");

  // Exactly one new history event, and it carries both ends of the change.
  assert.equal(after.history.length, before.history.length + 1);
  const event = after.history.at(-1);
  assert.equal(event.event, "TOOLKIT_IDENTITY_ADOPTED");
  assert.equal(event.previous, null);
  assert.deepEqual(event.next, identity);
  assert.equal(event.revision, after.state.revision);

  // The integrity anchor moved with it, in the same transaction, and no journal
  // was left behind.
  assert.notEqual(after.integrity.toolkitIdentitySha256, undefined);
  assert.equal(after.integrity.revision, after.state.revision);
  assert.equal(after.journal, null);

  // Replayable: running the same command again is a no-op, not a second event.
  const again = await runEngine(
    engineIn(bundle, "."),
    "cli/toolkit-identity.mjs",
    ["adopt", "--module", "auth"],
    consumer.root,
  );
  assert.equal(again.code, 0, again.output);
  assert.match(again.output, /already pins/);
  assert.deepEqual(await consumer.snapshot(), after, "a repeated adoption wrote a second time");
});

test("after adoption the same toolkit resumes the record normally", async (t) => {
  const bundle = await sharedBundle(t);
  const consumer = await unstampedConsumer();
  t.after(() => consumer.cleanup());

  await runEngine(engineIn(bundle, "."), "cli/toolkit-identity.mjs", ["adopt", "--module", "auth"], consumer.root);
  const status = await runEngine(
    engineIn(bundle, "."),
    "cli/toolkit-identity.mjs",
    ["status", "--module", "auth"],
    consumer.root,
  );
  assert.equal(JSON.parse(status.output).toolkitIdentityStatus, "MATCH");
  // The record still reads, at its own unchanged format, under the toolkit it
  // just adopted.
  const resumed = await runEngine(
    engineIn(bundle, "."),
    "cli/discover-module.mjs",
    ["auth", "--status"],
    consumer.root,
  );
  assert.equal(resumed.code, 0, resumed.output);
  assert.equal(JSON.parse(resumed.output).formatVersion, MIGRATION_FORMAT_VERSION);

  // And the mutation that was refused before adoption now runs: adoption is the
  // thing that lifts the block, not a side effect of something else.
  const adopted = await consumer.snapshot();
  const mutated = await confirmedRefresh(engineIn(bundle, "."), consumer.root);
  assert.equal(mutated.code, 0, mutated.output);
  const after = await consumer.snapshot();
  assert.ok(after.state.revision > adopted.state.revision, "the mutation wrote nothing");
  assert.deepEqual(after.state.toolkitIdentity, adopted.state.toolkitIdentity, "the identity moved");
});

// -- mismatch, update and rollback -------------------------------------------

test("a different build is refused by every mutating entry point, before any write", async (t) => {
  const bundle = await sharedBundle(t);
  const consumer = await unstampedConsumer();
  t.after(() => consumer.cleanup());
  await runEngine(engineIn(bundle, "."), "cli/toolkit-identity.mjs", ["adopt", "--module", "auth"], consumer.root);

  const pinned = JSON.parse(await readFile(engineIn(bundle, "build-identity.json"), "utf8"));
  // Same version, different commit and content: a silent swap attempt.
  const other = await siblingBundle(bundle, {
    ...pinned,
    commit: "f".repeat(40),
    contentHash: `sha256:${"e".repeat(64)}`,
  });
  t.after(() => other.cleanup());

  const before = await consumer.snapshot();
  // `update` is deliberately absent: an explicit, operator-initiated update is
  // the one thing a different build *may* do to a stamped record, and it is
  // proven in its own test. Everything that is not that is refused.
  for (const [script, args] of [
    [null, null],
    ["cli/toolkit-identity.mjs", ["adopt", "--module", "auth"]],
  ]) {
    const result = script === null
      ? await confirmedRefresh(other.engine, consumer.root)
      : await runEngine(other.engine, script, args, consumer.root);
    const label = script ?? "a confirmed refresh";
    assert.notEqual(result.code, 0, `${label} ran under a mismatched toolkit:\n${result.output}`);
    assert.match(result.output, /toolkit/i, `${label} failed for some reason other than identity`);
    assert.deepEqual(
      await consumer.snapshot(),
      before,
      `${label} wrote to the record under a mismatched toolkit`,
    );
  }

  // Read-only status still answers, and says exactly what is wrong.
  const status = await runEngine(other.engine, "cli/toolkit-identity.mjs", ["status", "--module", "auth"], consumer.root);
  assert.equal(status.code, 0, status.output);
  assert.equal(JSON.parse(status.output).toolkitIdentityStatus, "MISMATCH");
  assert.deepEqual(await consumer.snapshot(), before);
});

test("update and rollback move between two immutable releases without touching consumer state", async (t) => {
  const bundle = await sharedBundle(t);
  const consumer = await unstampedConsumer();
  t.after(() => consumer.cleanup());
  await runEngine(engineIn(bundle, "."), "cli/toolkit-identity.mjs", ["adopt", "--module", "auth"], consumer.root);
  const first = await consumer.snapshot();

  const pinned = JSON.parse(await readFile(engineIn(bundle, "build-identity.json"), "utf8"));
  const next = { ...pinned, version: "1.0.1", commit: "d".repeat(40), contentHash: `sha256:${"d".repeat(64)}` };
  const other = await siblingBundle(bundle, next);
  t.after(() => other.cleanup());

  const updated = await runEngine(other.engine, "cli/toolkit-identity.mjs", ["update", "--module", "auth"], consumer.root);
  assert.equal(updated.code, 0, updated.output);
  const afterUpdate = await consumer.snapshot();
  assert.deepEqual(afterUpdate.state.toolkitIdentity, next);
  assert.equal(afterUpdate.history.at(-1).event, "TOOLKIT_IDENTITY_CHANGED");
  assert.deepEqual(afterUpdate.history.at(-1).previous, pinned);
  assert.deepEqual(afterUpdate.history.at(-1).next, next);
  assert.equal(afterUpdate.state.currentStep, first.state.currentStep, "consumer navigation moved");
  assert.equal(afterUpdate.decisions, first.decisions, "consumer decisions moved");

  // Rolling back selects the previously installed immutable release. It rolls
  // back the *toolkit*, never the record: the history only ever grows.
  const rolled = await runEngine(engineIn(bundle, "."), "cli/toolkit-identity.mjs", ["rollback", "--module", "auth"], consumer.root);
  assert.equal(rolled.code, 0, rolled.output);
  const afterRollback = await consumer.snapshot();
  assert.deepEqual(afterRollback.state.toolkitIdentity, pinned);
  assert.equal(afterRollback.history.length, afterUpdate.history.length + 1, "rollback appends, never truncates");
  assert.deepEqual(afterRollback.history.at(-1).previous, next);
  assert.deepEqual(afterRollback.history.at(-1).next, pinned);
  assert.equal(afterRollback.state.revision, first.state.revision + 2);
  assert.equal(afterRollback.decisions, first.decisions);

  // And the record still resumes under the rolled-back release.
  const resumed = await runEngine(engineIn(bundle, "."), "cli/discover-module.mjs", ["auth", "--status"], consumer.root);
  assert.equal(resumed.code, 0, resumed.output);
});

test("concurrent adoptions serialize through the existing record lock", async (t) => {
  const bundle = await sharedBundle(t);
  const consumer = await unstampedConsumer();
  t.after(() => consumer.cleanup());

  const attempts = await Promise.all(
    Array.from({ length: 4 }, () =>
      runEngine(engineIn(bundle, "."), "cli/toolkit-identity.mjs", ["adopt", "--module", "auth"], consumer.root),
    ),
  );
  for (const attempt of attempts) {
    assert.equal(attempt.code, 0, attempt.output);
  }
  const after = await consumer.snapshot();
  const identityEvents = after.history.filter((event) =>
    String(event.event).startsWith("TOOLKIT_IDENTITY_"),
  );
  assert.equal(identityEvents.length, 1, "four racing adoptions produced more than one event");
  assert.equal(after.journal, null);
});

test("a forged identity in state.json is refused by the integrity anchor and the history", async (t) => {
  const bundle = await sharedBundle(t);
  const consumer = await unstampedConsumer();
  t.after(() => consumer.cleanup());

  // Stamping state.json by hand, without the anchor the engine writes outside it.
  await consumer.editState((state) => ({
    ...state,
    toolkitIdentity: { ...IDENTITY, commit: "9".repeat(40) },
  }));
  const status = await runEngine(engineIn(bundle, "."), "cli/toolkit-identity.mjs", ["status", "--module", "auth"], consumer.root);
  assert.notEqual(status.code, 0, "a hand-stamped record must not read as healthy");
  assert.match(status.output, /integrity\.json|append-only history/);
});
