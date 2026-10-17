/**
 * Lifecycle: MC2 legacy-runtime capture. The engine drives the browser and
 * persists what it observed, so an agent never writes a Playwright harness, a
 * measurement generator, frame metadata or a digest by hand.
 *
 * Two destinations, one capture (visual/capture.mjs):
 * - `frame` (designSource legacy-runtime, ASSESS_TARGET): the authority frame
 *   `<uiBehaviorId>::<state>`, its snapshot, screenshot and measurements under
 *   inventories/legacy-runtime/, added to the unpinned legacy-runtime context.
 * - `claim` (format 20, VERIFY_SLICES): the LEGACY proof and PNG of one pinned
 *   appearance claim under the active slice's evidence/, and its LEGACY
 *   uiEvidence row in that slice's result.json.
 *
 * Explicit and writing. The browser runs outside the module lock; the record is
 * re-read under the lock and the write refused if anything it depends on moved.
 * Nothing is overwritten, pinned, approved, advanced or marked PASS, and a
 * refusal at any point leaves no new byte behind. TARGET verification stays the
 * agent's own capture; legacy evidence never stands in for it.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  initialArtifacts,
  LEGACY_RUNTIME_CONTEXT_FILE,
  usesUiCoverage,
} from "../formats/index.mjs";
import { withUiRemediation } from "../census/index.mjs";
import { assertPlainObject, isPlainObject, jsonBytes, portablePath } from "../shared/index.mjs";
import {
  atomicWrite,
  entryExists,
  fileExists,
  fileIdentity,
  readJson,
  removeDurably,
  removeEmptyParents,
} from "../store/index.mjs";
import {
  captureInBrowser,
  claimCapturePlan,
  HARDENED_VISUAL_VERSION,
  LEGACY_RUNTIME_EVIDENCE_ROOT,
  legacyAppearanceRow,
  parseCaptureRequest,
  refuseCapture,
  usesVisualContract,
  validateLegacyRuntimeContext,
  visualAuthorityOf,
} from "../visual/index.mjs";
import { readContext } from "./context.mjs";
import { withModuleLock } from "./lock.mjs";
import { assertCurrentOpenSpecAuthority } from "./openspec.mjs";
import { readState } from "./record.mjs";

const refused = (message) => refuseCapture("CAPTURE_REFUSED", message);

const readObject = async (file, label, fallback) =>
  (await fileExists(file)) ? assertPlainObject(await readJson(file, label), label) : fallback;

const absent = async (root, relatives) => {
  for (const relative of relatives) {
    if (await entryExists(path.join(root, relative))) {
      refuseCapture("CAPTURE_EXISTS", `'${relative}' already exists; a capture never replaces evidence. Remove it only if it is an abandoned capture that nothing cites.`);
    }
  }
};

/* ASSESS_TARGET: one authority frame, joined to the unpinned context. */
const framePlan = async ({ state, root, legacy, request }) => {
  if (state.currentStep !== "ASSESS_TARGET" || !usesVisualContract(state) ||
      visualAuthorityOf(state)?.contextFile !== LEGACY_RUNTIME_CONTEXT_FILE) {
    refused(`An authority frame is captured for a designSource legacy-runtime record at ASSESS_TARGET; this record is '${state.designSource ?? "target-system"}' at ${state.currentStep}.`);
  }
  if (state.artifactHashes?.[LEGACY_RUNTIME_CONTEXT_FILE]) {
    refuseCapture("CAPTURE_AUTHORITY_PINNED", `${LEGACY_RUNTIME_CONTEXT_FILE} is pinned; a pinned legacy authority is never refreshed or extended.`);
  }
  const uiBehavior = (legacy.uiBehaviors ?? []).find((item) => item?.id === request.uiBehaviorId);
  if (!uiBehavior?.runtimeStates?.includes(request.state)) {
    refused(`'${request.uiBehaviorId}' state '${request.state}' is not a discovered state of a UI behavior in ${initialArtifacts.legacyInventory}.`);
  }
  const context = await readObject(path.join(root, LEGACY_RUNTIME_CONTEXT_FILE), LEGACY_RUNTIME_CONTEXT_FILE,
    { version: HARDENED_VISUAL_VERSION, frames: [] });
  if (context.version !== HARDENED_VISUAL_VERSION || !Array.isArray(context.frames ?? [])) {
    refused(`${LEGACY_RUNTIME_CONTEXT_FILE} must be a version-${HARDENED_VISUAL_VERSION} context with a "frames" array before a capture can join it.`);
  }
  const key = `${request.uiBehaviorId}::${request.state}`;
  if ((context.frames ?? []).some((frame) => frame?.id === key)) {
    refuseCapture("CAPTURE_EXISTS", `${LEGACY_RUNTIME_CONTEXT_FILE} already records frame '${key}'; a capture never replaces a recorded frame.`);
  }
  const directory = `${LEGACY_RUNTIME_EVIDENCE_ROOT}${request.uiBehaviorId}-${request.state}`;
  await absent(root, [directory]);
  // Format 20 pins the controls a state shows, and every one is observed; a
  // request can add controls, never replace the pinned ones.
  const pinned = (uiBehavior.requiredAppearance ?? [])
    .filter((claim) => claim.state === request.state && !claim.afterInteractionId)
    .map(({ role, name, locator }) => ({ role, name, locator }));
  const controls = [...pinned, ...request.controls.filter((control) => !pinned.some((item) => item.locator === control.locator))];
  if (controls.length === 0) {
    refuseCapture("CAPTURE_REQUEST_INVALID", "controls is required: name each control the state shows as {role, name, locator}; this record pins no format-20 appearance claim to derive them from.");
  }
  return {
    plan: { ...request, controls },
    context,
    key,
    directory,
    // What the write depends on; re-read under the lock.
    fingerprint: JSON.stringify([state.currentStep, state.legacyRevision, state.artifactHashes?.[LEGACY_RUNTIME_CONTEXT_FILE] ?? null]),
  };
};

