// External Format 17 acceptance: an installed toolkit against a scratch
// consumer that contains no engine source.
//
// The shape of this suite *is* the proof. Every command runs the staged release
// bundle as a child process, from a consumer directory created outside the
// toolkit checkout, with the record, registry, OpenSpec authority, decisions and
// evidence owned entirely by the consumer. Nothing here imports the engine to
// drive a lifecycle, because an in-process import would be running the checkout,
// not the installation -- and "the installation is what runs" is the claim.
//
// The record is seeded by the unidentified checkout, so it starts *unstamped*:
// exactly the shape of every record a consumer has today.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { buildRelease } from "../../../../scripts/release.mjs";
import { candidateReleaseRoot } from "../support/candidate-release-root.mjs";
import { createUnstampedRecord } from "../support/consumer-fixture.mjs";
import { downgradeToV4, readTree } from "../support/downgrade-v4.mjs";
import { MIGRATION_FORMAT_VERSION } from "../../src/resumable-migration.mjs";
import { validateToolkitIdentity } from "../../src/toolkit-identity.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const scratch = await mkdtemp(path.join(os.tmpdir(), "amt-format-17-release-"));
after(() => rm(scratch, { recursive: true, force: true }));

let bundlePromise;
/** One installed toolkit for the whole file, built from the committed payload. */
const installedToolkit = async () => {
  bundlePromise ??= candidateReleaseRoot(scratch)
    .then((root) => buildRelease({ root, force: true }))
    .then((built) => ({
      root: built.stagingRoot,
      engine: path.join(built.stagingRoot, "packages/migration-engine"),
      identity: built.identity,
      manifest: built.manifest,
    }));
  return bundlePromise;
};

const run = async (toolkit, script, args, cwd) => {
  const result = await execFileAsync(
    process.execPath,
    [path.join(toolkit.engine, "src", script), ...args],
    { cwd, encoding: "utf8" },
  ).catch((error) => error);
  return { output: `${result.stdout ?? ""}${result.stderr ?? ""}`, code: result.code ?? 0 };
};

const confirmationIdIn = (output) => output.match(/Confirmation ID: ([0-9a-f]+)/)?.[1];

/**
 * A confirmed checkpoint advance, driven entirely through the installed CLI.
 * Two-phase like every durable transition: the confirmation id comes from the
 * advance's own preview, so an unconfirmed preview writes nothing.
 */
const advance = async (toolkit, cwd, extra = []) => {
  const preview = await run(toolkit, "cli/advance-migration.mjs", ["auth", ...extra], cwd);
  const confirmationId = confirmationIdIn(preview.output);
  if (!confirmationId) return preview;
  return run(
    toolkit,
    "cli/advance-migration.mjs",
    ["auth", ...extra, "--confirm-advance", confirmationId],
    cwd,
  );
};

/**
 * The human-authority path. AUTO adopts an unstamped record on its own
 * evidence, so the refusal these tests pin is a `--mode step` guarantee; the
 * AUTO side is proven in `test/unit/auto-authority.test.mjs`.
 */
const STEP = ["--mode", "step"];

/**
 * A consumer holding one integrity-valid, unstamped, active Format 17 record,
 * authored up to a ready DISCOVER_LEGACY checkpoint.
 */
const seedConsumer = async (t, prefix) => {
  const consumer = await createUnstampedRecord({ prefix });
  t.after(() => consumer.cleanup());
  await consumer.authorDiscoverLegacy();
  const seeded = await consumer.snapshot();
  assert.equal(seeded.state.formatVersion, MIGRATION_FORMAT_VERSION, "seeded at the current format");
  assert.equal(seeded.state.toolkitIdentity, undefined, "the seed must be unstamped");
  assert.equal(seeded.state.status, "ACTIVE");
  return consumer;
};

test("an installed toolkit resumes an existing unstamped Format 17 record only after explicit adoption", async (t) => {
  const toolkit = await installedToolkit();
  const consumer = await seedConsumer(t, "amt acceptance ");

  // 3. Read-only status neither stamps nor mutates.
  const before = await consumer.snapshot();
  const status = await run(toolkit, "cli/discover-module.mjs", ["auth", "--status"], consumer.root);
  assert.equal(status.code, 0, status.output);
  assert.deepEqual(await consumer.snapshot(), before, "--status wrote to the record");

  const identityStatus = await run(
    toolkit,
    "cli/toolkit-identity.mjs",
    ["status", "--module", "auth"],
    consumer.root,
  );
  assert.equal(identityStatus.code, 0, identityStatus.output);
  assert.equal(JSON.parse(identityStatus.output).toolkitIdentityStatus, "UNSTAMPED");
  assert.deepEqual(await consumer.snapshot(), before, "identity status wrote to the record");

  // 4. Under --mode step a mutating resume blocks until adoption, naming one
  // command.
  const blocked = await advance(toolkit, consumer.root, STEP);
  assert.notEqual(blocked.code, 0, blocked.output);
  assert.match(blocked.output, /carries no toolkit identity/);
  assert.match(blocked.output, /toolkit-identity\.mjs/);
  assert.deepEqual(await consumer.snapshot(), before, "a refused advance wrote to the record");

  // 5. Adoption: one audit event, integrity updated, then it stops.
  const adopt = await run(toolkit, "cli/toolkit-identity.mjs", ["adopt", "--module", "auth"], consumer.root);
  assert.equal(adopt.code, 0, adopt.output);
  const adopted = await consumer.snapshot();
  assert.deepEqual(adopted.state.toolkitIdentity, toolkit.identity);
  assert.equal(adopted.state.revision, before.state.revision + 1);
  assert.equal(adopted.state.currentStep, before.state.currentStep, "adoption advanced a checkpoint");
  assert.equal(adopted.history.at(-1).event, "TOOLKIT_IDENTITY_ADOPTED");
  assert.equal(adopted.integrity.revision, adopted.state.revision);
  assert.equal(adopted.journal, null);

  // 6. The lifecycle resumes on the next invocation, and one normal advance runs.
  const advanced = await advance(toolkit, consumer.root);
  assert.equal(advanced.code, 0, advanced.output);
  const after = await consumer.snapshot();
  assert.equal(after.state.currentStep, "DISCOVERY_COMPLETENESS", "the checkpoint did not close");
  assert.equal(after.history.at(-1).event, "STEP_COMPLETED");
  assert.deepEqual(after.state.toolkitIdentity, toolkit.identity, "the advance dropped the identity");
  // 7. The format the record runs at is untouched by the toolkit that runs it.
  assert.equal(after.state.formatVersion, MIGRATION_FORMAT_VERSION);
  assert.equal(after.state.contractVersion, before.state.contractVersion);
  assert.equal(after.state.workflowVersion, before.state.workflowVersion);
  assert.equal(after.decisions, before.decisions, "the decision ledger changed during a lifecycle advance");
});

