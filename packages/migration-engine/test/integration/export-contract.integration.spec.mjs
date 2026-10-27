// M14.1 regression for the M14 D1 acceptance failure: a library module's
// `signIn(user, options)` read `options.now`, the migrated export took a bare
// Date, every agent-authored test called the new signature, and the record
// still reached COMPLETE. Driven through the real engine CLIs over a disposable
// consumer: FINALIZE refuses the changed call contract, then refuses the fix
// because it changed verified source after VERIFY_SLICES, and completes once a
// verification run is recorded after the change.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runDiscoveryScan } from "../../src/census/index.mjs";
import { HISTORY_FILE } from "../../src/formats/index.mjs";
import { dirtyManifest } from "../../src/shared/index.mjs";
import { TARGET_DIRTY_SCOPE } from "../../src/slices/index.mjs";
import { fileIdentity } from "../../src/store/index.mjs";
import { LEGACY_INVENTORY, MODULE_CLASSIFICATION, SPEC } from "../support/consumer-fixture.mjs";

const exec = promisify(execFile);
const bin = (file) => fileURLToPath(new URL(`../../src/${file}`, import.meta.url));
const BINS = {
  discover: bin("cli/discover-module.mjs"), run: bin("cli/run-migration.mjs"),
  registry: bin("cli/update-migration-registry.mjs"), validate: bin("cli/validate-migration.mjs"),
};
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const put = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const runner = `node ${process.version}`;

// The legacy module and its consumers. `checkout.js` is production: it calls
// `signIn` with the options bag through the module's public index, which owes
// every export it has, and reaches `issueToken` by its deep path, which owes
// only that name. The test reaches an internal on purpose and sets no contract.
const LEGACY = {
  "auth/marker.txt": "auth\n",
  "auth/session.js": `'use strict';
const { issueToken } = require('./tokens');
function signIn(user, options) {
  const opts = options || {};
  if (!user || !user.name) throw new Error('USER_REQUIRED');
  return { user: user.name, token: issueToken(user.name, opts.now) };
}
function resetForTests() {}
module.exports = { signIn, resetForTests };
`,
  "auth/index.js": `'use strict';
const { signIn } = require('./session');
const { issueToken } = require('./tokens');
function describeSession(session) { return session.user + '@' + session.token; }
module.exports = { signIn, issueToken, describeSession };
`,
  "auth/tokens.js": `'use strict';
function issueToken(name, now) { return name + ':' + (now || new Date()).toISOString(); }
module.exports = { issueToken };
`,
  "orders/checkout.js": `'use strict';
const { signIn } = require('../auth');
const { issueToken } = require('../auth/tokens');
module.exports = { checkout: (user, now) => [signIn(user, { now }), issueToken(user.name, now)] };
`,
  "test/session.test.js": `'use strict';
const { resetForTests } = require('../auth/session');
resetForTests();
`,
};

// The target keeps `issueToken` only in its feature index, under another file name.
// Its first index forgets `describeSession`, which no consumer names but the public index exports.
const INDEX_KEPT = "export { signIn } from './session.js';\nexport { issueToken } from './token-format.js';\nexport const describeSession = (session) => `${session.user}@${session.token}`;\n";
const TARGET = {
  "src/features/auth/token-format.js": "export function issueToken(name, now = new Date()) {\n  return `${name}:${now.toISOString()}`;\n}\n",
  "src/features/auth/index.js": "export { signIn } from './session.js';\nexport { issueToken } from './token-format.js';\n",
  "src/features/auth/sign-out.js": "export const signOut = () => null;\n",
};
// M14 D1: the options bag became a bare Date.
const SESSION_D1 = `import { issueToken } from './token-format.js';
export function signIn(user, now = new Date()) {
  if (!user?.name) throw new Error('USER_REQUIRED');
  return { user: user.name, token: issueToken(user.name, now) };
}
`;
const SESSION_KEPT = `import { issueToken } from './token-format.js';
export function signIn(user, { now } = {}) {
  if (!user?.name) throw new Error('USER_REQUIRED');
  return { user: user.name, token: issueToken(user.name, now) };
}
`;

const consumer = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "export contract "));
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
  await writeFile(path.join(target, "package.json"), '{"name":"export-contract-consumer","private":true,"type":"module"}\n');
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
  return { root, legacy, target, record, call, bootstrap, cleanup: () => rm(root, { recursive: true, force: true }) };
};

const json = async (file) => JSON.parse(await readFile(file, "utf8"));

/** The census rows the scanner itself computes, so the classification is never a guess. */
const classificationFor = async (legacy) => {
  const scan = await runDiscoveryScan({ legacyRoot: legacy, moduleRoots: ["auth"], algorithmVersion: 5 });
  return { ...MODULE_CLASSIFICATION, algorithmVersion: 5, files: scan.census.map((file) => ({
    path: file, scope: "OWNED", reachability: scan.reachability[file], reachedFrom: [], kind: scan.kinds[file],
    disposition: "BEHAVIOR_BACKED", behaviorIds: ["LB-1"], routeFlowIds: [], rationale: "Owned auth source.", evidence: [],
  })) };
};

