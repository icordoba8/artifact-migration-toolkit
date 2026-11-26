/**
 * Lifecycle: MC2 legacy-runtime capture. The engine drives the browser and
 * persists what it observed, so an agent never writes a Playwright harness, a
 * measurement generator, frame metadata or a digest by hand.
 *
 * Two destinations, one capture (visual/capture.mjs):
 * - `frame` (designSource legacy-runtime, ASSESS_TARGET): the authority frame
 *   `<uiBehaviorId>::<state>`, its snapshot, screenshot and measurements under
 *   inventories/legacy-runtime/, added to the unpinned legacy-runtime context.
 * - `claim` (format 20, VERIFY_SLICES): the proof and PNG of one pinned
 *   appearance claim under the active slice's evidence/, and its uiEvidence row
 *   in that slice's result.json, for LEGACY or (`role: "TARGET"`) the target.
 *
 * Explicit and writing. The browser runs outside the module lock; the record is
 * re-read under the lock and the write refused if anything it depends on moved.
 * Frame and verification evidence is write-once. Discovery observations are
 * updated as work finishes. The capture never pins or advances the record. A TARGET row is written only
 * from the target's own capture, and only when it meets every predicate the
 * pinned contract names; legacy evidence never stands in for it.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  initialArtifacts,
  LEGACY_RUNTIME_CONTEXT_FILE,
  usesUiCoverage,
  UI_REMEDIATION_FILE,
} from "../formats/index.mjs";
import { withUiRemediation } from "../census/index.mjs";
import { assertPlainObject, contentIdentity, gitRevision, isPlainObject, jsonBytes, portablePath, sha256Hex } from "../shared/index.mjs";
import { implementationDigests } from "../slices/index.mjs";
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
  captureThroughBroker,
  claimCapturePlan,
  compareScrollContract,
  DISCOVERY_ROOT_LIMIT,
  HARDENED_VISUAL_VERSION,
  LEGACY_RUNTIME_EVIDENCE_ROOT,
  legacyAppearanceRow,
  parseCaptureRequest,
  assertSessionUsable,
  refuseCapture,
  targetAppearanceRow,
  targetProof,
  usesVisualContract,
  validateLegacyRuntimeContext,
  visualAuthorityOf,
} from "../visual/index.mjs";
import { legacyRuntimeAuthorityOf, sessionBrokerOf } from "./app-runtime.mjs";
import { readContext } from "./context.mjs";
import { acquireModuleLock, moduleLockHeld, withModuleLock } from "./lock.mjs";
import { assertCurrentOpenSpecAuthority } from "./openspec.mjs";
import { migrationProgress, renderProgress } from "./progress.mjs";
import { DISCOVERY_CLAIMS_FILE, readState } from "./record.mjs";

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
const claimPlan = async ({ state, root, legacy, request, roots }) => {
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
  const { role } = request;
  const resultFile = `evidence/${slice}/result.json`;
  const result = await readObject(path.join(root, resultFile), `Evidence for ${slice}`, {});
  if (result.uiEvidence !== undefined && !Array.isArray(result.uiEvidence)) refused(`${resultFile} uiEvidence is authored but is not an array.`);
  if ((result.uiEvidence ?? []).some((row) => isPlainObject(row) && (row.origin ?? "TARGET") === role && row.appearanceClaimId === claim.id)) {
    refuseCapture("CAPTURE_EXISTS", `${resultFile} already records the ${role} row of claim '${claim.id}'; the screenshot budget allows one per origin and claim.`);
  }
  const directory = `evidence/${slice}/ui/${role.toLowerCase()}`;
  await absent(root, [`${directory}/${claim.id}.proof.json`, `${directory}/${claim.id}.png`]);
  const target = await withUiRemediation(root, state, await readObject(path.join(root, initialArtifacts.targetInventory), "Target inventory", {}), "uiMismatches");
  const plan = claimCapturePlan(request, owner, claim);
  let bound = {};
  if (role === "TARGET") {
    Object.assign(plan, stateControls(owner, claim, request));
    const implementation = await readObject(path.join(root, `slices/${slice}.json`), `Slice ${slice}`, {});
    bound = {
      implementationDigest: (await implementationDigests({ changedFiles: implementation.changedFiles ?? [] }, roots)).current,
      traceId: parity.rows.find((row) => row?.behaviorId === owner.behaviorId && traceIds.includes(row.id)).id,
    };
  }
  return {
    plan,
    claim,
    uiBehavior: owner,
    mismatch: (target.uiMismatches ?? []).find((row) => row?.uiBehaviorId === owner.id),
    result,
    resultFile,
    directory,
    bound,
    fingerprint: JSON.stringify([state.currentStep, slice, state.legacyRevision, state.completedSlices ?? [], bound.implementationDigest ?? null]),
  };
};

/**
 * The controls VERIFY_SLICES observes for a claim's TARGET half: every pinned
 * claim of its state shown after its interaction, and every initial claim of
 * that state shown before it. Discovery plans and judges a claim the same way,
 * so a state whose claims cannot all hold together is refused there, not at TARGET.
 */
