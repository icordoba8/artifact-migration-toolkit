// Format 21 regression for the PR #7 OpenCode acceptance failure: the legacy
// service threw business identifiers, the legacy route layer mapped two of them
// to 409 and everything else to 422, and an OpenSpec written from the service
// alone still reached COMPLETE while the target answered 422. Driven through
// the real engine CLIs over a disposable consumer; the statuses below are what
// this fixture's route layer says, not anything the engine is told to expect.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runDiscoveryScan } from "../../src/census/index.mjs";
import { dirtyManifest } from "../../src/shared/index.mjs";
import { TARGET_DIRTY_SCOPE } from "../../src/slices/index.mjs";
import { LEGACY_INVENTORY, MODULE_CLASSIFICATION } from "../support/consumer-fixture.mjs";
import { historicalBootstrap } from "../support/historical-bootstrap.mjs";

const exec = promisify(execFile);
const bin = (file) => fileURLToPath(new URL(`../../src/${file}`, import.meta.url));
const BINS = {
  discover: bin("cli/discover-module.mjs"), run: bin("cli/run-migration.mjs"),
  registry: bin("cli/update-migration-registry.mjs"), validate: bin("cli/validate-migration.mjs"),
};
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const put = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const runner = `node ${process.version}`;

const LEGACY = {
  "auth/marker.txt": "auth\n",
  "auth/session-service.js": `export class SessionError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function signIn(input) {
  if (!input?.user) throw new SessionError("USER_REQUIRED");
  if (input.locked) throw new SessionError("LOCKED_OUT");
  return { id: "S1" };
}
export function signOut(id) {
  if (id === "gone") throw new SessionError("ALREADY_SIGNED_OUT");
  return null;
}
`,
  "auth/session-routes.js": `import * as sessions from "./session-service.js";
const STATUS = { LOCKED_OUT: 423, ALREADY_SIGNED_OUT: 409 };
const handle = (fn) => (req) => {
  try { return fn(req); }
  catch (error) {
    if (!(error instanceof sessions.SessionError)) return { status: 500, body: { error: "INTERNAL" } };
    return { status: STATUS[error.code] ?? 422, body: { error: error.code } };
  }
};
export const routes = {
  "POST /sessions": handle((req) => ({ status: 201, body: sessions.signIn(req.body) })),
  "DELETE /sessions/:id": handle((req) => ({ status: 204, body: sessions.signOut(req.params.id) })),
};
`,
};
const SIGN_IN = ["POST /sessions -> 201", "POST /sessions -> 422 USER_REQUIRED body{error}",
  "POST /sessions -> 423 LOCKED_OUT body{error}", "POST /sessions -> 500 INTERNAL body{error}"];
const SIGN_OUT = ["DELETE /sessions/:id -> 204", "DELETE /sessions/:id -> 409 ALREADY_SIGNED_OUT body{error}",
  "DELETE /sessions/:id -> 500 INTERNAL body{error}"];
const spec = (signIn = [], signOut = []) => `# Auth

### Requirement: AUTH-REQ-001 Sign in
The target MUST authenticate users, refusing a missing user (USER_REQUIRED) and a locked account (LOCKED_OUT).

#### Scenario: AUTH-SCN-001 Success
A valid user signs in.
${signIn.map((line) => `- Response: ${line}\n`).join("")}
### Requirement: AUTH-REQ-002 Sign out
The target MUST end a session, refusing one already ended (ALREADY_SIGNED_OUT).

#### Scenario: AUTH-SCN-002 Logout
A signed-in user signs out.
${signOut.map((line) => `- Response: ${line}\n`).join("")}`;