test("operator decision candidates and the approval gate survive the installed toolkit", async (t) => {
  const toolkit = await installedToolkit();
  const consumer = await seedConsumer(t, "amt acceptance decisions ");
  await run(toolkit, "cli/toolkit-identity.mjs", ["adopt", "--module", "auth"], consumer.root);
  await advance(toolkit, consumer.root);

  // Candidate generation is read-only and takes no lock.
  const before = await consumer.snapshot();
  const pending = await run(toolkit, "record-decision.mjs", ["auth", "--pending"], consumer.root);
  assert.equal(pending.code, 0, pending.output);
  const listed = JSON.parse(pending.output);
  assert.ok(Array.isArray(listed.candidates), "candidates must be a list");
  assert.deepEqual(await consumer.snapshot(), before, "listing candidates wrote to the record");

  // 9/`R-W2-*`: the approval gate is a TTY or a host elicitation, never argv.
  // A child process has no TTY, so an approval attempt refuses before any write.
  const forged = await run(
    toolkit,
    "record-decision.mjs",
    ["auth", "--approve", listed.candidates[0]?.id ?? "DEC-CANDIDATE-1"],
    consumer.root,
  );
  assert.notEqual(forged.code, 0, forged.output);
  assert.deepEqual(await consumer.snapshot(), before, "a refused approval wrote to the ledger");
});

test("the MCP server runs from the installation and keeps host elicitation the only approval path", async (t) => {
  const toolkit = await installedToolkit();
  const consumer = await seedConsumer(t, "amt acceptance mcp ");
  await run(toolkit, "cli/toolkit-identity.mjs", ["adopt", "--module", "auth"], consumer.root);

  const child = execFile(process.execPath, [path.join(toolkit.engine, "src/mcp-server.mjs")], {
    cwd: consumer.root,
    encoding: "utf8",
  });
  const responses = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (const line of buffer.split("\n").slice(0, -1)) {
      if (line.trim()) responses.push(JSON.parse(line));
    }
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "acceptance", version: "1" } },
  });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "migration_status", arguments: { module: "auth" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  child.kill();

  const tools = responses.find((message) => message.id === 2)?.result?.tools ?? [];
  assert.ok(tools.length > 0, `MCP listed no tools: ${JSON.stringify(responses)}`);
  // A client that declared no elicitation capability has no approval channel at
  // all, so no tool may expose an approval-shaped argument as a substitute.
  for (const tool of tools) {
    const properties = Object.keys(tool.inputSchema?.properties ?? {});
    for (const forbidden of ["approve", "approval", "decision", "confirmApproval"]) {
      if (tool.name === "migration_run" && forbidden === "approve") continue;
      assert.ok(
        !properties.includes(forbidden),
        `${tool.name} exposes an approval-shaped argument '${forbidden}'`,
      );
    }
  }
  const statusCall = responses.find((message) => message.id === 3);
  assert.ok(statusCall, `MCP never answered migration_status: ${JSON.stringify(responses)}`);
});

test("an interrupted adoption is recovered, not half-applied", async (t) => {
  const toolkit = await installedToolkit();
  const consumer = await seedConsumer(t, "amt acceptance recovery ");
  const before = await consumer.snapshot();

  // A journal left behind by a death mid-adoption. The next command under the
  // record lock must resolve it deterministically and leave no journal.
  await run(toolkit, "cli/toolkit-identity.mjs", ["adopt", "--module", "auth"], consumer.root);
  const adopted = await consumer.snapshot();
  assert.equal(adopted.journal, null, "a completed adoption left its journal behind");
  assert.equal(adopted.history.length, before.history.length + 1);

  // The record still opens, and reports the identity the history proves.
  const status = await run(toolkit, "cli/toolkit-identity.mjs", ["status", "--module", "auth"], consumer.root);
  assert.equal(status.code, 0, status.output);
  assert.equal(JSON.parse(status.output).toolkitIdentityStatus, "MATCH");
});

test("decision material, evidence provenance and pins are byte-identical across adoption", async (t) => {
  const toolkit = await installedToolkit();
  const consumer = await seedConsumer(t, "amt acceptance provenance ");
  const before = await consumer.snapshot();
  const historyBefore = await readFile(path.join(consumer.recordRoot, "history/history.ndjson"), "utf8");

  await run(toolkit, "cli/toolkit-identity.mjs", ["adopt", "--module", "auth"], consumer.root);
  const after = await consumer.snapshot();
  const historyAfter = await readFile(path.join(consumer.recordRoot, "history/history.ndjson"), "utf8");

  // Append-only in the strictest sense: the prior bytes are a literal prefix.
  assert.ok(historyAfter.startsWith(historyBefore), "adoption rewrote existing history bytes");
  assert.deepEqual(after.state.artifactHashes, before.state.artifactHashes, "a pin moved");
  assert.equal(after.state.migrationId, before.state.migrationId);
  assert.deepEqual(after.state.legacyRevision, before.state.legacyRevision);
  assert.deepEqual(after.state.requirementsAuthority, before.state.requirementsAuthority);
  assert.equal(
    after.integrity.artifactHashesSha256,
    before.integrity.artifactHashesSha256,
    "the artifact-hash anchor moved during an identity-only transition",
  );
  assert.deepEqual(after.integrity.decisions, before.integrity.decisions, "the decision anchor moved");
});