const stateControls = (owner, claim, request) => {
  // Every predicate the contract checks in this proof needs its control observed;
  // a format-20 claim pins each expected-true one, so the claims are the controls.
  const unpinned = (owner.requiredObservations ?? []).find((item) => item.state === claim.state && item.predicate !== "url" && item.expected === false);
  if (unpinned) refuseCapture("CAPTURE_REQUEST_INVALID", `Required observation '${unpinned.id}' expects an absent control, which no pinned claim locates; the engine capture cannot observe it.`);
  // shortcut: expected-false observations are refused above; give them a locator in the contract when a consumer needs one.
  const pinned = (after) => owner.requiredAppearance
    .filter((item) => item.state === claim.state && (item.afterInteractionId ?? null) === after)
    .map(({ role: controlRole, name, locator }) => ({ role: controlRole, name, locator }));
  const extra = (controls) => [...controls, ...(request.controls ?? []).filter((control) => !controls.some((item) => item.locator === control.locator))];
  return {
    controls: extra(pinned(claim.afterInteractionId ?? null)),
    ...(claim.afterInteractionId ? { beforeControls: extra(pinned(null)) } : {}),
  };
};

/**
 * One LEGACY observation of a claim, judged as VERIFY_SLICES will judge its
 * TARGET half: every pinned control of the state shown before and after the
 * interaction, the contract's required observations, then the scroll contract.
 * The discovery run and the DISCOVER_LEGACY gate both call it, so the gate
 * re-derives each verdict from the persisted snapshot.
 */
const judgeClaim = (owner, claim, snapshot, origin) => {
  const interactions = claim.afterInteractionId ? [claim.afterInteractionId] : [];
  if (snapshot?.state !== claim.state ||
      JSON.stringify(snapshot?.interactions?.map((item) => item.id)) !== JSON.stringify(interactions) ||
      [snapshot.observation, ...snapshot.interactions.map((item) => item.postAction)]
        .some((item) => !URL.canParse(item?.url) || new URL(item.url).origin !== origin)) {
    refused(`The observation for '${claim.id}' does not match its authorized origin, state and interaction.`);
  }
  const { controls, beforeControls } = stateControls(owner, claim, {});
  const after = claim.afterInteractionId ? snapshot?.interactions?.[0]?.postAction : snapshot?.observation;
  const shows = (observation, wanted, label) => {
    const unseen = wanted.filter((want) => !(observation?.controls ?? []).some((control) => control?.role === want.role &&
      control.name === want.name && control.locator === want.locator && control.present === true && control.visible === true));
    if (unseen.length > 0) {
      refuseCapture("CAPTURE_STATE_NOT_REACHED", `${label} does not show ${unseen.map((item) => `${item.role} '${item.name}' at '${item.locator}'`).join(", ")}, which ${initialArtifacts.legacyInventory} pins for state '${claim.state}'; VERIFY_SLICES observes them together, so this contract cannot be met.`);
    }
  };
  shows(after, controls, claim.afterInteractionId ? `After interaction '${claim.afterInteractionId}', the page` : `State '${claim.state}'`);
  if (beforeControls) shows(snapshot.observation, beforeControls, `Before interaction '${claim.afterInteractionId}', the page`);
  targetProof({ snapshot, sliceId: null, traceId: null, uiBehavior: owner });
  const contract = (owner.scrollContracts ?? []).find((row) => row?.state === claim.state);
  if (!contract) refused(`'${owner.id}' has no scrollContracts row for state '${claim.state}'.`);
  compareScrollContract({ observation: after }, { observation: after }, contract, false);
};

export const readDiscoveryInventory = async (root) => {
  const file = path.join(root, initialArtifacts.legacyInventory);
  const bytes = await readFile(file).catch((error) => {
    throw error.code === "ENOENT" ? new Error(`Legacy inventory does not exist: ${file}`) : error;
  });
  let inventory;
  try { inventory = JSON.parse(bytes); } catch (error) { throw new Error(`Legacy inventory is invalid JSON: ${error.message}`); }
  return { inventory: assertPlainObject(inventory, "Legacy inventory"), file, bytes };
};