const consumer = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "api response contract "));
  const legacy = path.join(root, "legacy");
  const target = path.join(root, "target");
  const registry = path.join(target, ".agents/knowledge/migrations/registry.json");
  for (const [file, text] of Object.entries(LEGACY)) {
    await mkdir(path.dirname(path.join(legacy, file)), { recursive: true });
    await writeFile(path.join(legacy, file), text);
  }
  await mkdir(path.join(target, "src"), { recursive: true });
  await mkdir(path.dirname(registry), { recursive: true });
  await writeFile(path.join(target, "src/placeholder.ts"), "export {};\n");
  await writeFile(path.join(target, "package.json"), '{"name":"api-contract-consumer","private":true}\n');
  await put(registry, { version: 1, projects: {
    legacy: { root: path.relative(path.dirname(registry), legacy) },
    target: { root: path.relative(path.dirname(registry), target) },
  }, modules: { auth: { target: "auth" } } });
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["add", "-A"], { cwd: root });
  await exec("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
  const record = path.join(target, ".agents/knowledge/migrations/modules/auth");
  const call = (name, args, input) => spawnSync(process.execPath, [BINS[name], ...args], { cwd: target, input, encoding: "utf8" });
  const bootstrap = (content) => call("discover", ["auth", "--registry", registry, "--openspec-proposal-stdin", "--mode", "auto"], content);
  return { root, legacy, target, registry, record, call, bootstrap, cleanup: () => rm(root, { recursive: true, force: true }) };
};

const json = async (file) => JSON.parse(await readFile(file, "utf8"));

/** The census rows the scanner itself computes, so the classification is never a guess. */
const classificationFor = async (legacy, algorithmVersion) => {
  const scan = await runDiscoveryScan({ legacyRoot: legacy, moduleRoots: ["auth"], algorithmVersion });
  return { ...MODULE_CLASSIFICATION, algorithmVersion, files: scan.census.map((file) => ({
    path: file, scope: "OWNED", reachability: scan.reachability[file], reachedFrom: [], kind: scan.kinds[file],
    disposition: "BEHAVIOR_BACKED", behaviorIds: ["LB-1"], routeFlowIds: [], rationale: "Owned auth source.", evidence: [],
  })) };
};

test("format 21 refuses an OpenSpec that names the service errors but omits the route layer's statuses, and writes nothing", async () => {
  const fixture = await consumer();
  try {
    const refused = fixture.bootstrap(spec());
    assert.notEqual(refused.status, 0, "the service-only OpenSpec was accepted");
    const output = refused.stdout + refused.stderr;
    for (const line of [...SIGN_IN, ...SIGN_OUT]) assert.ok(output.includes(`API_RESPONSE_UNCOVERED: the legacy source establishes '${line}'`), line);
    assert.match(output, /'POST \/sessions -> 423 LOCKED_OUT body\{error\}' \(route auth\/session-routes\.js:\d+, status auth\/session-routes\.js:\d+, raised at auth\/session-service\.js:6\)/);
    // No partial state: no record and no pinned OpenSpec.
    await assert.rejects(readFile(path.join(fixture.record, "state.json")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(fixture.target, "openspec/specs/auth/spec.md")), { code: "ENOENT" });

    // A wrong status is both ungrounded and leaves the real one uncovered.
    const wrong = fixture.bootstrap(spec(SIGN_IN.map((l) => l.replace("423", "409")), SIGN_OUT));
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stdout + wrong.stderr, /API_RESPONSE_UNGROUNDED: AUTH-SCN-001 .*'Response: POST \/sessions -> 409 LOCKED_OUT body\{error\}'/);

    // The corrected proposal is a plain retry.
    const accepted = fixture.bootstrap(spec(SIGN_IN, SIGN_OUT));
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    const state = await json(path.join(fixture.record, "state.json"));
    assert.equal(state.formatVersion, 21);
    assert.equal(state.currentStep, "DISCOVER_LEGACY");
  } finally {
    await fixture.cleanup();
  }
});