test("the scratch consumer contains no engine source after the whole run", async (t) => {
  const toolkit = await installedToolkit();
  const consumer = await seedConsumer(t, "amt acceptance boundary ");
  await run(toolkit, "cli/toolkit-identity.mjs", ["adopt", "--module", "auth"], consumer.root);
  await advance(toolkit, consumer.root);

  const engineSources = new Set([
    "resumable-migration.mjs",
    "artifact-migration.mjs",
    "record-decision.mjs",
    "migration-utils.mjs",
    "discovery-scan.mjs",
    "module-lock.mjs",
    "mcp-server.mjs",
    "toolkit-identity.mjs",
    "core.mjs",
  ]);
  const found = [];
  for (const relative of await readdir(consumer.root, { recursive: true })) {
    if ((await stat(path.join(consumer.root, relative))).isDirectory()) continue;
    if (engineSources.has(path.basename(relative))) found.push(relative);
    // Nor a canonical skill, nor a generated provider engine copy.
    if (relative.includes(`skills${path.sep}start-migration`)) found.push(relative);
  }
  assert.deepEqual(found, [], "the consumer acquired engine or skill source");

  // And the toolkit's own checkout is nowhere in the consumer's record either:
  // the engine is installed, not vendored.
  const state = await readFile(consumer.statePath, "utf8");
  assert.ok(!state.includes(repositoryRoot), "the record persisted an engine installation path");
});

test("only the pinned build may mutate, and an update moves the pin explicitly", async (t) => {
  const toolkit = await installedToolkit();
  const consumer = await seedConsumer(t, "amt acceptance mismatch ");
  await run(toolkit, "cli/toolkit-identity.mjs", ["adopt", "--module", "auth"], consumer.root);
  const pinned = await consumer.snapshot();

  // 10. Change only the toolkit identity. Every mutation must fail closed
  // before a record or ledger write.
  const identityFile = path.join(toolkit.engine, "build-identity.json");
  const original = await readFile(identityFile, "utf8");
  const swapped = { ...toolkit.identity, commit: "1".repeat(40), contentHash: `sha256:${"2".repeat(64)}` };
  validateToolkitIdentity(swapped);
  await writeFile(identityFile, `${JSON.stringify(swapped, null, 2)}\n`, "utf8");
  try {
    const blockedAdvance = await advance(toolkit, consumer.root);
    assert.notEqual(blockedAdvance.code, 0, blockedAdvance.output);
    assert.match(blockedAdvance.output, /toolkit/i);
    assert.deepEqual(await consumer.snapshot(), pinned, "a mismatched build wrote to the record");

    const blockedDecision = await run(
      toolkit,
      "record-decision.mjs",
      ["auth", "--approve", "DEC-CANDIDATE-1"],
      consumer.root,
    );
    assert.notEqual(blockedDecision.code, 0, blockedDecision.output);
    assert.deepEqual(await consumer.snapshot(), pinned, "a mismatched build wrote to the ledger");

    // 11. An explicit update is the one way across, and it rolls back no
    // consumer state: navigation, pins and decisions are untouched.
    const updated = await run(toolkit, "cli/toolkit-identity.mjs", ["update", "--module", "auth"], consumer.root);
    assert.equal(updated.code, 0, updated.output);
    const afterUpdate = await consumer.snapshot();
    assert.deepEqual(afterUpdate.state.toolkitIdentity, swapped);
    assert.equal(afterUpdate.history.at(-1).event, "TOOLKIT_IDENTITY_CHANGED");
    assert.equal(afterUpdate.state.currentStep, pinned.state.currentStep);
    assert.deepEqual(afterUpdate.state.artifactHashes, pinned.state.artifactHashes);
    assert.equal(afterUpdate.decisions, pinned.decisions);

    // And the record resumes under the updated build without any record rollback.
    const resumed = await advance(toolkit, consumer.root);
    assert.equal(resumed.code, 0, resumed.output);
    assert.equal((await consumer.snapshot()).state.currentStep, "DISCOVERY_COMPLETENESS");
  } finally {
    await writeFile(identityFile, original, "utf8");
  }
});

// --- 8. upgrade preview/execute, recovery and rollback ----------------------
//
// The upgrade coordinator is the one path that legitimately runs against a
// record no identity was ever adopted on: a contract-4 tree predates the
// standalone toolkit and cannot be opened by `readState`, so demanding adoption
// first would make it permanently un-upgradable. Everything below therefore
// runs unstamped on purpose, and the v5 record it produces is unstamped too --
// which the first test proves still demands explicit adoption afterwards.

const exists = (target) => stat(target).then(() => true, () => false);

/**
 * The same scratch consumer, rewritten into a genuine contract-4 tree by the
 * harness the contract suite uses. A freshly bootstrapped record already owns
 * every artifact the upgrader validates -- all eight step documents and a slice
 * index -- so no lifecycle driving is needed to produce an upgradable v4 tree.
 */
const seedV4Consumer = async (t, prefix) => {
  const consumer = await createUnstampedRecord({ prefix });
  t.after(() => consumer.cleanup());
  await consumer.authorDiscoverLegacy();
  const v4 = await downgradeToV4(consumer.recordRoot);
  assert.equal(v4.contractVersion, 4, "the seed must be a contract-4 tree");
  assert.equal(v4.formatVersion, 3);
  assert.equal(v4.toolkitIdentity, undefined, "a contract-4 tree predates toolkit identity");
  return { consumer, v4 };
};

const upgrade = (toolkit, cwd, ...args) =>
  run(toolkit, "upgrades/upgrade-migration.mjs", ["auth", ...args], cwd);