const prepare = async ({ targetRoot, moduleName, request, roots }) => {
  const { state, root, pendingWrite } = await readState(targetRoot, moduleName);
  if (pendingWrite) refused("An advance is in flight; recover the record before capturing.");
  if (state.status !== "ACTIVE") refused(`The record is ${state.status}; evidence is captured only for an ACTIVE checkpoint.`);
  await assertCurrentOpenSpecAuthority(targetRoot, state);
  let storageIdentity;
  if (request.storageState) {
    // Both sides by realpath: a symlink outside the record may not point into it.
    const session = await realpath(path.resolve(request.storageState)).catch(() => null);
    if (!session || !(await stat(session)).isFile()) refused(`storageState '${request.storageState}' is not a readable file.`);
    if (portablePath(path.relative(await realpath(root), session)).split("/")[0] !== "..") {
      refused("storageState lives inside the migration record; an authorized session file is read, never persisted as evidence.");
    }
    if (request.mode === "discovery") storageIdentity = await sessionIdentity(session);
    const document = await readJson(session, "storageState").catch(() => refused("storageState is not valid JSON."));
    assertSessionUsable(document, request.origin);
    if (request.mode === "discovery") {
      if (await sessionIdentity(session) !== storageIdentity) refused("The authorized storageState changed while it was read. Retry.");
      request = { ...request, claims: request.claims.map((claim) => ({ ...claim, storageState: document })) };
    }
  }
  // The validator's own view: an adopted UI remediation replaces the UI rows.
  // One read: the plans and the identity a discovery check is bound to come from the same bytes.
  const { inventory: authored, file, bytes } = await readDiscoveryInventory(root);
  const remediation = request.mode === "discovery" ? await identityOfRemediation(root) : null;
  const legacy = await withUiRemediation(root, state, authored, "uiBehaviors");
  if (request.mode === "discovery" && remediation !== await identityOfRemediation(root)) {
    refuseCapture("CAPTURE_CONFLICT", "The adopted UI remediation moved while the inventory was read.");
  }
  const inventory = contentIdentity(file, bytes, { bytes: true });
  const planned = await ({ frame: framePlan, claim: claimPlan, discovery: discoveryPlan })[request.mode]({
    state, root, legacy, request, roots, inventory, storageIdentity, remediation,
  });
  return { ...planned, state, root, legacy };
};

const digest = (value) => sha256Hex(JSON.stringify(value));
const sessionIdentity = async (file) => {
  const { dev, ino, ctimeNs, mtimeNs, size } = await stat(file, { bigint: true });
  return digest([dev, ino, ctimeNs, mtimeNs, size].map(String));
};
const discoveryLockName = (state) => `discovery/${state.legacyModule}`;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const discoveryClaimsOf = (legacy, duplicate) => {
  const { uiBehaviors, behaviors, ...other } = legacy;
  const linked = new Map((behaviors ?? []).map((behavior) => [behavior.id, behavior]));
  const shared = digest(other);
  const pinned = new Map();
  for (const owner of uiBehaviors ?? []) {
    const { requiredAppearance = [], requiredObservations = [], scrollContracts = [], interactions = [], ...metadata } = owner;
    const context = digest([shared, metadata, linked.get(owner.behaviorId)]);
    const stateDeps = new Map();
    for (const claim of requiredAppearance) {
      if (pinned.has(claim.id)) duplicate(claim.id);
      const after = claim.afterInteractionId ?? null;
      const forState = (row) => row.state === claim.state;
      const key = JSON.stringify([claim.state, after]);
      if (!stateDeps.has(key)) {
        stateDeps.set(key, digest([context,
          requiredAppearance.filter((row) => forState(row) && (!row.afterInteractionId || row.afterInteractionId === after)),
          requiredObservations.filter(forState),
          scrollContracts.filter(forState),
          interactions.filter((row) => row.id === after),
        ]));
      }
      pinned.set(claim.id, { owner, claim, deps: stateDeps.get(key) });
    }
  }
  return pinned;
};

const readDiscoveryRecord = async (root) => {
  const file = path.join(root, DISCOVERY_CLAIMS_FILE);
  const bytes = await readFile(file).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  if (!bytes) return { identity: null, document: null };
  let document;
  try { document = JSON.parse(bytes); } catch { document = null; }
  return { identity: contentIdentity(file, bytes, { bytes: true }), document };
};

const discoveryBinding = (state, legacyInventory, runtime, remediation) => ({
  revision: state.revision,
  legacyInventory,
  legacyOrigin: runtime.origin,
  legacyRevision: state.legacyRevision?.revision ?? null,
  requirementsAuthority: state.requirementsAuthority ?? null,
  runtimeAuthority: runtime.digest,
  remediation,
});

const identityOfRemediation = async (root) =>
  fileIdentity(path.join(root, UI_REMEDIATION_FILE), { bytes: true }).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });

const currentBinding = async (targetRoot, root, state, version = 2) => {
  const binding = discoveryBinding(
    state,
    await fileIdentity(path.join(root, initialArtifacts.legacyInventory), { bytes: version === 2 }),
    await legacyRuntimeAuthorityOf(targetRoot),
    version === 2 ? await identityOfRemediation(root) : null,
  );
  if (version === 1) {
    delete binding.runtimeAuthority;
    delete binding.remediation;
  }
  return binding;
};

const assertLegacyClaimRevision = async (legacyRoot, state) => {
  const current = await gitRevision(legacyRoot);
  if (current.revision !== state.legacyRevision?.revision) {
    refuseCapture("DISCOVERY_CLAIMS_STALE", "The legacy source revision changed. Resolve the recorded legacy revision before capturing or closing discovery.");
  }
};

