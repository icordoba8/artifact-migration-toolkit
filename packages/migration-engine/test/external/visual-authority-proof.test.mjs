// Slice D -- the scripted visual-authority proof, against the *installed*
// release bundle.
//
// Every command below runs the staged release as a child process from a scratch
// consumer, in the shape of `format-17-acceptance.test.mjs`
// (`buildRelease` -> `candidateReleaseRoot` -> `run`). Nothing imports the
// checkout to drive a lifecycle, because an in-process import would be proving
// the checkout rather than the installation.
//
// Two lifecycles reach COMPLETE -- `legacy-runtime` and `figma-mcp` -- through
// the one shared Slice A/B/C pipeline. Between the checkpoints, each
// plan-required divergence, omission and substitution is injected on its own,
// asserted against its own refusal identifier, and then rolled back: a refused
// advance is atomic, so one consumer proves every injection without a check
// masking its neighbour.
//
// What this does NOT establish: these fixtures are authored to fit the
// implementation. The thresholds stay provisional and the recorded diffRatios
// are calibration *inputs* for Track B, never a certification.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { buildRelease } from "../../../../scripts/release.mjs";
import { candidateReleaseRoot } from "../support/candidate-release-root.mjs";
import {
  createUnstampedRecord,
  LEGACY_INVENTORY,
  MODULE_CLASSIFICATION,
} from "../support/consumer-fixture.mjs";
import {
  AUTHORITY_CONTROLS,
  COMPARE,
  FIGMA_AUTHORITY_DIR,
  FIGMA_CONTEXT_FILE,
  FIGMA_DESIGN_CONTEXT,
  FIGMA_KEY,
  FIGMA_NODE,
  FIGMA_URL,
  FIGMA_VARIABLES,
  figmaFacts,
  figmaMetadata,
  GATES,
  LEGACY_AUTHORITY_DIR,
  LEGACY_CONTEXT_FILE,
  LEGACY_FRAME_ID,
  matrices,
  MEASURED,
  NATIVE_EXTRA,
  sha256,
  SHARED_RENDER,
  SLICES,
  STEP_DOCS,
  TARGET_CAPTURE,
  TARGET_INVENTORY,
  targetControls,
  taxonomyExpect,
  VIEWPORT,
  visualPng,
} from "../support/visual-fixtures.mjs";

const execFileAsync = promisify(execFile);

const scratch = await mkdtemp(path.join(os.tmpdir(), "amt-visual-proof-"));
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
    }));
  return bundlePromise;
};

