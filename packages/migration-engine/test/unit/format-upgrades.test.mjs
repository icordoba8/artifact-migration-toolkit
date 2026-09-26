/**
 * The format-upgrade primitives: registry coverage, the cursor, and the per-row
 * domain classification. Pure inputs only -- no fixture, no filesystem, no
 * lock. The record-level proofs (the NO_OP transaction, its crash recovery and
 * replay, and the pre-floor protection) live beside the fixture machinery in
 * `migration-contract.test.mjs`; a second copy of that fixture here would be
 * more test harness than test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRegistryCoverage,
  classifyUpgrade,
  nextIncrement,
  upgradeIsActive,
  upgradeProjection,
} from "../../src/format-upgrade.mjs";
import {
  FORMAT_UPGRADE_FLOOR,
  FORMAT_UPGRADERS,
  MIGRATION_FORMAT_VERSION,
  NON_PROMOTING_FORMAT_VERSIONS,
  REQUIRED_OBSERVATIONS_FORMAT,
  VISUAL_ACCEPTANCE_FORMAT,
  formatIsPromoting,
  renderLoopDirective,
} from "../../src/resumable-migration.mjs";
import {
  ARTIFACT_FORMAT_UPGRADE_FLOOR,
  ARTIFACT_FORMAT_UPGRADERS,
  ARTIFACT_FORMAT_VERSION,
  artifactFormatUpgrade,
} from "../../src/artifact/artifact-migration.mjs";
import { supportedMigrationVersions } from "../../../../scripts/release.mjs";

/** A structurally valid row; the tests bend exactly one field at a time. */
const row = (from, overrides = {}) => ({
  from,
  to: from + 1,
  id: `ROW_${from}`,
  version: 1,
  requiredInput: null,
  activation: null,
  domain: () => "NO_OP",
  plan: () => ({ blockers: [] }),
  commit: () => ({ changed: true }),
  ...overrides,
});

/** A structurally valid activation descriptor; bent one field at a time below. */
const activation = (overrides = {}) => ({
  predicate: (state) => Boolean(state?.pinned),
  prerequisite: {
    kind: "pinnedArtifact",
    path: "inventories/legacy.json",
    description: "the pinned authority",
  },
  ...overrides,
});

const coverage = (registry, { floor = 17, runtimeFormat = 18 } = {}) => () =>
  assertRegistryCoverage({ floor, runtimeFormat, registry });

// --- registry coverage ------------------------------------------------------

test("the shipped module registry covers every increment from the floor", () => {
  assert.equal(FORMAT_UPGRADE_FLOOR, VISUAL_ACCEPTANCE_FORMAT);
  assert.deepEqual(
    FORMAT_UPGRADERS.map(({ from, to, id, version }) => ({ from, to, id, version })),
    [
      {
        from: VISUAL_ACCEPTANCE_FORMAT,
        to: REQUIRED_OBSERVATIONS_FORMAT,
        id: "UI_OBSERVATIONS_ADOPTED",
        version: 1,
      },
    ],
  );
  assert.doesNotThrow(
    coverage(FORMAT_UPGRADERS, {
      floor: FORMAT_UPGRADE_FLOOR,
      runtimeFormat: MIGRATION_FORMAT_VERSION,
    }),
  );
});

test("coverage refuses a missing, gapped, jumping or duplicated registry", () => {
  // The bump that ships without its upgrader: runtime 19, no 18 -> 19 row.
  assert.throws(
    coverage([row(17)], { runtimeFormat: 19 }),
    /no registered upgrader for 18 -> 19/,
  );
  assert.throws(
    coverage([row(17), row(19)], { runtimeFormat: 20 }),
    /no registered upgrader for 18 -> 19/,
  );
  assert.throws(
    coverage([{ ...row(17), to: 19 }], { runtimeFormat: 19 }),
    /is not adjacent/,
  );
  assert.throws(
    coverage([row(17), { ...row(17), id: "SECOND" }]),
    /two rows upgrade from format 17/,
  );
  assert.throws(coverage([row(16)], { runtimeFormat: 18 }), /below the upgrade floor 17/);
  assert.throws(coverage([row(17), row(18)]), /above the runtime format 18/);
  assert.throws(coverage([{ ...row(17), commit: null }]), /callable commit/);
  assert.throws(
    coverage([{ ...row(17), requiredInput: undefined }]),
    /must declare requiredInput/,
  );
  assert.throws(
    coverage([], { floor: 19, runtimeFormat: 18 }),
    /floor 19 is above the runtime format 18/,
  );
  // A record at the floor with nothing above it owes nothing, so an empty
  // registry is complete -- which is what the artifact engine ships with.
  assert.doesNotThrow(coverage([], { floor: 13, runtimeFormat: 13 }));
});