const sameAuthority = (left, right) => Object.keys(right)
  .every((key) => key === "legacyInventory" || same(left?.[key], right[key]));

const validRecord = (record) => isPlainObject(record) && [1, 2].includes(record.version) &&
  record.producer === "artifact-migration-capture" && isPlainObject(record.binding) &&
  isPlainObject(record.capture) && URL.canParse(record.capture.origin) &&
  new URL(record.capture.origin).origin === record.capture.origin &&
  (record.binding.legacyOrigin === null || record.capture.origin === record.binding.legacyOrigin) &&
  Array.isArray(record.claims);

const cachedDiscovery = (document, binding, capture, pinned) => {
  const rows = new Map();
  const failures = new Map();
  if (!validRecord(document) || document.version !== 2 || !sameAuthority(document.binding, binding) ||
      !same(document.capture, capture) ||
      (document.contradicted !== undefined && (!Array.isArray(document.contradicted) || document.contradicted.length === 0))) {
    return { rows, failures };
  }
  for (const row of document.contradicted ?? []) {
    if (row?.deps && pinned.get(row.appearanceClaimId)?.deps === row.deps && typeof row.code === "string") {
      failures.set(row.appearanceClaimId, row);
    }
  }
  const seen = new Set();
  for (const row of document.claims) {
    const id = row?.appearanceClaimId;
    if (seen.has(id)) { rows.delete(id); continue; }
    seen.add(id);
    const check = pinned.get(id);
    if (!check || row.deps !== check.deps || failures.has(id)) continue;
    try {
      judgeClaim(check.owner, check.claim, row.snapshot, capture.origin);
      rows.set(id, row);
    } catch { /* A snapshot that no longer proves the claim must be recaptured. */ }
  }
  return { rows, failures };
};

const discoveryPlan = async ({ state, root, legacy, request, roots, inventory, storageIdentity, remediation }) => {
  if (state.currentStep === "DISCOVER_LEGACY") await assertLegacyClaimRevision(roots.legacyRoot, state);
  const runtime = await legacyRuntimeAuthorityOf(roots.targetRoot);
  if (runtime.origin === null && request.session) {
    refuseCapture("CAPTURE_AUTHORITY_MISMATCH", "A session check needs a configured LEGACY runtime origin; run migration_app_runtime configure first.");
  }
  if (runtime.origin !== null && runtime.origin !== request.origin) {
    refuseCapture("CAPTURE_AUTHORITY_MISMATCH", `origin '${request.origin}' is not the LEGACY origin '${runtime.origin}' the runtime contract declares.`);
  }
  const pinned = discoveryClaimsOf(legacy, (id) => refused(`Appearance claim '${id}' is repeated in ${initialArtifacts.legacyInventory}.`));
  const checks = request.claims.map((item) => {
    const { appearanceClaimId: id } = item;
    const { owner, claim, deps } = pinned.get(id) ?? {};
    try {
      if (!claim) refused(`Appearance claim '${id}' is not in ${initialArtifacts.legacyInventory}.`);
      if (Boolean(claim.afterInteractionId) !== Boolean(item.interaction)) {
        refuseCapture("CAPTURE_REQUEST_INVALID", claim.afterInteractionId
          ? `Claim '${id}' is observed after interaction '${claim.afterInteractionId}'; supply "interaction".`
          : `Claim '${id}' is an initial-state claim; "interaction" is not allowed.`);
      }
      const plan = { ...claimCapturePlan(item, owner, claim), ...stateControls(owner, claim, item) };
      const { storageState: _session, appearanceClaimId: _id, rootLocator, timeoutMs, navigationTimeoutMs, matte: _matte, ...page } = plan;
      return { id, claim, owner, plan, deps, planDigest: digest([page, rootLocator]),
        pageKey: plan.setup.length === 0 && !plan.interaction ? digest([page, timeoutMs, navigationTimeoutMs]) : null };
    } catch (error) {
      return { id, deps, error };
    }
  });
  const binding = discoveryBinding(state, inventory, runtime, remediation);
  const capture = { origin: request.origin, session: request.session === true,
    storageState: request.storageState !== undefined, ...(storageIdentity ? { storageIdentity } : {}) };
  const record = await readDiscoveryRecord(root);
  return { pinned, checks, binding, capture, record };
};

const RUN_REFUSALS = new Set(["CAPTURE_BROWSER_UNAVAILABLE", "CAPTURE_AUTH_REQUIRED", "CAPTURE_SESSION_EXPIRED",
  "CAPTURE_SESSION_HOST", "CAPTURE_BROKER_UNAVAILABLE", "CAPTURE_BROKER_NOT_ISOLATED", "CAPTURE_BROKER_FAILED",
  "CAPTURE_BROKER_INCOMPATIBLE", "CAPTURE_BROKER_UNCONFIGURED", "BROKER_CLIENT_UNAUTHORIZED", "BROKER_FAILED"]);