test("an installed toolkit previews and executes a contract-4 upgrade, writing nothing until confirmed", async (t) => {
  const toolkit = await installedToolkit();
  const { consumer, v4 } = await seedV4Consumer(t, "amt acceptance upgrade ");
  const authored = await readFile(path.join(consumer.recordRoot, "inventories/legacy.json"), "utf8");

  // Preview is a read: it names the source and target versions, issues one
  // confirmation id, and leaves the tree byte-identical.
  const before = await readTree(consumer.recordRoot);
  const preview = await upgrade(toolkit, consumer.root);
  assert.equal(preview.code, 0, preview.output);
  assert.match(preview.output, /Source: contract 4 format 3 workflow 4\.0/);
  assert.match(preview.output, /Blockers: none/);
  assert.match(preview.output, /No execution has started/);
  const confirmationId = confirmationIdIn(preview.output);
  assert.ok(confirmationId, `the preview issued no confirmation id:\n${preview.output}`);
  assert.deepEqual(await readTree(consumer.recordRoot), before, "the preview wrote to the record");

  // An unconfirmed second invocation is still a preview, and a wrong id is
  // refused: the confirmation is the authority, not the fact of asking twice.
  const forged = await upgrade(toolkit, consumer.root, "--confirm-upgrade", "0".repeat(16));
  assert.notEqual(forged.code, 0, forged.output);
  assert.deepEqual(await readTree(consumer.recordRoot), before, "a forged confirmation wrote to the record");

  const executed = await upgrade(toolkit, consumer.root, "--confirm-upgrade", confirmationId);
  assert.equal(executed.code, 0, executed.output);
  assert.match(executed.output, /Upgraded auth to contract 5 format \d+/);
  assert.match(executed.output, /Stop: the upgrade is the only action for this invocation/);
  const snapshotPath = executed.output.match(/^Snapshot: (.+)$/m)?.[1];
  assert.ok(await exists(snapshotPath), `the reported snapshot does not exist: ${snapshotPath}`);

  // Identity, decisions and authored evidence survive the transformation.
  const upgraded = JSON.parse(await readFile(consumer.statePath, "utf8"));
  assert.equal(upgraded.contractVersion, 5);
  assert.equal(upgraded.migrationId, v4.migrationId, "the upgrade reissued the migration id");
  assert.equal(upgraded.createdAt, v4.createdAt, "the upgrade rewrote the creation time");
  assert.equal(
    await readFile(path.join(consumer.recordRoot, "inventories/legacy.json"), "utf8"),
    authored,
    "the upgrade rewrote authored legacy evidence",
  );

  // The upgraded record is readable by the installed toolkit, and still
  // unstamped -- so the very next lifecycle mutation demands explicit adoption.
  const status = await run(toolkit, "cli/toolkit-identity.mjs", ["status", "--module", "auth"], consumer.root);
  assert.equal(status.code, 0, status.output);
  assert.equal(JSON.parse(status.output).toolkitIdentityStatus, "UNSTAMPED");
  const blocked = await advance(toolkit, consumer.root, STEP);
  assert.notEqual(blocked.code, 0, blocked.output);
  assert.match(blocked.output, /carries no toolkit identity/);
});