/* VERIFY_SLICES, format 20: the LEGACY half of one pinned appearance claim. */
const claimPlan = async ({ state, root, legacy, request }) => {
  if (!usesUiCoverage(state) || state.currentStep !== "VERIFY_SLICES" || !state.activeSlice) {
    refused(`An appearance-claim capture needs a format-20 record at VERIFY_SLICES with an active slice; this record is format ${state.formatVersion} at ${state.currentStep}.`);
  }
  const owner = (legacy.uiBehaviors ?? []).find((item) =>
    (item?.requiredAppearance ?? []).some((claim) => claim?.id === request.appearanceClaimId));
  const claim = owner?.requiredAppearance.find((item) => item.id === request.appearanceClaimId);
  if (!claim) refused(`Appearance claim '${request.appearanceClaimId}' is not pinned in ${initialArtifacts.legacyInventory}.`);
  // Only a behavior this slice traces is verified here; any other row would be refused there.
  const slice = state.activeSlice;
  const { traceIds = [] } = await readObject(path.join(root, `slices/${slice}.json`), `Slice ${slice}`, {});
  const parity = await readObject(path.join(root, initialArtifacts.behaviorParity), "Behavior parity matrix", {});
  if (!(parity.rows ?? []).some((row) => row?.behaviorId === owner.behaviorId && traceIds.includes(row.id))) {
    refused(`Claim '${claim.id}' belongs to '${owner.id}', whose behavior '${owner.behaviorId}' is not traced by the active slice '${slice}'.`);
  }
  if (Boolean(claim.afterInteractionId) !== Boolean(request.interaction)) {
    refuseCapture("CAPTURE_REQUEST_INVALID", claim.afterInteractionId
      ? `Claim '${claim.id}' is observed after interaction '${claim.afterInteractionId}'; supply "interaction" {type, target, value?} that performs it. The inventory says what the interaction does, not how to drive it.`
      : `Claim '${claim.id}' is an initial-state claim; "interaction" is not allowed.`);
  }
  const resultFile = `evidence/${slice}/result.json`;
  const result = await readObject(path.join(root, resultFile), `Evidence for ${slice}`, {});
  if (result.uiEvidence !== undefined && !Array.isArray(result.uiEvidence)) refused(`${resultFile} uiEvidence is authored but is not an array.`);
  if ((result.uiEvidence ?? []).some((row) => isPlainObject(row) && row.origin === "LEGACY" && row.appearanceClaimId === claim.id)) {
    refuseCapture("CAPTURE_EXISTS", `${resultFile} already records the LEGACY row of claim '${claim.id}'; the screenshot budget allows one per origin and claim.`);
  }
  const directory = `evidence/${slice}/ui/legacy`;
  await absent(root, [`${directory}/${claim.id}.proof.json`, `${directory}/${claim.id}.png`]);
  const target = await withUiRemediation(root, state, await readObject(path.join(root, initialArtifacts.targetInventory), "Target inventory", {}), "uiMismatches");
  return {
    plan: claimCapturePlan(request, owner, claim),
    claim,
    uiBehavior: owner,
    mismatch: (target.uiMismatches ?? []).find((row) => row?.uiBehaviorId === owner.id),
    result,
    resultFile,
    directory,
    fingerprint: JSON.stringify([state.currentStep, slice, state.legacyRevision, state.completedSlices ?? []]),
  };
};