// Below the provider's 30-minute idle limit, even when a request contains many slow setup steps.
const DISCOVERY_CALL_MS = 10 * 60_000;

const claimCounts = ({ pinned, rows, failures, running, bound, blocked }) => {
  const total = pinned.size;
  const passed = rows.size;
  const failed = failures.size;
  const completed = passed + failed;
  return { state: running ? "RUNNING" : blocked || (failed > 0 && completed === total) ? "BLOCKED" :
    bound && passed === total ? "READY" : "PENDING", completed, total, passed, failed, remaining: total - passed };
};

/** Status uses the same durable observations as the capture result. */
export const discoveryClaimProgress = async (targetRoot, root, state, inventory, liveRevision) => {
  if (!usesUiCoverage(state) || state.currentStep !== "DISCOVER_LEGACY" || !inventory) return null;
  const legacy = await withUiRemediation(root, state, inventory, "uiBehaviors");
  let pinned;
  try { pinned = discoveryClaimsOf(legacy, (id) => refused(`Duplicate appearance claim '${id}'.`)); }
  catch { return null; }
  if (!pinned.size) return null;
  const running = await moduleLockHeld(targetRoot, discoveryLockName(state));
  const { document } = await readDiscoveryRecord(root);
  const binding = liveRevision === state.legacyRevision?.revision
    ? await currentBinding(targetRoot, root, state, document?.version === 1 ? 1 : 2).catch(() => null) : null;
  const { rows, failures } = binding
    ? cachedDiscovery(document, binding, document?.capture, pinned) : { rows: new Map(), failures: new Map() };
  let bound = binding !== null && validRecord(document) && same(document.binding, binding);
  if (bound && document.version === 1) {
    for (const row of Array.isArray(document.contradicted) ? document.contradicted : []) {
      if (pinned.has(row?.appearanceClaimId)) failures.set(row.appearanceClaimId, row);
    }
    for (const row of document.contradicted === undefined ? document.claims : []) {
      const check = pinned.get(row?.appearanceClaimId);
      if (!check) continue;
      try {
        judgeClaim(check.owner, check.claim, row.snapshot, document.capture.origin);
        rows.set(row.appearanceClaimId, row);
      } catch { /* A v1 record is only counted under its original exact binding. */ }
    }
  }
  bound &&= document.claims.length === rows.size;
  return claimCounts({ pinned, rows, failures, running, bound,
    blocked: binding === null || [...failures.values()].some(({ code }) => RUN_REFUSALS.has(code)) });
};

/** Publish one completed browser state. The module lock is held only for the write. */
const recordDiscoveryCheck = async ({ roots, prepared, resolved, expectedRecord, rows, failures }) => {
  const { targetRoot, legacyRoot } = roots;
  return withModuleLock(targetRoot, resolved.canonical, async () => {
    const { state, root, pendingWrite } = await readState(targetRoot, resolved.canonical);
    const binding = await currentBinding(targetRoot, root, state).catch(() => null);
    if (pendingWrite || state.status !== "ACTIVE" || state.currentStep !== "DISCOVER_LEGACY" || !same(binding, prepared.binding)) {
      refuseCapture("CAPTURE_CONFLICT", "The record or its legacy inventory moved while the browser was checking; check again against the current inventory.");
    }
    await assertCurrentOpenSpecAuthority(targetRoot, state);
    await assertLegacyClaimRevision(legacyRoot, state);
    if ((await readDiscoveryRecord(root)).identity !== expectedRecord) {
      refuseCapture("CAPTURE_CONFLICT", `Another writer changed ${DISCOVERY_CLAIMS_FILE} while the browser was checking; check again.`);
    }
    const document = {
      version: 2,
      producer: "artifact-migration-capture",
      checkedAt: new Date().toISOString(),
      binding,
      capture: prepared.capture,
      claims: [...prepared.pinned.keys()].filter((id) => rows.has(id)).map((id) => rows.get(id)),
      ...(failures.size ? { contradicted: [...prepared.pinned.keys()].filter((id) => failures.has(id)).map((id) => failures.get(id)) } : {}),
    };
    const file = path.join(root, DISCOVERY_CLAIMS_FILE);
    await replaceDocument(targetRoot, file, document);
    return contentIdentity(file, jsonBytes(document), { bytes: true });
  });
};