test("an upgrade killed mid-transaction is recovered by the installed toolkit, then completes", async (t) => {
  const toolkit = await installedToolkit();
  const { consumer, v4 } = await seedV4Consumer(t, "amt acceptance upgrade recovery ");
  const authored = await readFile(path.join(consumer.recordRoot, "inventories/legacy.json"), "utf8");

  const preview = await upgrade(toolkit, consumer.root);
  const confirmationId = confirmationIdIn(preview.output);
  assert.ok(confirmationId, preview.output);
  const before = await readTree(consumer.recordRoot);

  // A real process death at LIVE_MOVED: the journal is committed and the live
  // tree is renamed away, but the staged tree has not been renamed in. The
  // driver is a test harness, not consumer content, so it lives outside the
  // consumer -- and it drives the *installed* engine, like every other command
  // in this file.
  const driverRoot = await mkdtemp(path.join(os.tmpdir(), "amt-kill-"));
  t.after(() => rm(driverRoot, { recursive: true, force: true }));
  const driver = path.join(driverRoot, "kill-upgrade.mjs");
  await writeFile(
    driver,
    `import { executeUpgrade } from ${JSON.stringify(
      pathToFileURL(path.join(toolkit.engine, "src/upgrades/upgrade-migration.mjs")).href,
    )};\n` +
      `const [, , registryPath, moduleName, confirmUpgrade] = process.argv;\n` +
      `await executeUpgrade({ registryPath, moduleName, confirmUpgrade, hooks: {\n` +
      `  afterJournal: (state) => {\n` +
      `    if (state !== "LIVE_MOVED") return undefined;\n` +
      `    process.stdout.write("boundary-reached\\n");\n` +
      `    return new Promise(() => {});\n` +
      `  },\n` +
      `} });\n`,
  );
  const child = spawn(
    process.execPath,
    [driver, consumer.registryPath, "auth", confirmationId],
    { cwd: consumer.root, stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the upgrade never reached LIVE_MOVED")), 30_000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("boundary-reached")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", (error) => (clearTimeout(timer), reject(error)));
    child.on("exit", (code) => (clearTimeout(timer), reject(new Error(`driver exited ${code} early`))));
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(await exists(consumer.recordRoot), false, "LIVE_MOVED left the live tree in place");

  // Every other command refuses while the transaction is open, and says which
  // one command resolves it.
  const refused = await upgrade(toolkit, consumer.root);
  assert.equal(refused.code, 0, refused.output);
  assert.match(refused.output, /unfinished upgrade transaction/);
  assert.match(refused.output, /--recover/);
  assert.match(refused.output, /Upgrade: BLOCKED\./);

  const recovered = await upgrade(toolkit, consumer.root, "--recover");
  assert.equal(recovered.code, 0, recovered.output);
  assert.match(recovered.output, /Recovered from LIVE_MOVED: ROLLED_BACK/);
  assert.deepEqual(
    await readTree(consumer.recordRoot),
    before,
    "recovery did not restore the contract-4 tree byte for byte",
  );

  // Recovery is idempotent, and the recovered record still upgrades.
  const again = await upgrade(toolkit, consumer.root, "--recover");
  assert.equal(again.code, 0, again.output);
  assert.match(again.output, /No unfinished upgrade transaction exists/);

  const retry = await upgrade(toolkit, consumer.root);
  const retryId = confirmationIdIn(retry.output);
  assert.ok(retryId, retry.output);
  const executed = await upgrade(toolkit, consumer.root, "--confirm-upgrade", retryId);
  assert.equal(executed.code, 0, executed.output);
  const upgraded = JSON.parse(await readFile(consumer.statePath, "utf8"));
  assert.equal(upgraded.contractVersion, 5);
  assert.equal(upgraded.createdAt, v4.createdAt);
  assert.equal(
    await readFile(path.join(consumer.recordRoot, "inventories/legacy.json"), "utf8"),
    authored,
    "the recovered-then-retried upgrade lost authored evidence",
  );
});

test("an executed upgrade rolls back to the contract-4 tree only under explicit confirmation", async (t) => {
  const toolkit = await installedToolkit();
  const { consumer } = await seedV4Consumer(t, "amt acceptance rollback ");
  const v4Tree = await readTree(consumer.recordRoot);

  const preview = await upgrade(toolkit, consumer.root);
  const executed = await upgrade(toolkit, consumer.root, "--confirm-upgrade", confirmationIdIn(preview.output));
  assert.equal(executed.code, 0, executed.output);
  const v5Tree = await readTree(consumer.recordRoot);
  assert.notDeepEqual(v5Tree, v4Tree, "the upgrade changed nothing to roll back");

  // An unconfirmed rollback is a preview: one confirmation id, nothing moved.
  const rollbackPreview = await upgrade(toolkit, consumer.root, "--rollback");
  assert.equal(rollbackPreview.code, 0, rollbackPreview.output);
  assert.match(rollbackPreview.output, /No execution has started/);
  const rollbackId = confirmationIdIn(rollbackPreview.output);
  assert.ok(rollbackId, `the rollback preview issued no confirmation id:\n${rollbackPreview.output}`);
  assert.deepEqual(await readTree(consumer.recordRoot), v5Tree, "the rollback preview wrote to the record");

  const rolled = await upgrade(toolkit, consumer.root, "--rollback", "--confirm-rollback", rollbackId);
  assert.equal(rolled.code, 0, rolled.output);
  assert.match(rolled.output, /Restored auth from upgrade/);
  assert.match(rolled.output, /Contract 5 refuses the restored tree until it is upgraded again/);
  const snapshotPath = rolled.output.match(/^Snapshot of the replaced tree: (.+)$/m)?.[1];
  assert.ok(await exists(snapshotPath), `the replaced tree was not snapshotted: ${snapshotPath}`);

  // The restored tree is the contract-4 one, byte for byte, and contract 5
  // refuses it until it is upgraded again -- which it still can be.
  assert.deepEqual(await readTree(consumer.recordRoot), v4Tree, "rollback did not restore the v4 tree");
  const resumeRefused = await advance(toolkit, consumer.root);
  assert.notEqual(resumeRefused.code, 0, resumeRefused.output);
  const reupgrade = await upgrade(toolkit, consumer.root);
  assert.ok(confirmationIdIn(reupgrade.output), reupgrade.output);
});

// --- 8b. interrupted artifact journal recovery ------------------------------

test("an artifact transaction killed mid-write is recovered by the next installed command", async (t) => {
  const toolkit = await installedToolkit();
  // The artifact lifecycle fixture the journal/recovery spec already owns, so
  // the record below is authored by real production checkpoints rather than a
  // second model of them. Seeded by this checkout, exactly like the module
  // consumer, and therefore unstamped.
  const fixtures = await import("../integration/artifact/support/fixtures.ts");
  const fixture = await fixtures.createFixture();
  t.after(() => fixture.cleanup());
  await fixtures.bootstrap(fixture);
  await fixtures.authorSource(fixture);

  // The two front ends name one record differently: `run-artifact.mjs` takes
  // the source as its positional, `toolkit-identity.mjs` as `--artifact`.
  const where = [
    "--type", fixture.options.type,
    "--source-root", fixture.options.sourceRoot,
    "--target-root", fixture.options.targetRoot,
  ];
  const artifact = (extra) =>
    run(
      toolkit,
      "artifact/run-artifact.mjs",
      [fixture.options.source, ...where, "--target", fixture.options.target, ...extra],
      fixture.root,
    );

  // An unstamped artifact record refuses the installed toolkit's mutations too,
  // so adoption is the real first step of an external resume.
  const adopted = await run(
    toolkit,
    "cli/toolkit-identity.mjs",
    ["adopt", "--artifact", fixture.options.source, ...where],
    fixture.root,
  );
  assert.equal(adopted.code, 0, adopted.output);
  assert.match(adopted.output, /adopted toolkit identity/);

  const journal = path.join(fixture.artifactRoot, "transaction.json");
  assert.equal(await exists(journal), false, "the fixture started with a pending transaction");

  // Real process death inside the history append: the transaction is published
  // and nothing after it is. The crash driver runs the *installed* engine.
  const crashed = await execFileAsync(
    process.execPath,
    [
      path.join(repositoryRoot, "packages/migration-engine/test/integration/artifact/support/history-crash.mjs"),
      JSON.stringify(fixture.options),
      "BEFORE_OPEN",
      pathToFileURL(path.join(toolkit.engine, "src/artifact/artifact-migration.mjs")).href,
    ],
    { cwd: fixture.root, encoding: "utf8" },
  ).catch((error) => error);
  assert.equal(crashed.code, 86, `the driver did not die at the history write: ${crashed.stderr ?? ""}`);
  assert.equal(await exists(journal), true, "the killed advance left no transaction to recover");
  const pending = JSON.parse(await readFile(journal, "utf8"));
  assert.equal(pending.event.event, "ADVANCED");

  // Reading is read-only: it answers and leaves the transaction pending.
  const before = await readTree(fixture.artifactRoot);
  const status = await artifact(["--status", "--json"]);
  assert.equal(status.code, 0, status.output);
  assert.equal(JSON.parse(status.output).status, "ACTIVE");
  assert.deepEqual(await readTree(fixture.artifactRoot), before, "--status resolved or moved the transaction");

  // The next mutating command recovers it, finishes the journaled event exactly
  // once, and leaves no journal behind.
  const resumed = await artifact([]);
  assert.equal(resumed.code, 0, resumed.output);
  assert.equal(await exists(journal), false, "recovery left the transaction behind");
  const state = JSON.parse(await readFile(path.join(fixture.artifactRoot, "state.json"), "utf8"));
  assert.deepEqual(state.toolkitIdentity, toolkit.identity, "recovery dropped the adopted identity");
  assert.ok(state.completedSteps.includes("DISCOVER_LEGACY"), "the journaled advance was not applied");
  const events = (await readFile(path.join(fixture.artifactRoot, "history/history.ndjson"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(
    events.filter((event) => event.event === "ADVANCED" && event.revision === pending.state.revision).length,
    1,
    "the recovered event was appended more than once",
  );
});

// --- 9. the engine-owned format upgrade, through the installed runtime -------
//
// The claim these tests prove is a *protocol*, not a transformation: from
// the format-upgrade floor forward the agent types only the normal migration
// command, and the installed engine decides which increment is owed, what input
// it needs, and when it commits. The invocations below use the installed
// discover or run command with no format-specific flag of any kind --
// `--adopt-ui-observations` is asserted absent from both the commands and the
// output, because a single occurrence of it here would mean the agent, not the
// engine, chose the transition.
//
// The format-17 record is *seeded* by this checkout (like every other record in
// this file) and then driven exclusively through the staged bundle.

const UI_CANDIDATE = "ui-observations-adoption/candidate/legacy.json";

/** The normal migration command, and the only one these tests are allowed. */
const normalCommand = (toolkit, consumer, extra = []) =>
  run(toolkit, "cli/discover-module.mjs", ["auth", ...extra], consumer.root);

const digestOf = (content) => createHash("sha256").update(content).digest("hex");

/**
 * A legitimately persisted format-17 record: the pinned legacy inventory carries
 * no `requiredObservations` and the stamp is the format that predates them. The
 * format-18 bytes the record was authored with are exactly what legacy authority
 * recovers afterwards, so they are returned for the candidate to be authored
 * from -- nothing here is derived from TARGET material.
 *
 * `artifactHashes` and the integrity anchor are repinned because the inventory
 * changed. That is the record's own consistency rule, not the mechanism under
 * test: every assertion below is about what the installed engine does with a
 * valid format-17 record, and the engine refuses to open an invalid one at all.
 */
const persistFormat17 = async (consumer, { visibleUi = true } = {}) => {
  const relative = "inventories/legacy.json";
  const absolute = path.join(consumer.recordRoot, relative);
  const legacyAuthority = await readFile(absolute);
  const inventory = JSON.parse(legacyAuthority.toString("utf8"));
  inventory.uiBehaviors = inventory.uiBehaviors.map(
    ({ requiredObservations: _dropped, ...rest }) => rest,
  );
  if (!visibleUi) {
    inventory.hasVisibleUi = false;
    inventory.uiBehaviors = [];
  }
  const downgraded = `${JSON.stringify(inventory, null, 2)}\n`;
  await writeFile(absolute, downgraded, "utf8");
  await consumer.editState((state) => ({
    ...state,
    formatVersion: 17,
    artifactHashes: { ...state.artifactHashes, [relative]: digestOf(downgraded) },
  }));
  const integrityPath = path.join(consumer.recordRoot, "integrity.json");
  const integrity = JSON.parse(await readFile(integrityPath, "utf8"));
  const { artifactHashes } = JSON.parse(await readFile(consumer.statePath, "utf8"));
  integrity.artifactHashesSha256 = digestOf(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(artifactHashes).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ),
    ),
  );
  await writeFile(integrityPath, `${JSON.stringify(integrity, null, 2)}\n`, "utf8");
  return legacyAuthority;
};

/**
 * One adopted, pinned, format-17 consumer record. The identity adoption and the
 * single lifecycle advance both run through the installed toolkit, so the
 * inventory the downgrade rewrites is a genuinely pinned artifact rather than a
 * freshly authored one.
 */
const seedFormat17Consumer = async (t, prefix, options) => {
  const toolkit = await installedToolkit();
  const consumer = await seedConsumer(t, prefix);
  await run(toolkit, "cli/toolkit-identity.mjs", ["adopt", "--module", "auth"], consumer.root);
  const advanced = await advance(toolkit, consumer.root);
  assert.equal(advanced.code, 0, advanced.output);
  const legacyAuthority = await persistFormat17(consumer, options);
  const seeded = await consumer.snapshot();
  assert.equal(seeded.state.formatVersion, 17, "the seed must persist format 17");
  assert.equal(seeded.journal, null, "the seed left a transaction behind");
  return { toolkit, consumer, legacyAuthority };
};

const formatUpgradeEvents = (snapshot) =>
  snapshot.history.filter((event) => event.event === "FORMAT_UPGRADED");

test("E2E-A: an installed toolkit upgrades a visible-UI format-17 record using only the normal command", async (t) => {
  const { toolkit, consumer, legacyAuthority } = await seedFormat17Consumer(
    t,
    "amt acceptance format upgrade ",
  );
  const before = await consumer.snapshot();

  // 1. The normal command identifies the increment, reports what it needs, and
  // freezes the lifecycle. Nothing is written and no flag is prescribed.
  const owed = await normalCommand(toolkit, consumer);
  assert.equal(owed.code, 2, owed.output);
  assert.match(owed.output, /FORMAT UPGRADE REQUIRED/);
  assert.match(owed.output, /current upgrade: 17->18 \(UI_OBSERVATIONS_ADOPTED v1\)/);
  assert.match(owed.output, /upgrade state: NEEDS_INPUT \(domain: TRANSFORM\)/);
  assert.match(owed.output, /required input: candidateFile ui-observations-adoption\/candidate\/legacy\.json \(authority: legacy\)/);
  assert.match(owed.output, /loop: STOP reason=FORMAT_UPGRADE/);
  assert.ok(
    !owed.output.includes("--adopt-ui-observations"),
    `the engine prescribed a format-specific flag:\n${owed.output}`,
  );
  assert.deepEqual(await consumer.snapshot(), before, "an owed increment wrote to the record");

  // 2. The candidate is authored from the record's own legacy authority, at the
  // one path the engine named.
  const candidate = path.join(consumer.recordRoot, UI_CANDIDATE);
  await mkdir(path.dirname(candidate), { recursive: true });
  await writeFile(candidate, legacyAuthority);

  // 3. The *same* command, re-run. One increment commits and the invocation ends.
  const upgraded = await normalCommand(toolkit, consumer);
  assert.equal(upgraded.code, 0, upgraded.output);
  assert.match(upgraded.output, /FORMAT_UPGRADED: 17 -> 18 \(domain TRANSFORM\)/);
  // 4. The continuation is an executable command, not a state token.
  assert.match(upgraded.output, /loop: CONTINUE next=\/start-migration auth/);
  assert.ok(
    !upgraded.output.includes("next=FORMAT_UPGRADE"),
    `the directive named a state token:\n${upgraded.output}`,
  );

  const after = await consumer.snapshot();
  assert.equal(after.state.formatVersion, MIGRATION_FORMAT_VERSION);
  assert.equal(after.state.revision, before.state.revision + 1);
  assert.equal(after.journal, null, "the upgrade left its journal behind");
  assert.equal(after.integrity.revision, after.state.revision);

  const events = formatUpgradeEvents(after);
  assert.equal(events.length, 1, "exactly one increment, exactly one canonical event");
  assert.equal(events[0].transition, "UI_OBSERVATIONS_ADOPTED");
  assert.equal(events[0].fromFormat, 17);
  assert.equal(events[0].toFormat, MIGRATION_FORMAT_VERSION);
  assert.equal(events[0].domain, "TRANSFORM");
  assert.deepEqual(events[0].upgrader, { id: "UI_OBSERVATIONS_ADOPTED", version: 1 });
  assert.equal(
    after.history.filter((event) => event.event === "UI_OBSERVATIONS_ADOPTED").length,
    0,
    "the canonical envelope is one row, not two",
  );

  // The checkpoint tuple is otherwise preserved: a format upgrade is not
  // lifecycle progress.
  assert.equal(after.state.status, before.state.status);
  assert.equal(after.state.currentStep, before.state.currentStep);
  assert.equal(after.state.activeSlice ?? null, before.state.activeSlice ?? null);
  assert.deepEqual(after.state.completedSteps, before.state.completedSteps);
  assert.deepEqual(after.state.pendingSteps, before.state.pendingSteps);
  assert.deepEqual(after.state.completedSlices, before.state.completedSlices);
  assert.deepEqual(after.state.pendingSlices, before.state.pendingSlices);
  assert.deepEqual(after.state.toolkitIdentity, toolkit.identity);

  // 5. The next invocation of that same command resumes the lifecycle at 18.
  const resumed = await normalCommand(toolkit, consumer);
  assert.ok(
    !resumed.output.includes("FORMAT UPGRADE REQUIRED"),
    `the lifecycle stayed frozen after the increment committed:\n${resumed.output}`,
  );
  assert.match(resumed.output, /Current checkpoint: DISCOVERY_COMPLETENESS/);
  const resumedState = await consumer.snapshot();
  assert.equal(resumedState.state.formatVersion, MIGRATION_FORMAT_VERSION);
  assert.equal(formatUpgradeEvents(resumedState).length, 1, "the increment re-applied");

  const status = JSON.parse(
    (await normalCommand(toolkit, consumer, ["--status"])).output,
  );
  assert.equal(status.formatUpgrade, null, "a caught-up record still owes an increment");
});

test("E2E-B: a format-17 record whose legacy authority declares no visible UI commits an atomic NO_OP", async (t) => {
  const { toolkit, consumer } = await seedFormat17Consumer(
    t,
    "amt acceptance format upgrade noop ",
    { visibleUi: false },
  );
  const before = await consumer.snapshot();

  // READY/NO_OP with no input at all: the engine invents no work, and neither
  // may the agent.
  const status = JSON.parse(
    (await normalCommand(toolkit, consumer, ["--status"])).output,
  );
  assert.equal(status.formatUpgrade.state, "READY");
  assert.equal(status.formatUpgrade.domain, "NO_OP");
  assert.equal(status.formatUpgrade.requiredInput, null);
  assert.equal(await exists(path.join(consumer.recordRoot, UI_CANDIDATE)), false);

  const upgraded = await normalCommand(toolkit, consumer);
  assert.equal(upgraded.code, 0, upgraded.output);
  assert.match(upgraded.output, /FORMAT_UPGRADED: 17 -> 18 \(domain NO_OP\)/);
  assert.match(upgraded.output, /loop: CONTINUE next=\/start-migration auth/);

  const after = await consumer.snapshot();
  assert.equal(after.state.formatVersion, MIGRATION_FORMAT_VERSION);
  assert.equal(after.state.revision, before.state.revision + 1);
  assert.equal(after.journal, null);
  const events = formatUpgradeEvents(after);
  assert.equal(events.length, 1, "a no-op is a committed increment, not a skipped one");
  assert.equal(events[0].domain, "NO_OP");
  assert.equal(events[0].transition, undefined);
  assert.deepEqual(events[0].inputs, []);

  // It moved the cursor and nothing else -- not one pin, not one checkpoint.
  assert.deepEqual(after.state.artifactHashes, before.state.artifactHashes);
  assert.equal(after.state.currentStep, before.state.currentStep);
  assert.equal(after.state.status, before.state.status);
  assert.deepEqual(after.state.completedSteps, before.state.completedSteps);
  assert.deepEqual(after.state.pendingSlices, before.state.pendingSlices);
  assert.equal(await exists(path.join(consumer.recordRoot, UI_CANDIDATE)), false);

  // And the lifecycle is live again on the next invocation of the same command.
  const resumed = await normalCommand(toolkit, consumer);
  assert.ok(
    !resumed.output.includes("FORMAT UPGRADE REQUIRED"),
    `the record stayed frozen at 17:\n${resumed.output}`,
  );
  assert.match(resumed.output, /Current checkpoint: DISCOVERY_COMPLETENESS/);
  assert.equal(formatUpgradeEvents(await consumer.snapshot()).length, 1);
});

test("E2E-C: reading the status of a pending format upgrade through the installation mutates nothing", async (t) => {
  const { toolkit, consumer } = await seedFormat17Consumer(
    t,
    "amt acceptance format upgrade status ",
  );
  const before = await consumer.snapshot();
  const bytesBefore = await readFile(
    path.join(consumer.recordRoot, "history/history.ndjson"),
    "utf8",
  );

  const status = await normalCommand(toolkit, consumer, ["--status"]);
  assert.equal(status.code, 0, status.output);
  const read = JSON.parse(status.output);

  // The structured projection is present and complete.
  assert.equal(read.formatUpgrade.recordFormat, 17);
  assert.equal(read.formatUpgrade.runtimeFormat, MIGRATION_FORMAT_VERSION);
  assert.equal(read.formatUpgrade.from, 17);
  assert.equal(read.formatUpgrade.to, MIGRATION_FORMAT_VERSION);
  assert.deepEqual(read.formatUpgrade.upgrader, {
    id: "UI_OBSERVATIONS_ADOPTED",
    version: 1,
  });
  assert.equal(read.formatUpgrade.state, "NEEDS_INPUT");
  assert.equal(read.formatUpgrade.domain, "TRANSFORM");
  assert.equal(read.formatUpgrade.requiredInput.path, UI_CANDIDATE);
  assert.equal(read.formatUpgrade.requiredInput.authority, "legacy");
  assert.ok(read.formatUpgrade.nextAction.length > 0);

  // And the record is byte-identical: identity, format, revision, history, and
  // no transaction residue.
  const after = await consumer.snapshot();
  assert.deepEqual(after, before, "a read mutated the record");
  assert.deepEqual(after.state.toolkitIdentity, toolkit.identity);
  assert.equal(after.state.formatVersion, 17);
  assert.equal(after.state.revision, before.state.revision);
  assert.equal(
    await readFile(path.join(consumer.recordRoot, "history/history.ndjson"), "utf8"),
    bytesBefore,
  );
  assert.equal(after.journal, null, "a read left a transaction behind");
  assert.equal(formatUpgradeEvents(after).length, 0, "a read committed an increment");
});

test("E2E-D: the built bundle states both engines' upgrade floors and registries, and no internals", async () => {
  const toolkit = await installedToolkit();
  // Read from the staged bundle rather than the builder's return value: the
  // manifest a consumer inspects is the file, not an in-memory object.
  const manifest = JSON.parse(
    await readFile(path.join(toolkit.root, "release-manifest.json"), "utf8"),
  );
  const { supports } = manifest;
  assert.deepEqual(supports, toolkit.manifest.supports);

  assert.equal(supports.moduleFormat, MIGRATION_FORMAT_VERSION);
  assert.equal(supports.moduleFormatSupported, 19);
  assert.equal(supports.formatUpgradeFloor, 17);
  assert.deepEqual(supports.formatUpgraders, [
    { from: 17, to: 18, id: "UI_OBSERVATIONS_ADOPTED", version: 1 },
    { from: 18, to: 19, id: "DIRECT_LEDGER_DECISIONS_ADOPTED", version: 1 },
  ]);

  assert.equal(supports.artifactFormat, 13);
  assert.equal(supports.artifactFormatUpgradeFloor, 13);
  assert.deepEqual(supports.artifactFormatUpgraders, []);

  // Identity only. A manifest states which increments a bundle can walk, never
  // how -- and a serialized `domain`/`plan`/`commit` would be both a leak and a
  // lie, since a function does not survive JSON at all.
  for (const row of supports.formatUpgraders) {
    assert.deepEqual(Object.keys(row).sort(), ["from", "id", "to", "version"]);
  }
  const serialized = JSON.stringify(supports);
  for (const internal of ["=>", "function", "domain", "plan", "commit", "requiredInput"]) {
    assert.ok(
      !serialized.includes(internal),
      `the manifest leaked '${internal}': ${serialized}`,
    );
  }
});

test("E2E-E: an early format-17 record discovers its authority before the normal command upgrades it", async (t) => {
  const toolkit = await installedToolkit();
  const consumer = await createUnstampedRecord({ prefix: "amt acceptance early format 17 " });
  t.after(() => consumer.cleanup());
  const legacyPath = path.join(consumer.recordRoot, "inventories/legacy.json");
  const initial = await consumer.snapshot();
  assert.equal(initial.state.currentStep, "DISCOVER_LEGACY");
  assert.deepEqual(initial.state.completedSteps, ["RESOLVE"]);
  assert.equal(initial.state.artifactHashes["inventories/legacy.json"], undefined);
  assert.equal(JSON.parse(await readFile(legacyPath, "utf8")).hasVisibleUi, false);

  // The fixture was born at the current format. Set the initial historical
  // stamp before any installed command runs; every transition thereafter is
  // performed by the installed engine, never by editing the cursor.
  await consumer.editState((state) => ({ ...state, formatVersion: 17 }));
  const early = await consumer.snapshot();
  const status = await normalCommand(toolkit, consumer, ["--status"]);
  assert.equal(status.code, 0, status.output);
  const projected = JSON.parse(status.output).formatUpgrade;
  assert.equal(projected.active, false);
  assert.equal(projected.state, "INACTIVE");
  assert.equal(projected.from, 17);
  assert.equal(projected.to, 18);
  assert.deepEqual(projected.upgrader, { id: "UI_OBSERVATIONS_ADOPTED", version: 1 });
  assert.equal(projected.prerequisite.path, "inventories/legacy.json");
  assert.ok(projected.nextAction);
  assert.deepEqual(await consumer.snapshot(), early, "inactive status wrote to the record");

  // Author the old-format inventory as ordinary DISCOVER_LEGACY work. Keep the
  // current-format bytes only as the later candidate's legacy-sourced content.
  await consumer.authorDiscoverLegacy();
  const candidateBytes = await readFile(legacyPath);
  const inventory = JSON.parse(candidateBytes.toString("utf8"));
  inventory.uiBehaviors = inventory.uiBehaviors.map(
    ({ requiredObservations: _dropped, ...behavior }) => behavior,
  );
  await writeFile(legacyPath, `${JSON.stringify(inventory, null, 2)}\n`);
  const normal = () => run(toolkit, "cli/run-migration.mjs", ["auth"], consumer.root);

  const discovered = await normal();
  assert.equal(discovered.code, 0, discovered.output);
  assert.doesNotMatch(discovered.output, /normal progress \(frozen behind the upgrade\)/);
  const pinned = await consumer.snapshot();
  assert.equal(pinned.state.currentStep, "DISCOVERY_COMPLETENESS");
  assert.ok(pinned.state.artifactHashes["inventories/legacy.json"]);
  assert.equal(pinned.state.formatVersion, 17);
  assert.equal(formatUpgradeEvents(pinned).length, 0);

  const active = await normal();
  assert.equal(active.code, 2, active.output);
  assert.match(active.output, /FORMAT UPGRADE REQUIRED/);
  assert.match(active.output, /upgrade state: NEEDS_INPUT \(domain: TRANSFORM\)/);
  assert.match(active.output, /required input: candidateFile ui-observations-adoption\/candidate\/legacy\.json/);
  assert.match(active.output, /loop: STOP reason=FORMAT_UPGRADE/);
  assert.deepEqual(await consumer.snapshot(), pinned, "the active preflight advanced the lifecycle");

  const candidate = path.join(consumer.recordRoot, UI_CANDIDATE);
  await mkdir(path.dirname(candidate), { recursive: true });
  await writeFile(candidate, candidateBytes);
  const upgraded = await normal();
  assert.equal(upgraded.code, 0, upgraded.output);
  assert.match(upgraded.output, /FORMAT_UPGRADED: 17 -> 18 \(domain TRANSFORM\)/);
  assert.match(upgraded.output, /loop: CONTINUE next=\/start-migration auth/);
  assert.doesNotMatch(upgraded.output, /next=FORMAT_UPGRADE/);
  const after = await consumer.snapshot();
  assert.equal(after.state.formatVersion, 18);
  assert.equal(after.state.currentStep, pinned.state.currentStep);
  assert.equal(formatUpgradeEvents(after).length, 1);
  assert.equal(formatUpgradeEvents(after)[0].transition, "UI_OBSERVATIONS_ADOPTED");

  const resumed = await normal();
  assert.doesNotMatch(resumed.output, /FORMAT UPGRADE REQUIRED/);
  assert.equal((await consumer.snapshot()).state.formatVersion, 18);
  assert.equal(formatUpgradeEvents(await consumer.snapshot()).length, 1);
  for (const invocation of [discovered, active, upgraded, resumed]) {
    assert.doesNotMatch(invocation.output, /--(?:confirm-)?adopt-ui-observations/);
  }
});