test("coverage requires an explicitly declared, well-formed activation", () => {
  // Undefined is not "active immediately" -- that has to be said out loud, so a
  // new row cannot inherit exclusivity by omission.
  assert.throws(
    coverage([{ ...row(17), activation: undefined }]),
    /must declare activation, explicitly null/,
  );
  for (const bad of [true, 0, "pinned", []]) {
    assert.throws(
      coverage([{ ...row(17), activation: bad }]),
      /activation as null or as an object with a callable predicate/,
      JSON.stringify(bad),
    );
  }
  assert.throws(
    coverage([{ ...row(17), activation: activation({ predicate: undefined }) }]),
    /callable predicate/,
  );
  assert.throws(
    coverage([{ ...row(17), activation: activation({ predicate: "yes" }) }]),
    /callable predicate/,
  );
  for (const prerequisite of [
    undefined,
    null,
    "inventories/legacy.json",
    { path: "inventories/legacy.json", description: "d" },
    { kind: "pinnedArtifact", description: "d" },
    { kind: "pinnedArtifact", path: "inventories/legacy.json" },
    { kind: "", path: "inventories/legacy.json", description: "d" },
    { kind: "pinnedArtifact", path: "inventories/legacy.json", description: 1 },
  ]) {
    assert.throws(
      coverage([{ ...row(17), activation: activation({ prerequisite }) }]),
      /activation\.prerequisite with a non-empty kind, path and description/,
      JSON.stringify(prerequisite),
    );
  }
  // Both legal forms, and the shipped row is one of them.
  assert.doesNotThrow(coverage([{ ...row(17), activation: null }]));
  assert.doesNotThrow(coverage([{ ...row(17), activation: activation() }]));
  assert.doesNotThrow(
    coverage(FORMAT_UPGRADERS, {
      floor: FORMAT_UPGRADE_FLOOR,
      runtimeFormat: MIGRATION_FORMAT_VERSION,
    }),
  );
});

test("upgradeIsActive is fail-closed, and pure over persisted state", () => {
  // A missing registry row must never become the excuse to keep running the
  // lifecycle at the old format.
  assert.equal(upgradeIsActive(null, {}), true);
  assert.equal(upgradeIsActive(undefined, {}), true);
  // Nor may a row the release gate would have refused.
  for (const bad of [undefined, true, 0, {}, { predicate: "yes" }]) {
    assert.equal(upgradeIsActive({ ...row(17), activation: bad }, {}), true, JSON.stringify(bad));
  }
  // `null` means active the moment the increment is owed.
  assert.equal(upgradeIsActive(row(17), {}), true);
  // And a declared predicate decides, from persisted state alone.
  const gated = { ...row(17), activation: activation() };
  assert.equal(upgradeIsActive(gated, {}), false);
  assert.equal(upgradeIsActive(gated, { pinned: false }), false);
  assert.equal(upgradeIsActive(gated, { pinned: "sha256:..." }), true);
});

test("the shipped 17 -> 18 activation reads the pin, never the file", () => {
  const [seventeen] = FORMAT_UPGRADERS;
  assert.deepEqual(seventeen.activation.prerequisite, {
    kind: "pinnedArtifact",
    path: "inventories/legacy.json",
    description:
      "the validated and pinned authoritative legacy inventory produced by DISCOVER_LEGACY",
  });
  // A newborn record: the scaffold exists on disk, but nothing has pinned it.
  assert.equal(upgradeIsActive(seventeen, { formatVersion: 17, artifactHashes: {} }), false);
  assert.equal(upgradeIsActive(seventeen, { formatVersion: 17 }), false);
  assert.equal(upgradeIsActive(seventeen, {}), false);
  // The successful DISCOVER_LEGACY advance is the boundary, and its pin is the
  // whole of the signal: `hasVisibleUi` is never consulted here.
  assert.equal(
    upgradeIsActive(seventeen, {
      formatVersion: 17,
      hasVisibleUi: false,
      artifactHashes: { "inventories/legacy.json": "deadbeef" },
    }),
    true,
  );
});