const checkClaims = async ({ roots, prepared, parsed, resolved }) => {
  const { targetRoot } = roots;
  const durable = prepared.state.currentStep === "DISCOVER_LEGACY";
  const { checks, pinned, binding, capture, record } = prepared;
  const { rows, failures } = cachedDiscovery(durable ? record.document : null, binding, capture, pinned);
  const passed = new Set();
  const reused = new Set();
  const failed = new Map();
  let expectedRecord = record.identity;
  let stopped;
  const signal = AbortSignal.timeout(DISCOVERY_CALL_MS);
  const publish = async () => {
    if (durable) expectedRecord = await recordDiscoveryCheck({ roots, prepared, resolved, expectedRecord, rows, failures });
  };
  const work = checks.filter(({ id, planDigest }) => {
    if (parsed.refresh || !planDigest || rows.get(id)?.planDigest !== planDigest) return true;
    reused.add(id);
    passed.add(id);
    return false;
  });
  // Finish unseen or changed work first. Retry the oldest failures first when they fill several batches.
  const fresh = work.filter(({ id, planDigest }) => !failures.has(id) || failures.get(id).planDigest !== planDigest);
  const batch = (fresh.length ? fresh : work.sort((a, b) =>
    (failures.get(a.id).checkedAt ?? 0) - (failures.get(b.id).checkedAt ?? 0))).slice(0, parsed.batchSize);
  let broker;
  let browserCaptures = 0;
  const fail = ({ id, deps, planDigest }, error) => {
    const code = error.validationCode ?? error.message.match(/^[A-Z_]+(?=:)/)?.[0] ?? "CAPTURE_FAILED";
    failed.set(id, { appearanceClaimId: id, code, message: error.message.replace(/ Nothing was written\.$/, "") });
    if (deps) {
      rows.delete(id);
      failures.set(id, { appearanceClaimId: id, code, deps, planDigest, checkedAt: Date.now() });
    }
  };
  // A new plan or explicit refresh supersedes the selected rows before any browser work.
  // An interrupted recheck therefore cannot revive the earlier pass.
  let invalidated = false;
  for (const { id } of work) if (rows.delete(id)) invalidated = true;
  const scopeMoved = record.document?.version === 2 && !same(record.document.capture, capture);
  const refreshesV1 = parsed.refresh && record.document?.version === 1;
  if (invalidated || ((scopeMoved || refreshesV1) && work.some(({ deps }) => deps)) ||
      (reused.size && !same(record.document?.binding, binding))) await publish();

  while (batch.length && !stopped && !signal.aborted) {
    const first = batch.shift();
    if (first.error) {
      fail(first, first.error);
      if (first.deps) await publish();
      continue;
    }
    const group = [first];
    while (group.length < DISCOVERY_ROOT_LIMIT && first.pageKey && batch[0]?.pageKey === first.pageKey) group.push(batch.shift());
    const discoveryRoots = group.map(({ plan }) => plan.rootLocator);
    let observed = 0;
    let publishError;
    const onObservation = async (observation) => {
      const check = group[observed];
      if (!check || observation.rootLocator !== check.plan.rootLocator) {
        refuseCapture("CAPTURE_BROKER_FAILED", "The observation does not match the requested root.");
      }
      try {
        if (observation.code) throw Object.assign(new Error(observation.message), { validationCode: observation.code });
        const { state, observation: page, interactions } = observation.snapshot;
        const snapshot = { state, observation: page, interactions: interactions.map(({ id, postAction }) => ({ id, postAction })) };
        judgeClaim(check.owner, check.claim, snapshot, capture.origin);
        passed.add(check.id);
        failures.delete(check.id);
        rows.set(check.id, { appearanceClaimId: check.id, deps: check.deps, planDigest: check.planDigest,
          route: check.plan.route, viewport: check.plan.viewport, colorScheme: check.plan.colorScheme, snapshot });
      } catch (error) {
        fail(check, error);
      }
      try {
        await publish();
        observed += 1;
      } catch (error) {
        publishError = error;
        throw error;
      }
    };
    try {
      browserCaptures += 1;
      if (parsed.session) {
        broker ??= await sessionBrokerOf(targetRoot);
        const report = await captureThroughBroker(broker, first.plan, "LEGACY", { readOnly: true, discoveryRoots, onObservation, signal });
        if (report.snapshot) {
          // The v1.10.2 broker ignores discoveryRoots and returns one read-only capture.
          batch.unshift(...group.splice(1).map((check) => ({ ...check, pageKey: null })));
          await onObservation({ rootLocator: report.capture.rootLocator, snapshot: report.snapshot });
        }
      } else {
        await captureInBrowser({ ...first.plan, guard: { allowWrites: false } }, { discoveryRoots, onObservation, signal });
      }
      if (observed !== group.length) refuseCapture("CAPTURE_BROKER_FAILED", "The browser returned fewer observations than requested.");
    } catch (error) {
      if (publishError) throw publishError;
      if (signal.aborted) break;
      const authorityLost = ["CAPTURE_ORIGIN_VIOLATION", "CAPTURE_AUTH_REQUIRED", "CAPTURE_SESSION_EXPIRED"].includes(error.validationCode);
      const affected = authorityLost ? group : group.slice(observed);
      for (const check of affected) {
        passed.delete(check.id);
        fail(check, error);
      }
      if (affected.length) await publish();
      if (RUN_REFUSALS.has(error.validationCode)) stopped = error;
    }
  }
  const unchecked = [...pinned.keys()].filter((id) => !rows.has(id) && !failures.has(id));
  const deferred = checks.filter(({ id }) => !passed.has(id) && !failed.has(id)).map(({ id }) => id);
  const written = expectedRecord === record.identity ? [] : [DISCOVERY_CLAIMS_FILE];
  const discoveryClaims = claimCounts({ pinned, rows, failures, bound: !signal.aborted, blocked: Boolean(stopped) });
  const progress = migrationProgress(prepared.state, {
    discoveryClaims: durable ? discoveryClaims : null,
    outcome: stopped ? "BLOCKED" : null,
    reason: stopped?.message.replace(/ Nothing was written\.$/, ""),
  });
  if (stopped && !durable) throw stopped;
  return {
    module: resolved.canonical, step: prepared.state.currentStep, mode: "discovery",
    passed: checks.filter(({ id }) => passed.has(id)).map(({ id }) => id),
    failed: checks.filter(({ id }) => failed.has(id)).map(({ id }) => failed.get(id)),
    reused: [...reused], unchecked, deferred, browserCaptures, written, discoveryClaims,
    progress, progressChecklist: renderProgress(progress),
    ...(stopped ? { blocked: { code: stopped.validationCode, message: progress.blocker } } : {}),
    next: stopped ? "Resolve the runtime blocker and resume checking the remaining claims."
      : signal.aborted || deferred.length ? "Resume with the same request or submit the remaining claims in a smaller batch."
        : failures.size ? `Correct failed claims in ${initialArtifacts.legacyInventory}, then check again.`
          : unchecked.length ? "Check the remaining claims before closing DISCOVER_LEGACY."
            : durable ? `Every claim is verified against the current inventory in ${DISCOVERY_CLAIMS_FILE}.`
              : "Every requested claim resolved as VERIFY_SLICES will capture it.",
  };
};