const prepare = async ({ targetRoot, moduleName, request }) => {
  const { state, root, pendingWrite } = await readState(targetRoot, moduleName);
  if (pendingWrite) refused("An advance is in flight; recover the record before capturing.");
  if (state.status !== "ACTIVE") refused(`The record is ${state.status}; evidence is captured only for an ACTIVE checkpoint.`);
  await assertCurrentOpenSpecAuthority(targetRoot, state);
  if (request.storageState) {
    const session = path.resolve(request.storageState);
    if (!(await stat(session).catch(() => null))?.isFile()) refused(`storageState '${request.storageState}' is not a readable file.`);
    if (portablePath(path.relative(root, session)).split("/")[0] !== "..") {
      refused("storageState lives inside the migration record; an authorized session file is read, never persisted as evidence.");
    }
  }
  // The validator's own view: an adopted UI remediation replaces the UI rows.
  const legacy = await withUiRemediation(root, state,
    assertPlainObject(await readJson(path.join(root, initialArtifacts.legacyInventory), "Legacy inventory"), "Legacy inventory"), "uiBehaviors");
  const planned = await (request.mode === "frame" ? framePlan : claimPlan)({ state, root, legacy, request });
  return { ...planned, state, root, legacy };
};

/** Write files as new, newest last; on any failure remove exactly what this call wrote. */
const publisher = (targetRoot, root) => {
  const written = [];
  return {
    written,
    file: async (relative, bytes) => {
      const absolute = path.join(root, relative);
      if (await entryExists(absolute)) refuseCapture("CAPTURE_EXISTS", `'${relative}' appeared during the capture.`);
      await atomicWrite(targetRoot, absolute, bytes, { mode: 0o644 });
      written.push(absolute);
      return { reference: relative, hash: await fileIdentity(absolute), bytes: Buffer.byteLength(bytes) };
    },
    rollback: async (directory) => {
      for (const absolute of written.reverse()) await removeDurably(targetRoot, absolute).catch(() => undefined);
      await removeEmptyParents(path.join(root, directory), root).catch(() => undefined);
    },
  };
};

const replaceDocument = async (targetRoot, file, document) => {
  const mode = (await stat(file).catch(() => null))?.mode;
  await atomicWrite(targetRoot, file, jsonBytes(document), { mode: mode === undefined ? 0o644 : mode & 0o777 });
};