test("no declaration elsewhere buys a missing upgrader a pass", () => {
  // Coverage reads {floor, runtimeFormat, registry} and nothing else, so a
  // future format declared self-healing, promoting or non-promoting still
  // fails without its row -- and `formatIsPromoting` refuses it a second time.
  const selfHealing = new Set([19]);
  const featureDeclared = [[19, () => true]];
  assert.ok(selfHealing.has(19) && featureDeclared.length === 1);
  assert.throws(
    coverage([row(17)], { runtimeFormat: 19 }),
    /no registered upgrader for 18 -> 19/,
  );
  assert.equal(formatIsPromoting(19), false, "above the floor, only the registry promotes");
  assert.equal(formatIsPromoting(18), false);
  assert.ok(NON_PROMOTING_FORMAT_VERSIONS.includes(17));
  // Below the floor the promotion table is exactly what it always was.
  for (const version of [12, 13, 14, 15, 16]) {
    assert.equal(formatIsPromoting(version), true, `format ${version} still promotes`);
  }
  for (const version of [10, 11]) assert.equal(formatIsPromoting(version), false);
});

// --- the cursor -------------------------------------------------------------

test("the cursor resolves exactly the next adjacent increment, or none", () => {
  const registry = [row(17), row(18), row(19)];
  assert.deepEqual(nextIncrement(registry, 17, 20, 17), {
    from: 17,
    to: 18,
    row: registry[0],
  });
  // Record 17 / runtime 20 never jumps: each invocation moves one step, and the
  // step is chosen by the cursor alone.
  assert.deepEqual(
    [17, 18, 19].map((from) => {
      const increment = nextIncrement(registry, from, 20, 17);
      return [increment.from, increment.to];
    }),
    [
      [17, 18],
      [18, 19],
      [19, 20],
    ],
  );
  assert.equal(nextIncrement(registry, 20, 20, 17), null, "caught up owes nothing");
  assert.equal(nextIncrement([row(17)], 18, 18, 17), null);
  assert.equal(nextIncrement([row(17)], 16, 18, 17), null, "pre-floor owes nothing here");
  assert.equal(nextIncrement([row(17)], 10, 18, 17), null);
  assert.equal(nextIncrement([row(17)], 11, 18, 17), null);
  // A missing row is reported, never skipped: the caller fails closed on it.
  assert.deepEqual(nextIncrement([row(17)], 18, 19, 17), { from: 18, to: 19, row: null });
});

test("record 17 / runtime 20 takes one increment per invocation, driven by the loop", () => {
  const registry = [row(17), row(18), row(19)];
  // One invocation: resolve the cursor, commit at most that one step, end. The
  // directive is what the outer driver acts on, so it is read here and nowhere
  // else decides whether another invocation happens.
  const invocation = (formatVersion) => {
    const increment = nextIncrement(registry, formatVersion, 20, 17);
    return increment === null
      ? { formatVersion, directive: renderLoopDirective({ moduleName: "auth", outcome: "CONTINUE" }) }
      : {
          formatVersion: increment.to,
          directive: renderLoopDirective({ moduleName: "auth", outcome: "FORMAT_UPGRADED" }),
        };
  };

  let formatVersion = 17;
  const trace = [];
  for (let invocations = 0; invocations < 4; invocations += 1) {
    const from = formatVersion;
    const step = invocation(formatVersion);
    formatVersion = step.formatVersion;
    trace.push([from, formatVersion, step.directive]);
  }
  // Every line the driver reads names the same normal iteration command: the
  // next invocation is an ordinary run that re-resolves the cursor, so there is
  // nothing format-specific for the driver to interpret.
  const next = "loop: CONTINUE next=/start-migration auth\n";
  assert.deepEqual(trace, [
    [17, 18, next],
    [18, 19, next],
    [19, 20, next],
    // Caught up: the fourth invocation owes no increment and the lifecycle is
    // the loop's target again.
    [20, 20, next],
  ]);
});

// --- classification ---------------------------------------------------------

test("classifyUpgrade is total over the three pending results", () => {
  assert.deepEqual(classifyUpgrade({ domain: "NO_OP", inputPresent: false }), {
    state: "READY",
    blockers: [],
  });
  assert.deepEqual(classifyUpgrade({ domain: "TRANSFORM", inputPresent: false }), {
    state: "NEEDS_INPUT",
    blockers: [],
  });
  assert.deepEqual(
    classifyUpgrade({
      domain: "TRANSFORM",
      inputPresent: true,
      plan: { blockers: ["refused"] },
    }),
    { state: "BLOCKED", blockers: ["refused"] },
  );
  assert.deepEqual(
    classifyUpgrade({ domain: "TRANSFORM", inputPresent: true, plan: { blockers: [] } }),
    { state: "READY", blockers: [] },
  );
});