const run = async (toolkit, script, args, cwd) => {
  const result = await execFileAsync(
    process.execPath,
    [path.join(toolkit.engine, "src", script), ...args],
    { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  ).catch((error) => error);
  return { output: `${result.stdout ?? ""}${result.stderr ?? ""}`, code: result.code ?? 0 };
};

const confirmationIdIn = (output) => output.match(/Confirmation ID: ([0-9a-f]+)/)?.[1];

/** A confirmed checkpoint advance, driven entirely through the installed CLI. */
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

/* ------------------------------------------------------------------ *
 * Calibration evidence
 *
 * Every comparison this suite provokes is recorded once, matching pairs and
 * injected divergences alike, so Track B only has to read the numbers. Slice D
 * does not turn them into certified thresholds: the fixtures are synthetic.
 * ------------------------------------------------------------------ */
const calibration = [];
const record = (row) => calibration.push(row);

after(() => {
  const header = "| scenario | authority | diffPixels | diffRatio | threshold | verdict |";
  const table = [
    "",
    "PROVISIONAL visual calibration evidence (synthetic fixtures, Slice D).",
    "Not a certified threshold: see the reduced plan section 6.",
    "",
    header,
    "| --- | --- | --- | --- | --- | --- |",
    ...calibration
      .slice()
      .sort((a, b) => `${a.authority}${a.scenario}`.localeCompare(`${b.authority}${b.scenario}`))
      .map((row) =>
        `| ${row.scenario} | ${row.authority} | ${row.diffPixels} | ${row.diffRatio} | ${row.threshold} | ${row.verdict} |`,
      ),
    "",
  ].join("\n");
  process.stdout.write(`${table}\n`);
  const out = process.env.AMT_VISUAL_CALIBRATION_OUT;
  return out ? writeFile(out, `${table}\n`) : undefined;
});

/* ------------------------------------------------------------------ *
 * One consumer, driven by the installation
 * ------------------------------------------------------------------ */

const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/**
 * A scratch consumer holding one adopted, unstamped record at the requested
 * design source, plus the authoring helpers every checkpoint needs.
 */
const openConsumer = async (t, toolkit, authority) => {
  const consumer = await createUnstampedRecord({
    prefix: `amt visual ${authority} `,
    designSource: authority,
    figma: authority === "figma-mcp" ? [FIGMA_URL] : undefined,
  });
  t.after(() => consumer.cleanup());
  // The seed is written by the checkout, which is unidentified in one engine
  // pass and fixture-stamped in the other. `adopt` is for the first shape and
  // `update` for the second; which one applies is a property of the pass, not
  // of this suite's subject.
  const claim = (await consumer.snapshot()).state.toolkitIdentity ? "update" : "adopt";
  const stamped = await run(
    toolkit,
    "cli/toolkit-identity.mjs",
    [claim, "--module", "auth"],
    consumer.root,
  );
  assert.equal(stamped.code, 0, stamped.output);

  const at = (relative) => path.join(consumer.recordRoot, relative);
  /** Bytes inside the record; the reference is the record-relative path the
   * authority context cites. */
  const persist = async (relative, bytes) => {
    await mkdir(path.dirname(at(relative)), { recursive: true });
    await writeFile(at(relative), bytes);
    return { reference: relative, hash: sha256(bytes) };
  };
  /** The same, as a TARGET evidence citation: relative to the target root. */
  const persistEvidence = async (relative, bytes) => {
    const written = await persist(relative, bytes);
    return {
      reference: path
        .relative(consumer.targetRoot, at(relative))
        .replaceAll(path.sep, "/"),
      hash: written.hash,
    };
  };
  const put = (relative, value) => persist(relative, jsonBytes(value));
  const read = async (relative) => JSON.parse(await readFile(at(relative), "utf8"));
  const doc = (step) => {
    const [number, file, name] = STEP_DOCS[step];
    return persist(
      `steps/${number}-${file}.md`,
      Buffer.from(`# ${number}. ${name}\n\n- Status: \`COMPLETE\`\n\n## Result\n\nAuthored by the Slice D proof.\n`),
    );
  };
  const step = async () => (await consumer.snapshot()).state.currentStep;
  const go = async (extra = []) => {
    const result = await advance(toolkit, consumer.root, extra);
    assert.equal(result.code, 0, result.output);
    return result;
  };
  /**
   * The injection primitive: author something divergent, prove the installed
   * engine refuses it by its own identifier, prove the refusal wrote nothing,
   * and roll the authored bytes back.
   */
  const refuses = async (label, pattern, mutate, extra = []) => {
    const before = await consumer.snapshot();
    const restore = await mutate();
    const attempt = await advance(toolkit, consumer.root, extra);
    assert.notEqual(attempt.code, 0, `${label} was accepted:\n${attempt.output}`);
    assert.match(attempt.output, pattern, label);
    assert.deepEqual(await consumer.snapshot(), before, `${label} wrote to the record`);
    await restore();
    return attempt.output;
  };
  return { ...consumer, at, persist, persistEvidence, put, read, doc, step, go, refuses };
};

/** Restores a file's exact prior bytes -- the rollback half of `refuses`. */
const rollback = async (consumer, relative) => {
  const before = await readFile(consumer.at(relative));
  return () => writeFile(consumer.at(relative), before);
};

/* ------------------------------------------------------------------ *
 * Authority contexts
 * ------------------------------------------------------------------ */

const legacyFrame = async (consumer) => {
  const state = (await consumer.snapshot()).state;
  return {
    id: LEGACY_FRAME_ID,
    uiBehaviorId: "UIB-1",
    state: "DEFAULT",
    states: ["DEFAULT"],
    viewport: VIEWPORT,
    url: "http://localhost/auth/sign-in",
    rootLocator: "getByRole('main')",
    legacyRevision: state.legacyRevision.revision,
    capturedAt: "2026-09-29T00:00:00.000Z",
    capture: { ...TARGET_CAPTURE, role: "LEGACY_AUTHORITY" },
    extraction: {
      retrievedAt: "2026-09-29T00:00:00.000Z",
      fidelity: "COMPLETE",
      limitations: [],
    },
    sources: {
      snapshot: await consumer.persist(
        `${LEGACY_AUTHORITY_DIR}/snapshot.json`,
        jsonBytes({
          proofFormat: "playwright-ui-proof/v1",
          observation: {
            url: "http://localhost/auth/sign-in",
            controls: AUTHORITY_CONTROLS,
          },
        }),
      ),
      screenshot: await consumer.persist(`${LEGACY_AUTHORITY_DIR}/screenshot.png`, SHARED_RENDER),
      measurements: await consumer.persist(
        `${LEGACY_AUTHORITY_DIR}/observations.json`,
        jsonBytes({ viewport: VIEWPORT, values: MEASURED }),
      ),
    },
  };
};

const figmaFrame = async (consumer) => ({
  fileKey: FIGMA_KEY,
  nodeId: FIGMA_NODE,
  name: "Sign in",
  type: "FRAME",
  viewport: VIEWPORT,
  states: ["default"],
  rootLocator: "getByRole('main')",
  capture: {
    ...TARGET_CAPTURE,
    role: "FIGMA_AUTHORITY",
    imageWidth: COMPARE.width * 2,
    imageHeight: COMPARE.height * 2,
  },
  extraction: {
    retrievedAt: "2026-09-29T00:00:00.000Z",
    fidelity: "COMPLETE",
    limitations: [],
  },
  sources: {
    metadata: await consumer.persist(
      `${FIGMA_AUTHORITY_DIR}/metadata.xml`,
      Buffer.from(figmaMetadata()),
    ),
    designContext: [
      {
        ...(await consumer.persist(
          `${FIGMA_AUTHORITY_DIR}/design-context.txt`,
          Buffer.from(FIGMA_DESIGN_CONTEXT),
        )),
        nodeId: FIGMA_NODE,
      },
    ],
    variableDefs: await consumer.persist(
      `${FIGMA_AUTHORITY_DIR}/variable-defs.json`,
      jsonBytes(FIGMA_VARIABLES),
    ),
    // A 2x design render: the one comparison raster box-downsamples it by
    // exactly 2, which is why both origins share one code path.
    screenshot: await consumer.persist(`${FIGMA_AUTHORITY_DIR}/screenshot.png`, visualPng(2)),
  },
  facts: figmaFacts(),
});

const AUTHORITIES = {
  "legacy-runtime": {
    contextFile: LEGACY_CONTEXT_FILE,
    digestField: "visualContextDigest",
    frame: legacyFrame,
    rowBinding: { legacyFrameId: LEGACY_FRAME_ID },
    recordBinding: { legacyFrameId: LEGACY_FRAME_ID },
  },
  "figma-mcp": {
    contextFile: FIGMA_CONTEXT_FILE,
    digestField: "figmaContextDigest",
    frame: figmaFrame,
    rowBinding: { figmaNodeId: FIGMA_NODE, figmaState: "default" },
    recordBinding: { figmaNodeId: FIGMA_NODE },
  },
};

const writeContext = async (consumer, authority) =>
  consumer.put(AUTHORITIES[authority].contextFile, {
    version: 2,
    frames: [await AUTHORITIES[authority].frame(consumer)],
  });

const contract = (authority, { expect, ...rest } = {}) => ({
  version: 2,
  rows: [
    {
      id: "VIS-1",
      uiBehaviorId: "UIB-1",
      state: "DEFAULT",
      ...AUTHORITIES[authority].rowBinding,
      viewport: VIEWPORT,
      expect: expect ?? taxonomyExpect(),
    },
  ],
  unbacked: [],
  ...rest,
});

/* ------------------------------------------------------------------ *
 * Slice evidence
 * ------------------------------------------------------------------ */

/** One extra observed control, in the proof document's own shape. */
const extraControl = (control) => ({
  ...control,
  state: "DEFAULT",
  present: true,
  assertions: [{ predicate: "presence", expected: true }],
});

const uiBehavior = LEGACY_INVENTORY.uiBehaviors[0];
const uiContractDigest = sha256(
  JSON.stringify({ uiBehavior, mismatch: TARGET_INVENTORY.uiMismatches[0] }),
);

const authorSlice = async (consumer, sliceId) => {
  const planned = SLICES.find((slice) => slice.id === sliceId);
  const changedFile = `src/${sliceId}.ts`;
  await writeFile(path.join(consumer.targetRoot, changedFile), "export {};\n");
  await consumer.put(`slices/${sliceId}.json`, {
    id: sliceId,
    implementationStatus: "COMPLETE",
    requirementIds: planned.requirementIds,
    scenarioIds: planned.scenarioIds,
    traceIds: planned.traceIds,
    capabilityIds: planned.capabilityIds,
    changedFiles: [changedFile],
    decisions: ["Implemented in the target architecture."],
    checks: ["typecheck"],
  });
};

/** The composition the engine accepts for a record bound to raw file hashes. */
const implementationDigest = async (consumer, sliceId) =>
  sha256(
    JSON.stringify([
      [
        `src/${sliceId}.ts`,
        createHash("sha256")
          .update(await readFile(path.join(consumer.targetRoot, `src/${sliceId}.ts`)))
          .digest("hex"),
      ],
    ]),
  );

/**
 * One slice's verification evidence. Every knob a Slice D injection turns is a
 * named option, so an injection bends exactly one thing and the rest of the
 * document stays the evidence a perfect migration would have produced.
 */
const authorEvidence = async (
  consumer,
  authority,
  sliceId,
  {
    values = MEASURED,
    render = SHARED_RENDER,
    controls = targetControls(),
    capture = TARGET_CAPTURE,
    digest,
  } = {},
) => {
  const planned = SLICES.find((slice) => slice.id === sliceId);
  const state = (await consumer.snapshot()).state;
  const withUi = sliceId === "slice-a";
  const output = "pnpm --dir target test\nall tests passed\n";
  const command = await consumer.persistEvidence(
    `evidence/${sliceId}/commands/test.txt`,
    Buffer.from(output),
  );
  const uiEvidence = [];
  if (withUi) {
    const proof = await consumer.persistEvidence(
      `evidence/${sliceId}/ui/proof.json`,
      jsonBytes({
        proofFormat: "playwright-ui-proof/v1",
        sliceId,
        uiBehaviorId: "UIB-1",
        state: "DEFAULT",
        traceId: "BR-1",
        scenarioIds: uiBehavior.scenarioIds,
        observation: { url: "http://localhost/auth/sign-in", controls },
        interactions: uiBehavior.interactions.map((interaction) => ({
          id: interaction.id,
          action: { type: "click", target: "button[name=Sign in]" },
          postAction: {
            url: "http://localhost/auth/sign-in",
            controls: [
              {
                role: "status",
                name: "Signed in",
                state: "SUBMITTED",
                present: true,
                assertions: [{ predicate: "presence", expected: true }],
              },
            ],
          },
        })),
      }),
    );
    uiEvidence.push({
      provider: "playwright",
      origin: "TARGET",
      producer: "slice-d-proof",
      environment: `node ${process.version}`,
      route: "/auth/sign-in",
      viewport: VIEWPORT,
      executedAt: "2026-09-29T00:00:00.000Z",
      result: "PASS",
      uiBehaviorId: "UIB-1",
      state: "DEFAULT",
      interactions: uiBehavior.interactions.map((interaction) => ({
        id: interaction.id,
        expected: interaction.expected,
        actual: interaction.expected,
        outcome: "PASS",
      })),
      reference: proof.reference,
      hash: proof.hash,
      ...AUTHORITIES[authority].recordBinding,
      capture,
      screenshot: await consumer.persistEvidence(
        `evidence/${sliceId}/ui/uib-1-default.png`,
        render,
      ),
      measurements: await consumer.persistEvidence(
        `evidence/${sliceId}/ui/observations.json`,
        jsonBytes({ viewport: VIEWPORT, values }),
      ),
      boundTo: {
        target: "auth",
        requirementsDigest: state.requirementsAuthority.digest,
        dataSourceMode: "standard",
        sliceId,
        implementationDigest: await implementationDigest(consumer, sliceId),
        uiContractDigest,
        [AUTHORITIES[authority].digestField]:
          digest ?? state.artifactHashes[AUTHORITIES[authority].contextFile],
      },
    });
  }
  await consumer.put(`evidence/${sliceId}/result.json`, {
    sliceId,
    result: "PASS",
    requirementIds: planned.requirementIds,
    scenarioIds: planned.scenarioIds,
    capabilityIds: planned.capabilityIds,
    traceIds: planned.traceIds,
    commands: [
      {
        command: "pnpm --dir target test",
        exitCode: 0,
        executedAt: "2026-09-29T00:00:00.000Z",
        runner: `node ${process.version}`,
        outputPath: command.reference,
        outputDigest: command.hash,
      },
    ],
    scenarios: planned.acceptanceScenarios,
    uiEvidence,
    uiEvidenceLimitations: [],
    residualRisks: [],
  });
};

const revisionOf = async (root) =>
  (await execFileAsync("git", ["-C", root, "log", "-1", "--format=%H", "--", "."], {
    encoding: "utf8",
  })).stdout.trim();

const authorGates = async (consumer, toolkit) => {
  const state = (await consumer.snapshot()).state;
  const utils = await import(
    pathToFileURL(path.join(toolkit.engine, "src/migration-utils.mjs")).href
  );
  const engine = await import(
    pathToFileURL(path.join(toolkit.engine, "src/resumable-migration.mjs")).href
  );
  const boundTo = {
    target: "auth",
    legacyRevision: await revisionOf(consumer.legacyRoot),
    targetRevision: await revisionOf(consumer.targetRoot),
    requirementsDigest: state.requirementsAuthority.digest,
    dataSourceMode: "standard",
    legacyDirtyDigest: (await utils.dirtyManifest(consumer.legacyRoot)).digest,
    targetDirtyDigest: (
      await utils.dirtyManifest(consumer.targetRoot, engine.TARGET_DIRTY_SCOPE)
    ).digest,
  };
  await consumer.put("gates.json", {
    version: 1,
    gates: GATES.map((gate) => ({
      gate,
      result: "PASS",
      attempts: 1,
      evidence: [
        {
          kind: "command",
          reference: "pnpm --dir target test",
          // Gate evidence must postdate the pins it claims to satisfy, so this
          // is the one timestamp in the suite that cannot be frozen.
          producedAt: new Date().toISOString(),
          producer: "slice-d-proof",
          environment: `node ${process.version}`,
          hash: `sha256:${"a".repeat(64)}`,
          boundTo,
        },
      ],
    })),
  });
};

const visualComparisonAt = async (consumer) => {
  const history = (await consumer.snapshot()).history;
  return history.findLast((event) => event.visualComparison)?.visualComparison;
};

/* ------------------------------------------------------------------ *
 * The two lifecycles
 * ------------------------------------------------------------------ */

const lifecycle = async (t, authority) => {
  const toolkit = await installedToolkit();
  const consumer = await openConsumer(t, toolkit, authority);
  const adapter = AUTHORITIES[authority];
  const digests = [];
  const roles = [];
  /** Resume after every checkpoint reports the same pin and the same role. */
  const checkpoint = async (expected) => {
    const state = (await consumer.snapshot()).state;
    assert.equal(state.currentStep, expected, `expected ${expected}`);
    assert.equal(state.designSource, authority);
    const status = await run(
      toolkit,
      "cli/discover-module.mjs",
      ["auth", "--status"],
      consumer.root,
    );
    assert.equal(status.code, 0, status.output);
    const pin = state.artifactHashes[adapter.contextFile];
    if (pin) {
      assert.match(status.output, new RegExp(adapter.contextFile.replaceAll("/", "\\/")));
      digests.push(pin);
      roles.push((await consumer.read(adapter.contextFile)).frames[0].capture.role);
    }
  };

  // --- DISCOVER_LEGACY -> ASSESS_TARGET ----------------------------------
  await consumer.authorDiscoverLegacy();
  await checkpoint("DISCOVER_LEGACY");
  await consumer.go();
  await consumer.doc("DISCOVERY_COMPLETENESS");
  await consumer.put("inventories/module-classification.json", MODULE_CLASSIFICATION);
  await checkpoint("DISCOVERY_COMPLETENESS");
  await consumer.go();

  // --- ASSESS_TARGET: the authority is pinned here, and only here ---------
  await consumer.doc("ASSESS_TARGET");
  await consumer.put("inventories/target.json", TARGET_INVENTORY);
  await writeContext(consumer, authority);
  await checkpoint("ASSESS_TARGET");

  // (e) The design source is bootstrap-fixed: a resume naming another refuses.
  const other = authority === "figma-mcp" ? "legacy-runtime" : "figma-mcp";
  const switched = await run(
    toolkit,
    "cli/discover-module.mjs",
    [
      "auth",
      "--design-source",
      other,
      // A well-formed request for the other source, so the refusal is the
      // design-source pin rather than an argument-shape complaint.
      ...(other === "figma-mcp" ? ["--figma", FIGMA_URL] : []),
      "--mode",
      "step",
    ],
    consumer.root,
  );
  assert.notEqual(switched.code, 0, switched.output);
  assert.match(switched.output, /conflicts with the recorded design source/);

  if (authority === "legacy-runtime") {
    // P4: an authority source may not resolve under the target's evidence tree.
    await consumer.refuses(
      "P4 authority source under evidence/",
      /authority captures and target verification evidence never share a root/,
      async () => {
        const restore = await rollback(consumer, adapter.contextFile);
        await consumer.persist("evidence/slice-a/ui/stolen.png", SHARED_RENDER);
        const context = await consumer.read(adapter.contextFile);
        context.frames[0].sources.screenshot = {
          reference: "evidence/slice-a/ui/stolen.png",
          hash: sha256(SHARED_RENDER),
        };
        await consumer.put(adapter.contextFile, context);
        return restore;
      },
    );
    // P5: the authority slot cannot declare the target's capture role.
    await consumer.refuses(
      "P5 capture.role substitution",
      /capture\.role must be 'LEGACY_AUTHORITY'/,
      async () => {
        const restore = await rollback(consumer, adapter.contextFile);
        const context = await consumer.read(adapter.contextFile);
        context.frames[0].capture.role = "TARGET_VERIFICATION";
        await consumer.put(adapter.contextFile, context);
        return restore;
      },
    );
  } else {
    // (d) Figma provenance that resolves to a different node than the fact
    // claims is refused before the fact is ever compared.
    const elsewhere = async () => {
      const restore = await rollback(consumer, adapter.contextFile);
      const context = await consumer.read(adapter.contextFile);
      // 12:40 is a real node in the same pinned metadata -- the Button instance,
      // 120x36 -- so this is a fact aimed at the wrong node, not a dangling one.
      context.frames[0].facts.width.provenance.nodeId = "12:40";
      await consumer.put(adapter.contextFile, context);
      return restore;
    };
    await consumer.refuses(
      "Figma provenance resolving to the wrong node",
      /facts\.width\.provenance\.nodeId '12:40' is not this frame's node '12:34'/,
      elsewhere,
    );
  }
  await consumer.go();

  // --- BUILD_BASELINE: the derived contract -------------------------------
  await consumer.doc("BUILD_BASELINE");
  for (const [relative, value] of Object.entries(
    matrices({ nativeControls: [NATIVE_EXTRA] }),
  )) {
    await consumer.put(relative, value);
  }
  const registry = await run(
    toolkit,
    "cli/update-migration-registry.mjs",
    ["auth", "--target", "auth", "--mode", "auto"],
    consumer.root,
  );
  assert.equal(registry.code, 0, registry.output);
  await consumer.put("matrices/visual-acceptance.json", contract(authority));
  await checkpoint("BUILD_BASELINE");

  // (d) Omission is fail-closed before provenance is even consulted.
  const contractFile = "matrices/visual-acceptance.json";
  const omit = (key) => async () => {
    const restore = await rollback(consumer, contractFile);
    const authored = contract(authority);
    delete authored.rows[0].expect[key];
    await consumer.put(contractFile, authored);
    return restore;
  };
  await consumer.refuses("missing taxonomy group (color)", /color/, omit("color"));
  await consumer.refuses(
    "deleted authority-established fact (letterSpacing)",
    /letterSpacing/,
    omit("letterSpacing"),
  );
  // (d) A record authored today may not claim the compatibility-only version.
  await consumer.refuses(
    "newly authored version: 1 contract",
    /version/i,
    async () => {
      const restore = await rollback(consumer, contractFile);
      await consumer.put(contractFile, { ...contract(authority), version: 1 });
      return restore;
    },
  );
  // v2 fixes the tolerance; authoring one at all is refused.
  await consumer.refuses("authored tolerance", /tolerance/i, async () => {
    const restore = await rollback(consumer, contractFile);
    const authored = contract(authority);
    authored.rows[0].tolerance = { px: 8, ratio: 0.2 };
    await consumer.put(contractFile, authored);
    return restore;
  });
  // Editing the pinned authority after it closed its checkpoint refuses.
  await consumer.refuses(
    "mutating the pinned authority",
    /Completed artifact changed after validation/,
    async () => {
      const restore = await rollback(consumer, adapter.contextFile);
      const context = await consumer.read(adapter.contextFile);
      context.frames[0].capturedAt = "2026-09-30T00:00:00.000Z";
      await consumer.put(adapter.contextFile, context);
      return restore;
    },
  );
  await consumer.go();

  // (e) Once BUILD_BASELINE closed it, the contract is pinned too.
  await consumer.refuses(
    "mutating the pinned contract",
    /Completed artifact changed after validation: matrices\/visual-acceptance\.json/,
    async () => {
      const restore = await rollback(consumer, contractFile);
      const authored = await consumer.read(contractFile);
      authored.rows[0].expect.fontSize.value = 15;
      await consumer.put(contractFile, authored);
      return restore;
    },
  );

  // --- PLAN -> IMPLEMENT_SLICES ------------------------------------------
  await consumer.doc("PLAN");
  await consumer.put("slices/index.json", { version: 1, slices: SLICES });
  await checkpoint("PLAN");
  await consumer.go();
  await consumer.doc("IMPLEMENT_SLICES");
  await consumer.doc("VERIFY_SLICES");
  await authorSlice(consumer, "slice-a");
  await checkpoint("IMPLEMENT_SLICES");
  await consumer.go(["--slice", "slice-a"]);
  await checkpoint("VERIFY_SLICES");

  // --- (c) The five injections, each on its own --------------------------
  const inject = (label, pattern, options) =>
    consumer.refuses(
      label,
      pattern,
      async () => {
        const restore = await rollback(consumer, "evidence/slice-a/result.json");
        await authorEvidence(consumer, authority, "slice-a", options);
        return async () => {
          await restore();
          await authorEvidence(consumer, authority, "slice-a");
        };
      },
      ["--slice", "slice-a"],
    );

  // 1. A 2px geometry change, against a tolerance fixed at +/-1px.
  await inject("2px geometry divergence", /VISUAL_ACCEPTANCE_FAIL.*width expected/s, {
    values: { ...MEASURED, width: VIEWPORT.width + 2 },
  });
  // 2. Colour and typography, compared post-normalization.
  await inject("colour divergence", /VISUAL_ACCEPTANCE_FAIL.*color expected/s, {
    values: { ...MEASURED, color: "rgb(22, 32, 45)" },
  });
  await inject("typography divergence", /VISUAL_ACCEPTANCE_FAIL.*fontFamily expected/s, {
    values: { ...MEASURED, fontFamily: '"Helvetica", sans-serif' },
  });
  // 3. Layout moved, every measured fact untouched: the perceptual gate alone.
  const perceptual = await inject(
    "perceptual-only layout shift",
    /VISUAL_DIVERGENCE: VIS-1 diffPixels \d+, diffRatio [\d.e-]+, threshold/,
    { render: visualPng(1, 4) },
  );
  const [, shiftedPixels, shiftedRatio, shiftedThreshold] = perceptual.match(
    /VISUAL_DIVERGENCE: VIS-1 diffPixels (\d+), diffRatio ([\d.e-]+), threshold ([\d.e-]+)/,
  );
  record({
    scenario: "perceptual-only layout shift (injected)",
    authority,
    diffPixels: shiftedPixels,
    diffRatio: shiftedRatio,
    threshold: shiftedThreshold,
    verdict: "REFUSED",
  });
  assert.ok(
    Number(shiftedRatio) > Number(shiftedThreshold),
    "the perceptual gate admitted a shifted layout",
  );
  // 5. The wrong visible icon, on both origins: the pixel gate cannot carry a
  // 24x24 asset, so the taxonomy row does.
  const wrongAsset = await inject(
    "wrong visible asset",
    /VISUAL_ACCEPTANCE_FAIL.*assets expected/s,
    { values: { ...MEASURED, assets: ["icon/minus", "logo/mark"] } },
  );
  assert.doesNotMatch(
    wrongAsset,
    /VISUAL_DIVERGENCE/,
    "the wrong-asset refusal came from the pixel gate, not the assets fact",
  );
  // The calibration point of the icon injection: the render is byte-identical
  // to the matching pair, so the pixel gate scores it at zero and would have
  // passed it. Only the `assets` taxonomy row catches a 24x24 icon.
  record({
    scenario: "wrong visible asset (render byte-identical)",
    authority,
    diffPixels: 0,
    diffRatio: 0,
    threshold: authority === "figma-mcp" ? 0.05 : 0.0005,
    verdict: "REFUSED by assets fact, NOT by the pixel gate",
  });

  if (authority === "legacy-runtime") {
    // 4. A removed control, seen only by the structural gate.
    await inject(
      "removed control",
      /VISUAL_STRUCTURE_DIVERGENCE: VIS-1 .*"missing"/s,
      { controls: targetControls().filter((control) => control.role !== "heading") },
    );
    // An unauthorized extra, refused in the other direction. `Docs` is the
    // control no target-native row licenses; `Help` is licensed below, so the
    // two halves of the rule are proven against one baseline.
    await inject(
      "unauthorized extra control",
      /VISUAL_STRUCTURE_DIVERGENCE: VIS-1 unauthorized extra link 'Docs'/,
      { controls: [...targetControls(), extraControl({ role: "link", name: "Docs" })] },
    );
  }
  // A stale authority binding is refused: the pin is evidence, not decoration.
  await inject("stale authority digest", /boundTo\..*Digest is stale/, {
    digest: `sha256:${"b".repeat(64)}`,
  });

  // --- The authorized extra PASSES, and names the row that licensed it ----
  if (authority === "legacy-runtime") {
    await authorEvidence(consumer, authority, "slice-a", {
      controls: [...targetControls(), extraControl(NATIVE_EXTRA)],
    });
    await consumer.go(["--slice", "slice-a"]);
    const comparison = await visualComparisonAt(consumer);
    assert.deepEqual(comparison[0].extrasAuthorized, [{ ...NATIVE_EXTRA, nativeRowId: "NR-1" }]);
    assert.equal(comparison[0].diffPixels, 0, "byte-identical captures must diff in zero pixels");
    record({
      scenario: "matching pair, authorized native extra",
      authority,
      diffPixels: comparison[0].diffPixels,
      diffRatio: comparison[0].diffRatio,
      threshold: comparison[0].threshold,
      verdict: "PASS",
    });
  } else {
    await authorEvidence(consumer, authority, "slice-a");
    await consumer.go(["--slice", "slice-a"]);
    const comparison = await visualComparisonAt(consumer);
    assert.equal(comparison[0].authority, authority);
    record({
      scenario: "matching pair (2x design render downsampled)",
      authority,
      diffPixels: comparison[0].diffPixels,
      diffRatio: comparison[0].diffRatio,
      threshold: comparison[0].threshold,
      verdict: "PASS",
    });
    assert.ok(
      comparison[0].diffRatio <= comparison[0].threshold,
      "a matching pair scored above the threshold",
    );
  }

  // --- slice-b, then FINALIZE --------------------------------------------
  await checkpoint("IMPLEMENT_SLICES");
  await authorSlice(consumer, "slice-b");
  await consumer.go(["--slice", "slice-b"]);
  await authorEvidence(consumer, authority, "slice-b");
  await consumer.go(["--slice", "slice-b"]);
  await checkpoint("FINALIZE");

  // --reopen-ui reopens verification without touching the authority pin.
  const pinBeforeReopen = (await consumer.snapshot()).state.artifactHashes[adapter.contextFile];
  const reopen = await run(
    toolkit,
    "cli/discover-module.mjs",
    ["auth", "--reopen-ui", "slice-a", "--mode", "auto"],
    consumer.root,
  );
  assert.equal(reopen.code, 0, reopen.output);
  assert.equal(
    (await consumer.snapshot()).state.artifactHashes[adapter.contextFile],
    pinBeforeReopen,
    "--reopen-ui moved the authority pin",
  );
  await consumer.doc("VERIFY_SLICES");
  await authorEvidence(consumer, authority, "slice-a", {
    controls:
      authority === "legacy-runtime"
        ? [...targetControls(), extraControl(NATIVE_EXTRA)]
        : targetControls(),
  });
  await consumer.go(["--slice", "slice-a"]);
  while ((await consumer.step()) !== "FINALIZE") {
    await consumer.go(["--slice", "slice-b"]);
  }

  await consumer.doc("FINALIZE");
  for (const [relative, value] of Object.entries(
    matrices({ final: true, nativeControls: authority === "legacy-runtime" ? [NATIVE_EXTRA] : undefined }),
  )) {
    await consumer.put(relative, value);
  }
  await authorGates(consumer, toolkit);

  // FINALIZE re-reads every pinned byte rather than trusting the
  // `visualComparison` the VERIFY_SLICES event already recorded. A target
  // capture that moved since then is refused here, even though the recorded
  // comparison says PASS: the record is evidence, never input.
  assert.ok(
    (await visualComparisonAt(consumer))[0].diffRatio !== undefined,
    "VERIFY_SLICES recorded no comparison for FINALIZE to be tempted by",
  );
  await consumer.refuses(
    "FINALIZE trusting a recorded comparison",
    /does not match the current bytes of|no longer matches its recorded hash/,
    async () => {
      const relative = "evidence/slice-a/ui/uib-1-default.png";
      const restore = await rollback(consumer, relative);
      await writeFile(consumer.at(relative), visualPng(1, 6));
      return restore;
    },
  );

  await consumer.go();
  const complete = await consumer.snapshot();
  assert.equal(complete.state.status, "COMPLETE", JSON.stringify(complete.state.currentStep));
  assert.equal(complete.state.currentStep, "COMPLETE");
  assert.deepEqual(complete.state.completedSlices, ["slice-a", "slice-b"]);
  assert.equal(complete.state.designSource, authority);

  // (e) Every checkpoint saw the same pinned authority and the same role.
  assert.equal(new Set(digests).size, 1, `the authority pin moved: ${digests.join(", ")}`);
  assert.deepEqual(
    [...new Set(roles)],
    [authority === "figma-mcp" ? "FIGMA_AUTHORITY" : "LEGACY_AUTHORITY"],
  );
  assert.equal(
    complete.state.artifactHashes[adapter.contextFile],
    digests[0],
    "the completed record does not carry the pin every checkpoint reported",
  );
  return { consumer, toolkit };
};

test("legacy-runtime: a full lifecycle completes, and every divergence is refused on its own", async (t) => {
  await lifecycle(t, "legacy-runtime");
});

test("figma-mcp: a full lifecycle completes, and every divergence is refused on its own", async (t) => {
  await lifecycle(t, "figma-mcp");
});