const writeFrame = async ({ targetRoot, prepared, captured, publish }) => {
  const { plan, state, root, legacy, context, key, directory } = prepared;
  const { values, computed, limitations: valueLimits, tagName } = captured.measured;
  const snapshot = await publish.file(`${directory}/snapshot.json`, jsonBytes(captured.snapshot));
  const screenshot = await publish.file(`${directory}/screenshot.png`, captured.screenshot);
  const measurements = await publish.file(`${directory}/measurements.json`, jsonBytes({
    viewport: plan.viewport,
    values,
    // Non-authoritative diagnostics: where the values were read. The validator reads viewport and values only.
    provenance: {
      element: plan.rootLocator,
      tagName,
      source: "getComputedStyle and getBoundingClientRect of the root element",
      ...(Object.keys(computed).length > 0 ? { computed } : {}),
      counts: plan.counts,
      assets: "img currentSrc, input[type=image] src, svg use/image href, background-image url() of each visible element and its ::before/::after; query strings dropped, data: URIs by sha256",
    },
  }));
  const limitations = [...valueLimits, ...captured.limitations];
  const frame = {
    id: key,
    uiBehaviorId: plan.uiBehaviorId,
    state: plan.state,
    states: [plan.state],
    viewport: plan.viewport,
    url: captured.url,
    rootLocator: plan.rootLocator,
    legacyRevision: state.legacyRevision?.revision,
    capturedAt: captured.executedAt,
    environment: captured.environment,
    capture: captured.capture,
    extraction: { retrievedAt: captured.executedAt, fidelity: limitations.length > 0 ? "DEGRADED" : "COMPLETE", limitations },
    sources: {
      snapshot: { reference: snapshot.reference, hash: snapshot.hash },
      screenshot: { reference: screenshot.reference, hash: screenshot.hash },
      measurements: { reference: measurements.reference, hash: measurements.hash },
    },
  };
  // The validator's own verdict on this frame alone, before it joins the
  // authored context: another frame's gaps must not decide this one.
  const check = await publish.file(`${directory}/.frame-check.json`, jsonBytes({ version: HARDENED_VISUAL_VERSION, frames: [frame] }));
  try {
    await validateLegacyRuntimeContext(root, state, check.reference, legacy);
  } catch (error) {
    refuseCapture("CAPTURE_FRAME_REFUSED", error.message.replaceAll(check.reference, LEGACY_RUNTIME_CONTEXT_FILE));
  } finally {
    await removeDurably(targetRoot, path.join(root, check.reference));
    publish.written.pop();
  }
  await replaceDocument(targetRoot, path.join(root, LEGACY_RUNTIME_CONTEXT_FILE), { ...context, frames: [...(context.frames ?? []), frame] });
  const recorded = new Set([...(context.frames ?? []).map((item) => item?.id), key]);
  const remaining = (legacy.uiBehaviors ?? []).flatMap((item) =>
    (item?.runtimeStates ?? []).map((runtimeState) => `${item.id}::${runtimeState}`)).filter((id) => !recorded.has(id));
  return {
    files: [snapshot, screenshot, measurements],
    record: LEGACY_RUNTIME_CONTEXT_FILE,
    observed: {
      facts: Object.keys(values).length,
      counts: Object.fromEntries(Object.keys(plan.counts).map((name) => [name, values[name]])),
      fidelity: frame.extraction.fidelity,
    },
    limitations,
    unresolved: [
      remaining.length > 0 && { field: "frames[]", count: remaining.length, items: remaining.slice(0, 20), need: "Capture every other discovered state that must be visually backed, or have the operator decide it VISUAL_UNBACKED at BUILD_BASELINE." },
    ].filter(Boolean),
    next: "Close ASSESS_TARGET through migration_run (the context is pinned there); then migration_prefill at BUILD_BASELINE derives the visual-acceptance rows and leaves each target locator to author.",
  };
};