const unverified = (code, message, details) => {
  throw Object.assign(new Error(`${code}: ${message} Run migration_capture with mode "discovery" in batches until every pinned claim passes, then close DISCOVER_LEGACY again. Nothing was written.`),
    { validationCode: code, discoveryClaims: details });
};

/** Verify exact coverage and return the identity of the document actually judged. */
export const assertDiscoveryClaimsVerified = async (roots, root, state, legacy, inventory) => {
  const { targetRoot, legacyRoot } = roots;
  if (!usesUiCoverage(state) || state.currentStep !== "DISCOVER_LEGACY") return null;
  const expected = discoveryClaimsOf(legacy, (id) => unverified("DISCOVERY_CLAIMS_INVALID",
    `Appearance claim '${id}' is repeated in ${initialArtifacts.legacyInventory}.`, { duplicate: [id] }));
  if (expected.size === 0) return null;
  if (await moduleLockHeld(targetRoot, discoveryLockName(state))) {
    unverified("DISCOVERY_CAPTURE_ACTIVE", "An active browser check is publishing observations. Wait for its batch to finish.", {});
  }
  const all = [...expected.keys()];
  const { document: record, identity } = await readDiscoveryRecord(root);
  if (identity === null) {
    unverified("DISCOVERY_CLAIMS_UNVERIFIED", `${all.length} pinned appearance claim(s) have no successful discovery check (${DISCOVERY_CLAIMS_FILE} is absent).`, { missing: all });
  }
  if (!validRecord(record)) unverified("DISCOVERY_CLAIMS_INVALID", `${DISCOVERY_CLAIMS_FILE} is not an engine discovery check.`, {});
  const binding = await currentBinding(targetRoot, root, state, record.version);
  await assertLegacyClaimRevision(legacyRoot, state);
  if (inventory && binding.legacyInventory !== contentIdentity(inventory.file, inventory.bytes, { bytes: record.version === 2 })) {
    unverified("DISCOVERY_CLAIMS_STALE", "The legacy inventory moved during checkpoint validation.", { stale: ["legacyInventory"] });
  }
  const moved = Object.keys(binding).filter((key) => !same(record.binding[key], binding[key]));
  if (moved.length > 0) {
    unverified("DISCOVERY_CLAIMS_STALE", `${DISCOVERY_CLAIMS_FILE} was checked against a different ${moved.join(", ")} than the one being closed.`, { stale: moved });
  }
  if (record.contradicted !== undefined) {
    const ids = Array.isArray(record.contradicted) ? record.contradicted.map((item) => item?.appearanceClaimId) : [];
    unverified("DISCOVERY_CLAIMS_UNVERIFIED", `The latest discovery check failed claim(s) ${ids.join(", ") || "(unreadable)"}.`, { contradicted: ids });
  }
  const seen = new Set();
  const failed = [];
  for (const row of record.claims) {
    const id = row?.appearanceClaimId;
    if (seen.has(id)) unverified("DISCOVERY_CLAIMS_INVALID", `${DISCOVERY_CLAIMS_FILE} lists claim '${id}' more than once.`, { duplicate: [id] });
    seen.add(id);
    const check = expected.get(id);
    if (!check || (record.version === 2 && row.deps !== check.deps)) {
      unverified("DISCOVERY_CLAIMS_STALE", `${DISCOVERY_CLAIMS_FILE} has an obsolete observation for claim '${id}'.`, { stale: [id] });
    }
    try {
      judgeClaim(check.owner, check.claim, row.snapshot, record.capture.origin);
    } catch (error) {
      failed.push({ appearanceClaimId: id, message: error.message });
    }
  }
  const missing = all.filter((id) => !seen.has(id));
  if (missing.length > 0 || failed.length > 0) {
    unverified("DISCOVERY_CLAIMS_UNVERIFIED", [
      missing.length > 0 && `Unchecked claim(s): ${missing.join(", ")}.`,
      failed.length > 0 && `Failed claim(s): ${failed.map((item) => `${item.appearanceClaimId} (${item.message})`).join("; ")}.`,
    ].filter(Boolean).join(" "), { missing, failed });
  }
  return { identity, binding, version: record.version };
};

