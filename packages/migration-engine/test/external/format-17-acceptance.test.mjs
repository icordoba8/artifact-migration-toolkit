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
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { buildRelease } from "../../../../scripts/release.mjs";
import { createUnstampedRecord } from "../support/consumer-fixture.mjs";
import { downgradeToV4, readTree } from "../support/downgrade-v4.mjs";
import { MIGRATION_FORMAT_VERSION } from "../../src/resumable-migration.mjs";
import { validateToolkitIdentity } from "../../src/toolkit-identity.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

let bundlePromise;
/** One installed toolkit for the whole file, built from the committed payload. */
const installedToolkit = async () => {
  bundlePromise ??= buildRelease({ force: true }).then((built) => ({
    root: built.stagingRoot,
    engine: path.join(built.stagingRoot, "packages/migration-engine"),
    identity: built.identity,
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
