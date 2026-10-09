import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { buildRelease, buildReleaseArchive, verifyRelease } from "../scripts/release.mjs";
import { candidateReleaseRoot } from "../packages/migration-engine/test/support/candidate-release-root.mjs";
import { SPEC, LEGACY_INVENTORY, MODULE_CLASSIFICATION } from
  "../packages/migration-engine/test/support/consumer-fixture.mjs";

const exec = promisify(execFile);
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const put = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const stepNames = {
  DISCOVER_LEGACY: ["02", "discover-legacy", "Discover legacy"],
  DISCOVERY_COMPLETENESS: ["02a", "discovery-completeness", "Discovery completeness"],
  ASSESS_TARGET: ["03", "assess-target", "Assess target"],
  BUILD_BASELINE: ["04", "build-baseline", "Build baseline"],
  PLAN: ["05", "plan", "Plan"],
  IMPLEMENT_SLICES: ["06", "implement-slices", "Implement slices"],
  VERIFY_SLICES: ["07", "verify-slices", "Verify slices"],
  FINALIZE: ["08", "finalize", "Finalize"],
};
const gates = ["ARCHITECTURE_PLAN_GATE", "TARGETED_VERIFY", "FUNCTIONAL_PARITY_GATE",
  "SIMPLIFY_ONCE", "ARCHITECTURE_IMPLEMENTATION_GATE", "PRECOMMIT_GATE", "FINAL_VERIFY"];
const slices = [
  { id: "slice-a", requirementIds: ["AUTH-REQ-001"], scenarioIds: ["AUTH-SCN-001"],
    traceIds: ["BR-1", "RR-1"], capabilityIds: ["CAP-1"], architectureAuthorities: [],
    targetPaths: ["src"], dependencies: [], acceptanceScenarios: ["Sign in succeeds"] },
  { id: "slice-b", requirementIds: ["AUTH-REQ-002"], scenarioIds: ["AUTH-SCN-002"],
    traceIds: ["NR-1"], capabilityIds: [], architectureAuthorities: [],
    targetPaths: ["src"], dependencies: [], acceptanceScenarios: ["Sign out succeeds"] },
];