export const assertDiscoveryCheckUnchanged = async ({ targetRoot, legacyRoot }, root, state, verified) => {
  await assertLegacyClaimRevision(legacyRoot, state);
  if (!same(verified.binding, await currentBinding(targetRoot, root, state, verified.version)) ||
      (await readDiscoveryRecord(root)).identity !== verified.identity ||
      await moduleLockHeld(targetRoot, discoveryLockName(state))) {
    unverified("DISCOVERY_CLAIMS_STALE", "Discovery evidence or authority changed during checkpoint closure.", {});
  }
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
  const { plan, state, root, claim, uiBehavior, mismatch, result, resultFile, directory, bound } = prepared;
  const target = plan.role === "TARGET";
  const asEvidence = (entry) => ({ ...entry, reference: portablePath(path.relative(targetRoot, path.join(root, entry.reference))) });
  // Built, and refused if the contract fails, before the first byte is written.
  const snapshot = target ? targetProof({ snapshot: captured.snapshot, sliceId: state.activeSlice, traceId: bound.traceId, uiBehavior }) : captured.snapshot;
  const proof = asEvidence(await publish.file(`${directory}/${claim.id}.proof.json`, jsonBytes(snapshot)));
  const screenshot = asEvidence(await publish.file(`${directory}/${claim.id}.png`, captured.screenshot));
  const input = { state, sliceId: state.activeSlice, uiBehavior, mismatch, claim, plan, captured, files: { snapshot: proof, screenshot } };
  const row = target ? targetAppearanceRow({ ...input, implementationDigest: bound.implementationDigest }) : legacyAppearanceRow(input);
  await replaceDocument(targetRoot, path.join(root, resultFile), { ...result, uiEvidence: [...(result.uiEvidence ?? []), row] });
  return {
    files: [proof, screenshot],
    record: `${resultFile} uiEvidence[${(result.uiEvidence ?? []).length}]`,
    observed: { claim: claim.id, afterInteractionId: claim.afterInteractionId ?? null },
    limitations: captured.limitations,
    unresolved: [
      { field: "result", count: 1, need: `PASS only after confirming the ${plan.role} observation shows what the claim states; the capture observed it, it did not judge it.` },
      claim.afterInteractionId && { field: "interactions[].actual, interactions[].outcome", count: 2, need: `What the ${plan.role.toLowerCase()} interaction actually did, and PASS when that matches its expected outcome.` },
      target && visualAuthorityOf(state) && { field: "visualRowId", count: 1, need: "The visual acceptance row this capture answers, when one covers this behavior and state." },
    ].filter(Boolean),
    next: target
      ? `Complete the row, then validate the slice: it re-checks the proof, the bindings and the LEGACY/TARGET pair of claim '${claim.id}'.`
      : `Capture the TARGET row for claim '${claim.id}' with role TARGET at the same locator, compare ${captured.image.width}x${captured.image.height}, matte and color scheme; validation compares the two.`,
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
  const input = { targetRoot, moduleName: resolved.canonical, request: parsed, roots: { legacyRoot: registryData.legacyRoot, targetRoot } };
  const before = await prepare(input);
  if (parsed.mode === "discovery") {
    const execute = (prepared) => checkClaims({ roots: input.roots, prepared, parsed, resolved });
    if (before.state.currentStep !== "DISCOVER_LEGACY") return execute(before);
    const release = await acquireModuleLock(targetRoot, discoveryLockName(before.state), { timeoutMs: 100 })
      .catch((error) => refuseCapture("CAPTURE_CONFLICT", error.message));
    try {
      return await execute(await prepare(input));
    } finally {
      await release();
    }
  }
  const captured = await (parsed.session
    ? captureThroughBroker(await sessionBrokerOf(targetRoot), before.plan, parsed.role ?? "LEGACY")
    : captureInBrowser(before.plan));
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