test("format 21 rechecks the declared roots, binds slice evidence to every traced response, and completes only when all are proven", async () => {
  const fixture = await consumer();
  const { record, target, legacy, call } = fixture;
  const author = (relative, value) => put(path.join(record, relative), value);
  const doc = (number, file, name) => writeFile(path.join(record, `steps/${number}-${file}.md`),
    `# ${number}. ${name}\n\n- Status: \`COMPLETE\`\n\n## Result\n\nAuthored by the API contract test.\n`);
  const run = () => {
    const result = call("run", ["auth", "--mode", "auto", "--json"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const runTo = async (expected) => {
    const result = run();
    assert.equal((await json(path.join(record, "state.json"))).currentStep, expected, JSON.stringify(result));
    return result;
  };
  try {
    assert.equal(fixture.bootstrap(spec(SIGN_IN, SIGN_OUT)).status, 0);
    await doc("02", "discover-legacy", "Discover legacy");
    await author("inventories/legacy.json", { ...LEGACY_INVENTORY, hasVisibleUi: false, uiBehaviors: [] });
    const classification = await classificationFor(legacy, 5);
    await author("inventories/module-classification.json", classification);
    await runTo("DISCOVERY_COMPLETENESS");
    await doc("02a", "discovery-completeness", "Discovery completeness");

    // The legacy route layer moves under the record: the pinned OpenSpec no
    // longer matches what the declared roots establish, so the checkpoint holds.
    const routes = path.join(legacy, "auth/session-routes.js");
    await writeFile(routes, LEGACY["auth/session-routes.js"].replace("LOCKED_OUT: 423", "LOCKED_OUT: 429"));
    const drifted = await runTo("DISCOVERY_COMPLETENESS");
    assert.match(drifted.reason, /API_RESPONSE_UNCOVERED: the legacy source establishes 'POST \/sessions -> 429 LOCKED_OUT body\{error\}'/);
    assert.match(drifted.reason, /API_RESPONSE_UNGROUNDED: AUTH-SCN-001 .*423 LOCKED_OUT/);
    await writeFile(routes, LEGACY["auth/session-routes.js"]);

    await runTo("ASSESS_TARGET");
    const scan = await json(path.join(record, "inventories/discovery-scan.json"));
    assert.deepEqual(scan.apiContract.obligations.map((o) => o.id), [...SIGN_OUT, ...SIGN_IN].sort());
    await doc("03", "assess-target", "Assess target");
    await author("inventories/target.json", { version: 1, implementationState: "ABSENT",
      evidence: LEGACY_INVENTORY.behaviors[0].evidence.map((row) => row.location ? { ...row, location: "target/src/placeholder.ts" } : row),
      hasVisibleUi: false, navigationSurfaces: [], nativeBehaviors: [{ id: "TN-1", description: "Target-only telemetry" }],
      uiComponents: [], uiMismatches: [] });
    await runTo("BUILD_BASELINE");
    await doc("04", "build-baseline", "Build baseline");
    const matrices = (final) => ({
      "matrices/behavior-parity.json": { version: 1, rows: [{ id: "BR-1", behaviorId: "LB-1", targetState: "ABSENT",
        disposition: "IMPLEMENT", legacyEvidence: ["legacy/auth/marker.txt"], verificationStatus: final ? "VERIFIED" : "PENDING" }] },
      "matrices/route-adaptation.json": { version: 1, rows: [{ id: "RR-1", routeFlowId: "RF-1", targetAdaptation: "app/(auth)/login",
        verificationStatus: final ? "VERIFIED" : "PENDING", evidence: final ? ["target/src/placeholder.ts"] : [] }] },
      "matrices/target-native.json": { version: 1, rows: [{ id: "NR-1", nativeBehaviorId: "TN-1", verificationStatus: final ? "PRESERVED" : "PENDING" }] },
      "matrices/design-system-usage.json": { version: 1, rows: [] },
      "matrices/capability-ownership.json": { version: 1, architectureAuthorities: [], authorityGaps: [], rows: [
        { id: "CAP-1", capability: "Session handlers", classification: "FEATURE_LOCAL", requiredDisposition: "CREATE_FEATURE_LOCAL",
          legacyEvidence: ["legacy/auth/marker.txt"], targetEvidence: [], consumers: ["auth"], targetOwner: "src/features/auth/sessions",
          replacedBy: [], rationale: "Only auth consumes it." }] },
    });
    for (const [relative, value] of Object.entries(matrices(false))) await author(relative, value);
    assert.equal(call("registry", ["auth", "--target", "auth", "--mode", "auto"]).status, 0);
    await runTo("PLAN");
    await doc("05", "plan", "Plan");
    const slices = [
      { id: "slice-a", requirementIds: ["AUTH-REQ-001"], scenarioIds: ["AUTH-SCN-001"], traceIds: ["BR-1", "RR-1"],
        capabilityIds: ["CAP-1"], architectureAuthorities: [], targetPaths: ["src"], dependencies: [], acceptanceScenarios: ["Sign in"] },
      { id: "slice-b", requirementIds: ["AUTH-REQ-002"], scenarioIds: ["AUTH-SCN-002"], traceIds: ["NR-1"],
        capabilityIds: [], architectureAuthorities: [], targetPaths: ["src"], dependencies: [], acceptanceScenarios: ["Sign out"] },
    ];
    await author("slices/index.json", { version: 1, slices });
    await runTo("IMPLEMENT_SLICES");
    await doc("06", "implement-slices", "Implement slices");
    await doc("07", "verify-slices", "Verify slices");
    const evidence = async (slice, output) => {
      const file = path.join(record, `evidence/${slice.id}/commands/test.txt`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, output);
      await author(`evidence/${slice.id}/result.json`, { sliceId: slice.id, result: "PASS", requirementIds: slice.requirementIds,
        scenarioIds: slice.scenarioIds, capabilityIds: slice.capabilityIds, traceIds: slice.traceIds,
        commands: [{ command: "node --test target", exitCode: 0, executedAt: new Date().toISOString(), runner,
          outputPath: path.relative(target, file).replaceAll(path.sep, "/"), outputDigest: sha(output) }],
        scenarios: slice.acceptanceScenarios, uiEvidence: [], uiEvidenceLimitations: [], residualRisks: [],
        // Citations of shared source the next slice extends: not evidence VERIFY_SLICES pinned.
        sources: await Promise.all(SHARED.map(async (file) => ({ reference: file, hash: sha(await readFile(path.join(target, file))) }))) });
    };
    const tap = (lines, failing = []) => `TAP version 13\n${lines.map((line, index) =>
      `${failing.includes(line) ? "not ok" : "ok"} ${index + 1} - Response: ${line}`).join("\n")}\n`;
    const SHARED = ["src/routes.ts", "src/sessions.test.ts"];
    for (const [slice, owed] of [[slices[0], SIGN_IN], [slices[1], SIGN_OUT]]) {
      await writeFile(path.join(target, `src/${slice.id}.ts`), "export {};\n");
      // Each slice adds its own route and its own test case to the same two shared files.
      for (const file of SHARED) await writeFile(path.join(target, file), `${await readFile(path.join(target, file), "utf8").catch(() => "")}// ${slice.id}\n`);
      await author(`slices/${slice.id}.json`, { id: slice.id, implementationStatus: "COMPLETE", requirementIds: slice.requirementIds,
        scenarioIds: slice.scenarioIds, traceIds: slice.traceIds, capabilityIds: slice.capabilityIds, changedFiles: [`src/${slice.id}.ts`, ...SHARED],
        decisions: ["Implemented in the target architecture."], checks: ["typecheck"] });
      await runTo("VERIFY_SLICES");
      if (slice.id === "slice-a") {
        // A claimed PASS whose output omits the conflict, then one that runs it and fails it.
        const conflict = SIGN_IN.find((line) => line.includes("LOCKED_OUT"));
        await evidence(slice, "all tests passed\n");
        assert.match((await runTo("VERIFY_SLICES")).reason, /API_RESPONSE_UNVERIFIED: slice-a .*'POST \/sessions -> 201'.*'POST \/sessions -> 423 LOCKED_OUT body\{error\}'/);
        await evidence(slice, tap(SIGN_IN.filter((line) => line !== conflict)));
        assert.match((await runTo("VERIFY_SLICES")).reason, /API_RESPONSE_UNVERIFIED: slice-a .*'POST \/sessions -> 423 LOCKED_OUT body\{error\}'\./);
        await evidence(slice, tap(SIGN_IN, [conflict]));
        assert.match((await runTo("VERIFY_SLICES")).reason, /API_RESPONSE_UNVERIFIED: slice-a .*423 LOCKED_OUT/);
      }
      if (slice.id === "slice-b") {
        // The PR #7 OpenCode failure: the next slice re-ran one shared output
        // file over a completed slice's evidence, then rewrote the completed
        // slice's pinned result to match. Each is refused, naming the fix.
        const shared = path.join(record, "evidence/slice-a/commands/test.txt");
        const pinned = path.join(record, "evidence/slice-a/result.json");
        const [output, result, before] = [await readFile(shared), await readFile(pinned), await readFile(path.join(record, "state.json"))];
        await writeFile(shared, tap(SIGN_OUT));
        assert.match((await runTo("VERIFY_SLICES")).reason, /COMPLETED_EVIDENCE_CHANGED: .*slice-a evidence commands\[0\]\.outputDigest does not match '\S*evidence\/slice-a\/commands\/test\.txt'.*restore those bytes/);
        await writeFile(shared, output);
        await writeFile(pinned, result.toString().replace("node --test target", "node --test target/all"));
        const refused = call("run", ["auth", "--mode", "auto", "--json"]);
        assert.notEqual(refused.status, 0);
        assert.match(refused.stdout + refused.stderr, /Completed artifact changed after validation: evidence\/slice-a\/result\.json\. .*restore the validated bytes/);
        assert.match(call("discover", ["auth", "--rework-slice", "slice-a", "--confirm-rework"]).stderr, /Completed artifact changed after validation/);
        await writeFile(pinned, result);
        assert.deepEqual(await readFile(path.join(record, "state.json")), before, "a refusal wrote the record");
      }
      await evidence(slice, tap(owed));
      await runTo(slice.id === "slice-a" ? "IMPLEMENT_SLICES" : "FINALIZE");
    }
    await doc("08", "finalize", "Finalize");
    for (const [relative, value] of Object.entries(matrices(true))) await author(relative, value);
    const state = await json(path.join(record, "state.json"));
    const revision = async (root) => (await exec("git", ["-C", root, "log", "-1", "--format=%H", "--", "."])).stdout.trim();
    const boundTo = { target: "auth", legacyRevision: await revision(legacy), targetRevision: await revision(target),
      requirementsDigest: state.requirementsAuthority.digest, dataSourceMode: "standard",
      legacyDirtyDigest: (await dirtyManifest(legacy)).digest, targetDirtyDigest: (await dirtyManifest(target, TARGET_DIRTY_SCOPE)).digest };
    await author("gates.json", { version: 1, gates: ["ARCHITECTURE_PLAN_GATE", "TARGETED_VERIFY", "FUNCTIONAL_PARITY_GATE", "SIMPLIFY_ONCE",
      "ARCHITECTURE_IMPLEMENTATION_GATE", "PRECOMMIT_GATE", "FINAL_VERIFY"].map((gate) => ({ gate, result: "PASS", attempts: 1,
      evidence: [{ kind: "command", reference: "node --test target", producedAt: new Date().toISOString(), producer: "api-contract-test",
        environment: runner, hash: `sha256:${"a".repeat(64)}`, boundTo }] })) });
    assert.equal((await runTo("COMPLETE")).outcome, "COMPLETE");
    const validated = call("validate", ["auth", "--complete"]);
    assert.equal(validated.status, 0, validated.stdout + validated.stderr);
  } finally {
    await fixture.cleanup();
  }
});

test("a persisted format-20 record keeps format-20 semantics over the same API module", async () => {
  const fixture = await consumer();
  const { record, legacy, call } = fixture;
  try {
    assert.equal(fixture.bootstrap(spec(SIGN_IN, SIGN_OUT)).status, 0);
    await historicalBootstrap(record, 20);
    await writeFile(path.join(record, "steps/02-discover-legacy.md"), "# 02. Discover legacy\n\n- Status: `COMPLETE`\n\n## Result\n\nAuthored.\n");
    await put(path.join(record, "inventories/legacy.json"), { ...LEGACY_INVENTORY, hasVisibleUi: false, uiBehaviors: [] });
    // Algorithm 4 is still what a format-20 record records, and it carries no API contract.
    await put(path.join(record, "inventories/module-classification.json"), await classificationFor(legacy, 4));
    const result = call("run", ["auth", "--mode", "auto", "--json"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const state = await json(path.join(record, "state.json"));
    assert.equal(state.formatVersion, 20);
    assert.equal(state.currentStep, "DISCOVERY_COMPLETENESS", result.stdout);
  } finally {
    await fixture.cleanup();
  }
});