test("offline installed toolkit bootstraps a fresh consumer and completes migration", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "installed full lifecycle "));
  let childId = 0;
  const capture = async (command, args, cwd, input) => {
    const stdoutPath = path.join(scratch, `child-${childId++}.stdout`);
    const stderrPath = path.join(scratch, `child-${childId++}.stderr`);
    const stdout = await open(stdoutPath, "w");
    const stderr = await open(stderrPath, "w");
    let code;
    try {
      const child = spawn(command, args, { cwd, stdio: ["pipe", stdout.fd, stderr.fd] });
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
      code = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
    } finally {
      await Promise.all([stdout.close(), stderr.close()]);
    }
    return { code, stdout: await readFile(stdoutPath, "utf8"), stderr: await readFile(stderrPath, "utf8") };
  };
  try {
    const candidate = await candidateReleaseRoot(scratch);
    const built = await buildRelease({ root: candidate, force: true });
    await verifyRelease(built.stagingRoot);
    const archive = await buildReleaseArchive(built);
    const manifest = await json(path.join(built.stagingRoot, "release-manifest.json"));
    const consumer = path.join(scratch, "fresh consumer with spaces");
    const store = path.join(scratch, "store");
    const legacy = path.join(consumer, "legacy");
    const target = path.join(consumer, "target");
    const registry = path.join(target, ".agents/knowledge/migrations/registry.json");
    const record = path.join(target, ".agents/knowledge/migrations/modules/auth");
    const bootstrap = path.join(consumer, ".agents/skills/start-migration/scripts/runtime.mjs");
    await mkdir(path.dirname(bootstrap), { recursive: true });
    await cp(path.join(built.stagingRoot, "providers/codex/skills/start-migration/scripts/runtime.mjs"), bootstrap);
    // The installed skill's identity stamp, exactly where `skills add` puts it.
    // No `--version` anywhere below: this suite's whole value is that it is the
    // *normal* path, so selection has to read the real stamp off disk and prove
    // it against the staged release's own manifest.
    await cp(
      path.join(built.stagingRoot, "providers/codex/skills/start-migration/release-identity.json"),
      path.join(path.dirname(bootstrap), "../release-identity.json"),
    );
    await mkdir(path.join(legacy, "auth"), { recursive: true });
    await mkdir(path.join(target, "src"), { recursive: true });
    await mkdir(path.dirname(registry), { recursive: true });
    await writeFile(path.join(consumer, "package.json"), '{"name":"installed-e2e","private":true}\n');
    await writeFile(path.join(legacy, "auth/marker.txt"), "auth\n");
    await writeFile(path.join(target, "src/placeholder.ts"), "export {};\n");
    await put(registry, { version: 1, projects: {
      legacy: { root: path.relative(path.dirname(registry), legacy) },
      target: { root: path.relative(path.dirname(registry), target) },
    }, modules: { auth: { target: "auth" } } });
    await exec("git", ["init", "-q"], { cwd: consumer });
    await exec("git", ["add", "-A"], { cwd: consumer });
    await exec("git", ["-c", "user.name=Installed Test", "-c", "user.email=installed@example.invalid",
      "commit", "-qm", "fresh consumer"], { cwd: consumer });
    const runtime = await import(pathToFileURL(bootstrap).href);
    const transport = {
      resolve: async () => ({ asset: { name: path.basename(archive.archive), digest: archive.digest,
        url: "private://offline-candidate" }, commit: built.identity.commit,
      version: built.identity.version, viaGh: false }),
      download: async (_selection, destination) => {
        await cp(archive.archive, destination);
        assert.equal(sha(await readFile(destination)), archive.digest);
      },
    };
    const installed = await runtime.ensureRuntime({ provider: "codex", root: consumer,
      store }, transport);
    assert.equal(installed.bootstrapped, true);
    assert.equal(installed.selection, "skill");
    assert.equal(installed.skillIdentity, "required");
    assert.deepEqual(installed.toolkit, manifest.toolkit);
    const receipt = await json(path.join(consumer, ".artifact-migration-tools/codex.json"));
    assert.deepEqual(receipt.toolkit, manifest.toolkit);
    const ensure = await capture(process.execPath, [bootstrap, "ensure", "--provider", "codex",
      "--root", consumer, "--store", store], consumer);
    assert.equal(ensure.code, 0, ensure.stderr);
    assert.equal(JSON.parse(ensure.stdout).bootstrapped, false);
    assert.equal(JSON.parse(ensure.stdout).network, false);
    await assert.rejects(readFile(path.join(record, "state.json")), /ENOENT/);
    const command = async (name, args, input) => {
      const [bin, ...prefix] = receipt.commands[name];
      assert.ok(path.isAbsolute(bin));
      const result = await capture(bin, [...prefix, ...args], consumer, input);
      assert.equal(result.code, 0, `${name}: ${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    const author = (relative, value) => put(path.join(record, relative), value);
    const doc = (step) => {
      const [number, file, name] = stepNames[step];
      return writeFile(path.join(record, `steps/${number}-${file}.md`),
        `# ${number}. ${name}\n\n- Status: \`COMPLETE\`\n\n## Result\n\nAuthored by installed lifecycle test.\n`);
    };
    const run = async () => {
      const stdout = await command("artifact-migration-run", ["auth", "--mode", "auto", "--json"]);
      const result = JSON.parse(stdout.slice(stdout.indexOf('{\n  "outcome"'), stdout.lastIndexOf("\nloop:")));
      assert.ok(["CONTINUE", "COMPLETE"].includes(result.outcome), stdout);
      return result;
    };
    const runTo = async (expected) => {
      const result = await run();
      const state = await json(path.join(record, "state.json"));
      assert.equal(state.currentStep, expected, JSON.stringify(result));
      return result;
    };
    await command("artifact-migration-discover", ["auth", "--registry", registry,
      "--openspec-proposal-stdin", "--mode", "auto"], SPEC);
    assert.equal((await json(path.join(record, "state.json"))).revision, 1);
    assert.deepEqual((await json(path.join(record, "state.json"))).toolkitIdentity, manifest.toolkit);
    const legacyInventory = { ...LEGACY_INVENTORY, hasVisibleUi: false, uiBehaviors: [] };
    const targetInventory = {
      version: 1, implementationState: "ABSENT",
      evidence: LEGACY_INVENTORY.behaviors[0].evidence.map((row) =>
        row.location ? { ...row, location: "target/src/placeholder.ts" } : row),
      hasVisibleUi: false, navigationSurfaces: [],
      nativeBehaviors: [{ id: "TN-1", description: "Target-only telemetry" }],
      uiComponents: [], uiMismatches: [],
    };
    const matrices = (final) => ({
      "matrices/behavior-parity.json": { version: 1, rows: [{ id: "BR-1", behaviorId: "LB-1",
        targetState: "ABSENT", disposition: "IMPLEMENT", legacyEvidence: ["legacy/auth/marker.txt"],
        verificationStatus: final ? "VERIFIED" : "PENDING" }] },
      "matrices/route-adaptation.json": { version: 1, rows: [{ id: "RR-1", routeFlowId: "RF-1",
        targetAdaptation: "app/(auth)/login", verificationStatus: final ? "VERIFIED" : "PENDING",
        evidence: final ? ["target/src/placeholder.ts"] : [] }] },
      "matrices/target-native.json": { version: 1, rows: [{ id: "NR-1", nativeBehaviorId: "TN-1",
        verificationStatus: final ? "PRESERVED" : "PENDING" }] },
      "matrices/design-system-usage.json": { version: 1, rows: [] },
      "matrices/capability-ownership.json": { version: 1, architectureAuthorities: [], authorityGaps: [], rows: [
        { id: "CAP-1", capability: "Credential form shell", classification: "FEATURE_LOCAL",
          requiredDisposition: "CREATE_FEATURE_LOCAL", legacyEvidence: ["legacy/auth/marker.txt"],
          targetEvidence: [], consumers: ["auth"], targetOwner: "src/features/auth/form",
          replacedBy: [], rationale: "Only auth consumes it." },
        { id: "CAP-2", capability: "Typed placeholder module", classification: "TARGET_REUSE",
          requiredDisposition: "REUSE_EXISTING", legacyEvidence: ["legacy/auth/marker.txt"],
          targetEvidence: ["target/src/placeholder.ts"], consumers: ["auth"],
          targetOwner: "src", replacedBy: [], rationale: "Already present." },
      ] },
    });
    const writeMatrices = async (final) => {
      for (const [relative, value] of Object.entries(matrices(final))) await author(relative, value);
    };
    await doc("DISCOVER_LEGACY");
    await author("inventories/legacy.json", legacyInventory);
    await author("inventories/module-classification.json", MODULE_CLASSIFICATION);
    await runTo("DISCOVERY_COMPLETENESS");
    await doc("DISCOVERY_COMPLETENESS");
    await author("inventories/module-classification.json", MODULE_CLASSIFICATION);
    await runTo("ASSESS_TARGET");
    await doc("ASSESS_TARGET");
    await author("inventories/target.json", targetInventory);
    await runTo("BUILD_BASELINE");
    await doc("BUILD_BASELINE");
    await writeMatrices(false);
    await command("artifact-migration-registry", ["auth", "--target", "auth", "--mode", "auto"]);
    await runTo("PLAN");
    await doc("PLAN");
    await author("slices/index.json", { version: 1, slices });
    await runTo("IMPLEMENT_SLICES");
    await doc("IMPLEMENT_SLICES");
    await doc("VERIFY_SLICES");
    for (const slice of slices) {
      const changedFile = `src/${slice.id}.ts`;
      await writeFile(path.join(target, changedFile), "export {};\n");
      // Fix B: slice-a writes a file its record does not list. slice-b still
      // scopes `src`, so it is no drift question now and slice-b claims it.
      if (slice.id === "slice-a") await writeFile(path.join(target, "src/shared.ts"), "export {};\n");
      await author(`slices/${slice.id}.json`, {
        id: slice.id, implementationStatus: "COMPLETE", requirementIds: slice.requirementIds,
        scenarioIds: slice.scenarioIds, traceIds: slice.traceIds,
        capabilityIds: slice.capabilityIds, changedFiles: [changedFile],
        decisions: ["Implemented in the target architecture."], checks: ["typecheck"],
      });
      await runTo("VERIFY_SLICES");
      if (slice.id === "slice-b") {
        assert.ok((await json(path.join(record, "slices/slice-b.json"))).changedFiles.includes("src/shared.ts"));
        // Fix A: two late in-scope edits after the claim. Post-census the
        // format-19 group line is not writable, so none is offered; each
        // member is, and each is accepted by the writer that offered it.
        await writeFile(path.join(target, "src/late-a.ts"), "export {};\n");
        await writeFile(path.join(target, "src/late-b.ts"), "export {};\n");
        const pending = JSON.parse(await command("artifact-migration-decision", ["auth", "--pending"]));
        assert.equal(pending.group, null);
        assert.deepEqual(pending.candidates.map((candidate) => candidate.kind),
          ["TARGET_DRIFT_ACCEPTED", "TARGET_DRIFT_ACCEPTED"]);
        for (let open = pending.candidates; open.length > 0;
          open = JSON.parse(await command("artifact-migration-decision", ["auth", "--pending"])).candidates) {
          const reference = `review-${sha(JSON.stringify(open[0].review)).slice(7, 39)}`;
          assert.match(await command("artifact-migration-decision",
            ["auth", "--relay", reference, "--decision", "APPROVE"]), /Recorded AGENT_RELAYED APPROVED/);
        }
        assert.deepEqual(JSON.parse(await command("artifact-migration-decision", ["auth", "--pending"])).candidates, []);
      }
      const output = "pnpm --dir target test\nall tests passed\n";
      const outputAbsolute = path.join(record, `evidence/${slice.id}/commands/test.txt`);
      await mkdir(path.dirname(outputAbsolute), { recursive: true });
      await writeFile(outputAbsolute, output);
      await author(`evidence/${slice.id}/result.json`, {
        sliceId: slice.id, result: "PASS", requirementIds: slice.requirementIds,
        scenarioIds: slice.scenarioIds, capabilityIds: slice.capabilityIds,
        traceIds: slice.traceIds, commands: [{ command: "pnpm --dir target test", exitCode: 0,
          executedAt: new Date().toISOString(), runner: `node ${process.version}`,
          outputPath: path.relative(target, outputAbsolute).replaceAll(path.sep, "/"),
          outputDigest: sha(output) }], scenarios: slice.acceptanceScenarios,
        uiEvidence: [], uiEvidenceLimitations: [], residualRisks: [],
      });
      await runTo(slice.id === "slice-a" ? "IMPLEMENT_SLICES" : "FINALIZE");
    }
    await doc("FINALIZE");
    await writeMatrices(true);
    const utils = await import(pathToFileURL(path.join(receipt.release,
      "packages/migration-engine/src/migration-utils.mjs")).href);
    const engine = await import(pathToFileURL(path.join(receipt.release,
      "packages/migration-engine/src/resumable-migration.mjs")).href);
    const state = await json(path.join(record, "state.json"));
    const revision = async (root) => (await exec("git", ["-C", root, "log", "-1", "--format=%H", "--", "."])).stdout.trim();
    const boundTo = { target: "auth", legacyRevision: await revision(legacy),
      targetRevision: await revision(target), requirementsDigest: state.requirementsAuthority.digest,
      dataSourceMode: "standard", legacyDirtyDigest: (await utils.dirtyManifest(legacy)).digest,
      targetDirtyDigest: (await utils.dirtyManifest(target, engine.TARGET_DIRTY_SCOPE)).digest };
    await author("gates.json", { version: 1, gates: gates.map((gate) => ({ gate, result: "PASS",
      attempts: 1, evidence: [{ kind: "command", reference: "pnpm --dir target test",
        producedAt: new Date().toISOString(), producer: "installed-lifecycle-test",
        environment: `node ${process.version}`, hash: `sha256:${"a".repeat(64)}`, boundTo }] })) });
    const final = await runTo("COMPLETE");
    assert.equal(final.outcome, "COMPLETE", JSON.stringify(final));
    assert.match(await command("artifact-migration-validate", ["auth", "--complete"]), /Complete auth/);
    const complete = await json(path.join(record, "state.json"));
    assert.equal(complete.status, "COMPLETE");
    assert.equal(complete.currentStep, "COMPLETE");
    assert.deepEqual(await readdir(path.dirname(record)), ["auth"]);
    assert.deepEqual(complete.completedSlices, slices.map((slice) => slice.id));
    assert.deepEqual(complete.toolkitIdentity, manifest.toolkit);
    const historyBytes = await readFile(path.join(record, "history/history.ndjson"));
    const events = historyBytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);
    const integrity = await json(path.join(record, "integrity.json"));
    const canonical = (value) => JSON.stringify(value, (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
    for (const [index, event] of events.entries()) {
      const { hash, ...payload } = event;
      assert.equal(event.seq, index + 1);
      assert.equal(event.previousHash, index === 0 ? null : events[index - 1].hash);
      assert.equal(hash, sha(`artifact-migration-tools/module-history/v1\n${canonical(payload)}`));
    }
    assert.deepEqual(events.filter((event) => event.event === "SLICE_SCOPE_AMENDED")
      .map(({ slice, added }) => ({ slice, added })), [{ slice: "slice-b", added: ["src/shared.ts"] }]);
    assert.equal(events.at(-1).event, "STEP_COMPLETED");
    assert.equal(integrity.historyChain.headHash, events.at(-1).hash);
    assert.equal(sha(historyBytes.subarray(0, integrity.history.bytes)).slice(7), integrity.history.sha256);
    await assert.rejects(readFile(path.join(record, "advance.journal")), /ENOENT/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