test("FINALIZE refuses a changed export call contract, then source changed after verification, and completes on fresh evidence", async () => {
  const fixture = await consumer();
  const { record, target, legacy, call } = fixture;
  const author = (relative, value) => put(path.join(record, relative), value);
  const doc = (number, file, name) => writeFile(path.join(record, `steps/${number}-${file}.md`),
    `# ${number}. ${name}\n\n- Status: \`COMPLETE\`\n\n## Result\n\nAuthored by the export contract test.\n`);
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
  const writeTarget = async (file, text) => {
    await mkdir(path.dirname(path.join(target, file)), { recursive: true });
    await writeFile(path.join(target, file), text);
  };
  try {
    assert.equal(fixture.bootstrap(SPEC).status, 0);
    await doc("02", "discover-legacy", "Discover legacy");
    await author("inventories/legacy.json", { ...LEGACY_INVENTORY, hasVisibleUi: false, uiBehaviors: [] });
    await author("inventories/module-classification.json", await classificationFor(legacy));
    await runTo("DISCOVERY_COMPLETENESS");
    await doc("02a", "discovery-completeness", "Discovery completeness");
    await runTo("ASSESS_TARGET");
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
          legacyEvidence: ["legacy/auth/marker.txt"], targetEvidence: [], consumers: ["auth"], targetOwner: "src/features/auth",
          replacedBy: [], rationale: "Only auth consumes it." }] },
    });
    for (const [relative, value] of Object.entries(matrices(false))) await author(relative, value);
    assert.equal(call("registry", ["auth", "--target", "auth", "--mode", "auto"]).status, 0);
    await runTo("PLAN");
    await doc("05", "plan", "Plan");
    const slices = [
      { id: "slice-a", requirementIds: ["AUTH-REQ-001"], scenarioIds: ["AUTH-SCN-001"], traceIds: ["BR-1", "RR-1"],
        capabilityIds: ["CAP-1"], architectureAuthorities: [], targetPaths: ["src"], dependencies: [], acceptanceScenarios: ["Sign in"],
        changedFiles: ["src/features/auth/session.js", "src/features/auth/token-format.js", "src/features/auth/index.js"] },
      { id: "slice-b", requirementIds: ["AUTH-REQ-002"], scenarioIds: ["AUTH-SCN-002"], traceIds: ["NR-1"],
        capabilityIds: [], architectureAuthorities: [], targetPaths: ["src"], dependencies: [], acceptanceScenarios: ["Sign out"],
        changedFiles: ["src/features/auth/sign-out.js"] },
    ];
    await author("slices/index.json", { version: 1, slices: slices.map(({ changedFiles, ...slice }) => slice) });
    await runTo("IMPLEMENT_SLICES");
    await doc("06", "implement-slices", "Implement slices");
    await doc("07", "verify-slices", "Verify slices");
    for (const slice of slices) {
      for (const file of slice.changedFiles) await writeTarget(file, file.endsWith("session.js") ? SESSION_D1 : TARGET[file]);
      await author(`slices/${slice.id}.json`, { id: slice.id, implementationStatus: "COMPLETE", requirementIds: slice.requirementIds,
        scenarioIds: slice.scenarioIds, traceIds: slice.traceIds, capabilityIds: slice.capabilityIds, changedFiles: slice.changedFiles,
        decisions: ["Implemented in the target architecture."], checks: ["typecheck"] });
      await runTo("VERIFY_SLICES");
      // The agent's own tests call its own signature, so they pass.
      const output = `TAP version 13\nok 1 - ${slice.acceptanceScenarios[0]}\n`;
      const file = path.join(record, `evidence/${slice.id}/commands/test.txt`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, output);
      await author(`evidence/${slice.id}/result.json`, { sliceId: slice.id, result: "PASS", requirementIds: slice.requirementIds,
        scenarioIds: slice.scenarioIds, capabilityIds: slice.capabilityIds, traceIds: slice.traceIds,
        commands: [{ command: "node --test", exitCode: 0, executedAt: new Date().toISOString(), runner,
          outputPath: path.relative(target, file).replaceAll(path.sep, "/"), outputDigest: sha(output) }],
        scenarios: slice.acceptanceScenarios, uiEvidence: [], uiEvidenceLimitations: [], residualRisks: [] });
      await runTo(slice.id === "slice-a" ? "IMPLEMENT_SLICES" : "FINALIZE");
    }
    // VERIFY_SLICES recorded the bytes each slice verified.
    const verified = (await readFile(path.join(record, HISTORY_FILE), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      .filter((event) => event.step === "VERIFY_SLICES");
    assert.deepEqual(verified.map((event) => Object.keys(event.verifiedFiles)), [
      ["src/features/auth/index.js", "src/features/auth/session.js", "src/features/auth/token-format.js"],
      ["src/features/auth/sign-out.js"],
    ]);
    assert.equal(verified[0].verifiedFiles["src/features/auth/session.js"], await fileIdentity(path.join(target, "src/features/auth/session.js")));

    await doc("08", "finalize", "Finalize");
    for (const [relative, value] of Object.entries(matrices(true))) await author(relative, value);
    const state = await json(path.join(record, "state.json"));
    const revision = async (root) => (await exec("git", ["-C", root, "log", "-1", "--format=%H", "--", "."])).stdout.trim();
    const finalRun = path.join(record, "evidence/final/full-suite.txt");
    const finalReference = path.relative(target, finalRun).replaceAll(path.sep, "/");
    // Bound to both trees as they are now; FINAL_VERIFY cites the recorded final run.
    const gates = async () => {
      const boundTo = { target: "auth", legacyRevision: await revision(legacy), targetRevision: await revision(target),
        requirementsDigest: state.requirementsAuthority.digest, dataSourceMode: "standard",
        legacyDirtyDigest: (await dirtyManifest(legacy)).digest, targetDirtyDigest: (await dirtyManifest(target, TARGET_DIRTY_SCOPE)).digest };
      const entry = { producedAt: new Date().toISOString(), producer: "export-contract-test", environment: runner, boundTo };
      const hash = await fileIdentity(finalRun);
      await author("gates.json", { version: 1, gates: ["ARCHITECTURE_PLAN_GATE", "TARGETED_VERIFY", "FUNCTIONAL_PARITY_GATE", "SIMPLIFY_ONCE",
        "ARCHITECTURE_IMPLEMENTATION_GATE", "PRECOMMIT_GATE", "FINAL_VERIFY"].map((gate) => ({ gate, result: "PASS", attempts: 1,
        evidence: [gate === "FINAL_VERIFY"
          ? { kind: "test", reference: finalReference, hash, ...entry }
          : { kind: "command", reference: "node --test", hash: sha("node --test"), ...entry }] })) });
    };
    // Modification times are set explicitly: freshness reads them, so the test must not race the clock.
    const age = (file, secondsAgo) => utimes(file, Date.now() / 1000 - secondsAgo, Date.now() / 1000 - secondsAgo);
    await mkdir(path.dirname(finalRun), { recursive: true });
    await writeFile(finalRun, "TAP version 13\nok 1 - Sign in\nok 2 - Sign out\n");
    await age(finalRun, 120);
    await gates();

    // 1. Every gate passes over the D1 target; the engine derives the call contract itself.
    const changed = await runTo("FINALIZE");
    assert.equal(changed.outcome, "CONTINUE", JSON.stringify(changed));
    assert.match(changed.reason, /^EXPORT_CONTRACT_INCOMPATIBLE: /);
    assert.match(changed.reason, /\(1\) legacy auth\/index\.js export 'describeSession\(session\)' is not exported by src\/features\/auth\/index\.js\./);
    assert.match(changed.reason, /\(2\) legacy auth\/index\.js export 'signIn\(user, options\)' reads 'options\.now' from argument 2 \('options'\); target 'signIn\(user, now\)' never reads that key from its argument 2 \('now'\)/);
    // `issueToken` moved file but kept its contract in the feature index; the test-only export sets nothing.
    assert.doesNotMatch(changed.reason, /issueToken|resetForTests/);
    const validated = call("validate", ["auth", "--complete"]);
    assert.notEqual(validated.status, 0);
    assert.match(validated.stdout + validated.stderr, /EXPORT_CONTRACT_INCOMPATIBLE/);

    // 2. The fix changes source VERIFY_SLICES verified; the final run predates it.
    await writeTarget("src/features/auth/session.js", SESSION_KEPT);
    await writeTarget("src/features/auth/index.js", INDEX_KEPT);
    for (const file of ["session.js", "index.js"]) await age(path.join(target, "src/features/auth", file), 60);
    await gates();
    const stale = await runTo("FINALIZE");
    assert.match(stale.reason, /^STALE_VERIFICATION_EVIDENCE: 'src\/features\/auth\/index\.js' \(verified by slice-a\), 'src\/features\/auth\/session\.js' \(verified by slice-a\) changed after VERIFY_SLICES verified them, and no FINAL_VERIFY evidence file was written after the change/);

    // 3. Verification re-run against the current bytes and recorded as FINAL_VERIFY evidence.
    await writeFile(finalRun, "TAP version 13\nok 1 - Sign in\nok 2 - Sign out\nok 3 - Sign in with the legacy options bag\n");
    await gates();
    assert.equal((await runTo("COMPLETE")).outcome, "COMPLETE");
    const complete = call("validate", ["auth", "--complete"]);
    assert.equal(complete.status, 0, complete.stdout + complete.stderr);
  } finally {
    await fixture.cleanup();
  }
});