test("the 17 -> 18 row declares its input and classifies from record authority", async () => {
  const [seventeen] = FORMAT_UPGRADERS;
  assert.equal(seventeen.requiredInput.kind, "candidateFile");
  assert.equal(seventeen.requiredInput.authority, "legacy");
  // The classifier reads the record's validated legacy inventory, not a handed
  // object, so no authority means no classification -- it throws, and
  // `pendingFormatUpgrade` turns that into BLOCKED. The TRANSFORM/NO_OP/BLOCKED
  // branches themselves are proved on real records in FU-2 and FU-6.
  await assert.rejects(
    seventeen.domain({ formatVersion: 17 }, { root: "/nonexistent", roots: {} }),
  );
});

test("upgradeProjection carries the contract and none of the internals", () => {
  assert.equal(upgradeProjection(null), null);
  const projection = upgradeProjection({
    from: 17,
    to: 18,
    upgrader: { id: "UI_OBSERVATIONS_ADOPTED", version: 1 },
    state: "NEEDS_INPUT",
    domain: "TRANSFORM",
    requiredInput: { kind: "candidateFile" },
    blockers: [],
    nextAction: "Author it.",
    candidateBytes: Buffer.from("secret"),
  });
  assert.deepEqual(Object.keys(projection).sort(), [
    "active",
    "blockers",
    "confirmationDigest",
    "domain",
    "from",
    "nextAction",
    "prerequisite",
    "recordFormat",
    "requiredInput",
    "runtimeFormat",
    "state",
    "to",
    "upgrader",
  ]);
  assert.equal(projection.confirmationDigest, null);
  // An increment is exclusive unless it says otherwise, so a producer that does
  // not mention activation is projected as the frozen case.
  assert.equal(projection.active, true);
  assert.equal(projection.prerequisite, null);
  const inactive = upgradeProjection({
    from: 17,
    to: 18,
    state: "INACTIVE",
    active: false,
    domain: null,
    prerequisite: { kind: "pinnedArtifact", path: "inventories/legacy.json", description: "d" },
    nextAction: "Keep going.",
  });
  assert.equal(inactive.active, false);
  assert.equal(inactive.prerequisite.kind, "pinnedArtifact");
  // How far behind the record is, beside what the next step is.
  assert.equal(projection.recordFormat, 17);
  assert.equal(projection.runtimeFormat, 18);
  assert.ok(Object.isFrozen(projection));
});

// --- the artifact engine's adapter, and the release gate over both ----------

test("the artifact engine declares a floor at its runtime format and owes nothing", () => {
  // The floor is the current runtime format, so the empty registry is complete,
  // not unfinished: there is no adjacent increment to register yet, and a
  // historical 12 -> 13 upgrader would claim a path never walked.
  assert.equal(ARTIFACT_FORMAT_UPGRADE_FLOOR, ARTIFACT_FORMAT_VERSION);
  assert.deepEqual(ARTIFACT_FORMAT_UPGRADERS, []);
  assert.doesNotThrow(
    coverage(ARTIFACT_FORMAT_UPGRADERS, {
      floor: ARTIFACT_FORMAT_UPGRADE_FLOOR,
      runtimeFormat: ARTIFACT_FORMAT_VERSION,
    }),
  );
  // No format is both at or above the floor and behind the runtime, so the
  // cursor answers null for every input -- including the pre-floor format an
  // artifact record can be persisted at, which must not become pending work.
  for (const formatVersion of [11, 12, 13, 14, undefined]) {
    assert.equal(artifactFormatUpgrade({ formatVersion }), null, `format ${formatVersion}`);
  }
  assert.equal(artifactFormatUpgrade(null), null);
});

test("a future artifact bump cannot ship without its adjacent upgrader", () => {
  assert.throws(
    coverage([], { floor: 13, runtimeFormat: 14 }),
    /no registered upgrader for 13 -> 14/,
  );
  assert.doesNotThrow(coverage([row(13)], { floor: 13, runtimeFormat: 14 }));
});

test("the release gate runs for both engines and the manifest states both registries", async () => {
  // Exactly what `--build` calls: the gate throws before a manifest can
  // advertise a format nothing in the bundle can upgrade into.
  const supports = await supportedMigrationVersions();
  assert.equal(supports.formatUpgradeFloor, FORMAT_UPGRADE_FLOOR);
  assert.deepEqual(supports.formatUpgraders, [
    { from: 17, to: 18, id: "UI_OBSERVATIONS_ADOPTED", version: 1 },
  ]);
  assert.equal(supports.artifactFormatUpgradeFloor, 13);
  assert.deepEqual(supports.artifactFormatUpgraders, []);
  // Identity only: no domain classifier, plan, commit or record path. A JSON
  // round trip is the manifest's own serialization, so anything that would be
  // dropped or rendered as null shows up here.
  assert.deepEqual(JSON.parse(JSON.stringify(supports)), supports);
});