const writeClaim = async ({ targetRoot, prepared, captured, publish }) => {
  const { plan, state, root, claim, uiBehavior, mismatch, result, resultFile, directory } = prepared;
  const asEvidence = (entry) => ({ ...entry, reference: portablePath(path.relative(targetRoot, path.join(root, entry.reference))) });
  const proof = asEvidence(await publish.file(`${directory}/${claim.id}.proof.json`, jsonBytes(captured.snapshot)));
  const screenshot = asEvidence(await publish.file(`${directory}/${claim.id}.png`, captured.screenshot));
  const row = legacyAppearanceRow({ state, sliceId: state.activeSlice, uiBehavior, mismatch, claim, plan, captured,
    files: { snapshot: proof, screenshot } });
  await replaceDocument(targetRoot, path.join(root, resultFile), { ...result, uiEvidence: [...(result.uiEvidence ?? []), row] });
  return {
    files: [proof, screenshot],
    record: `${resultFile} uiEvidence[${(result.uiEvidence ?? []).length}]`,
    observed: { claim: claim.id, afterInteractionId: claim.afterInteractionId ?? null },
    limitations: captured.limitations,
    unresolved: [
      { field: "result", count: 1, need: "PASS only after confirming the LEGACY observation shows what the claim states; the capture observed it, it did not judge it." },
      claim.afterInteractionId && { field: "interactions[].actual, interactions[].outcome", count: 2, need: "What the legacy interaction actually did, and PASS when that matches its expected outcome." },
    ].filter(Boolean),
    next: `Capture the TARGET row for claim '${claim.id}' at the same locator, compare ${captured.image.width}x${captured.image.height}, matte and color scheme; validation compares the two.`,
  };
};

/**
 * MC2. Capture one legacy-runtime state (or format-20 appearance claim) in a
 * real browser and persist it; return a compact summary, never the evidence.
 */
export const captureLegacyRuntimeEvidence = async ({ registryPath, moduleName, request }) => {
  const parsed = parseCaptureRequest(request);
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  const { targetRoot } = registryData;
  const input = { targetRoot, moduleName: resolved.canonical, request: parsed };
  const before = await prepare(input);
  const captured = await captureInBrowser(before.plan);
  return withModuleLock(targetRoot, resolved.canonical, async () => {
    const prepared = await prepare(input);
    if (prepared.fingerprint !== before.fingerprint) {
      refuseCapture("CAPTURE_CONFLICT", "The record moved while the browser was capturing; capture again against the current checkpoint.");
    }
    const publish = publisher(targetRoot, prepared.root);
    let outcome;
    try {
      outcome = await (parsed.mode === "frame" ? writeFrame : writeClaim)({ targetRoot, prepared, captured, publish });
    } catch (error) {
      await publish.rollback(prepared.directory);
      throw error;
    }
    const { scroll } = captured.snapshot.interactions[0]?.postAction ?? captured.snapshot.observation;
    return {
      module: resolved.canonical,
      step: prepared.state.currentStep,
      mode: parsed.mode,
      captured: { uiBehaviorId: prepared.plan.uiBehaviorId, state: prepared.plan.state, ...outcome.observed },
      destination: prepared.directory,
      written: [...outcome.files.map(({ reference, bytes, hash }) => ({ path: reference, bytes, hash })), outcome.record],
      browser: { environment: captured.environment, origin: parsed.origin, url: captured.url, viewport: parsed.viewport,
        deviceScaleFactor: 1, colorScheme: parsed.colorScheme, reducedMotion: "reduce", image: `${captured.image.width}x${captured.image.height}` },
      authority: { legacyRevision: prepared.state.legacyRevision?.revision ?? null },
      measured: { controls: prepared.plan.controls.length, scrollOwner: scroll.owner.kind, ancestors: scroll.ancestors.length },
      limitations: outcome.limitations,
      unresolved: outcome.unresolved,
      operations: captured.operations,
      durationMs: captured.durationMs,
      next: outcome.next,
      note: "Captured evidence is observation, not acceptance: nothing was pinned, approved, advanced or marked PASS. Validation decides.",
    };
  });
};
