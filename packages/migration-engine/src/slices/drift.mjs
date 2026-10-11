import path from "node:path";
import {
  createNewFormatDecisionCandidate,
  readRecordedDecisions,
  requireModuleDecision,
} from "../decisions/index.mjs";
import {
  DISCOVERY_SCAN_FILE,
  initialArtifacts,
  usesDirectLedgerDecisions,
  usesSliceRework,
} from "../formats/index.mjs";
import { dirtyManifest } from "../shared/index.mjs";
import { hashFile, readJson, readOptionalJson } from "../store/index.mjs";
import {
  claimedTargetPaths,
  plannedTargetOwners,
  readTargetBaseline,
  TARGET_DIRTY_SCOPE,
  targetBaselineDrift,
  withinPlannedScope,
} from "./claims.mjs";
import { reworkAttemptsOf } from "./rework.mjs";

/* ------------------------------------------------------------------ *
 * W4. One ownership ledger for target bytes (format 16)
 *
 * `validateImplementedSlice` proves every *claimed* file is real, inside the
 * target, currently dirty and different from the pinned baseline. That is a
 * `claimed ⊆ actual` check, and the converse was never run: a target file this
 * migration modified but no slice declares was invisible to every checkpoint
 * and to FINALIZE.
 *
 * Once same-slice rework exists this gets materially worse, because "the tree
 * changed since the last checkpoint" stops being anomalous on its own. So the
 * distinction is decided from records -- never from prose and never from
 * timing.
 * ------------------------------------------------------------------ */

/**
 * W4-3: warn early, block late. Before VERIFY_SLICES no slice has claimed
 * anything, so an unclaimed path carries no information; blocking mid-flight
 * would also make ordinary editing hostile. FINALIZE is where the guarantee has
 * to hold.
 */
export const DRIFT_OWNERSHIP_STEPS = new Set(["VERIFY_SLICES", "FINALIZE"]);

export const DRIFT_CLASSES = Object.freeze({
  ENGINE_AUTHORED: "ENGINE_AUTHORED",
  AUTHORIZED_REWORK: "AUTHORIZED_REWORK",
  AUTHORIZED_DELEGATION: "AUTHORIZED_DELEGATION",
  OPERATOR_ACCEPTED: "OPERATOR_ACCEPTED",
  // Modified, inside a subtree some planned slice owns, and claimed by none of
  // them. This migration's business, and the only unaccounted class FINALIZE
  // refuses.
  UNCLAIMED_TARGET_DRIFT: "UNCLAIMED_TARGET_DRIFT",
  // Modified, and outside every subtree any planned slice owns.
  //
  // This used to be `UNCLAIMED_TARGET_DRIFT` as well, which made "the migration
  // cannot account for this file" and "somebody edited an unrelated file in
  // this repository" the same refusal. They are not the same fact, and
  // conflating them let an ordinary edit elsewhere in the target -- a README, a
  // sibling feature's work in progress -- hold COMPLETE hostage until a human
  // accepted a file the migration never touched.
  //
  // The engine reports these and does nothing else with them: it does not
  // claim them, accept them, modify them, or count them against the guarantee.
  // The guarantee is about bytes *this migration* changed, and these are not
  // those bytes.
  UNRELATED_USER_CHANGE: "UNRELATED_USER_CHANGE",
});

/**
 * W4-1/W4-2. The set difference over data the engine already holds -- no new
 * scan, no new cost -- and then a classification, because reporting an
 * unclaimed path without saying whose it is just moves the judgement to prose.
 */
/** One spelling, read by the finding and by the candidate resolved against it. */
export const UNDERIVABLE_OWNERSHIP_REASON =
  "the slice plan declares no target owner, so whether this path belongs to the migration cannot be derived; only a human can say";

/**
 * F6. The one spelling of a drift candidate's facts, read by the offer
 * (`pendingTargetDriftCandidates`) and by the FINALIZE resolver
 * (`acceptsDrift`), so the decision recorded over the offered candidate is the
 * decision FINALIZE resolves. Neither reads a finding's display `reason`:
 * whether an earlier acceptance went stale is an outcome of this resolution,
 * not an input to it. A deleted path digests as zeroes, so its deletion is
 * what gets accepted and recreating the file re-blocks like any edit.
 */
export const driftCandidateFacts = async (targetRoot, relative, autoResolvable) => ({
  pathDigest: `sha256:${await hashFile(path.join(targetRoot, relative)).catch(() => "0".repeat(64))}`,
  rationale: autoResolvable
    ? `${relative} was modified in the target but is claimed by no validated slice, no authorized rework, and no delegated artifact.`
    : UNDERIVABLE_OWNERSHIP_REASON,
});

/**
 * Track A4: a census fact a seam reads before slices/ needs it, kept settled so
 * a failed read is raised where the rule consumes it -- where it was read before
 * the extraction -- and never as an unhandled rejection.
 */
export const settleFact = (promise) =>
  promise.then((value) => ({ value }), (error) => ({ error }));

const factValue = (fact) => {
  if ("error" in fact) throw fact.error;
  return fact.value;
};

// `brownfield` and `legacySource` are census facts, supplied by the seam that
// calls in (`sliceDriftFacts` in `resumable-migration.mjs`).
export const classifyTargetDrift = async (
  root,
  state,
  roots,
  slices,
  { brownfield, legacySource },
) => {
  if (!usesSliceRework(state) || !roots?.targetRoot) return [];
  if (!DRIFT_OWNERSHIP_STEPS.has(state.currentStep)) return [];
  const dirty = await dirtyManifest(roots.targetRoot, TARGET_DIRTY_SCOPE);
  const baseline = await readTargetBaseline(root, brownfield);
  const changedSinceBaseline = baseline
    ? await targetBaselineDrift(roots.targetRoot, baseline)
    : null;
  const claimed = await claimedTargetPaths(root, slices, roots);

  // A slice under an active rework legitimately re-touches its own files.
  const reworked = new Set(
    Object.keys(state.sliceReworks ?? {}).filter(
      (sliceId) => reworkAttemptsOf(state, sliceId) > 0,
    ),
  );
  const reworkOwned = new Set();
  for (const sliceId of reworked) {
    const planned = slices.find((slice) => slice.id === sliceId);
    for (const owner of planned?.targetOwner
      ? [planned.targetOwner]
      : []) {
      reworkOwned.add(owner.replaceAll("\\", "/"));
    }
  }
  // A SHARED_PREREQUISITE with a live artifact delegation: the child record
  // owns those bytes and validates them under its own lifecycle.
  const delegatedOwners = slices
    .filter((slice) => slice.artifact || slice.delegatedTo)
    .map((slice) => String(slice.targetOwner ?? "").replaceAll("\\", "/"))
    .filter(Boolean);

  // W4-4/W4-5. The acceptance lives in the append-only operator ledger, never
  // in a CLI flag and never in a state field an agent could author. `boundTo`
  // carries the path's SHA-256, so editing the file after acceptance
  // invalidates the decision the same way a changed candidate invalidates a
  // classification approval.
  const { decisions } = await readRecordedDecisions(root);
  const accepted = new Map(
    decisions
      .filter(
        (decision) =>
          decision.kind === "TARGET_DRIFT_ACCEPTED" &&
          typeof decision.subject?.path === "string" &&
          // Pre-19 reads exactly as it always did. At 19 the map is only a
          // prefilter -- `acceptsDrift` below re-derives the full candidate and
          // resolves it, so a line that merely names the path authorizes
          // nothing.
          (!usesDirectLedgerDecisions(state) || decision.v === 2),
      )
      .map((decision) => [decision.subject.path, decision.boundTo?.pathDigest]),
  );

  // The module binding a format-19 drift candidate is digested over, taken from
  // the record's own pinned discovery scan rather than from a fresh one: drift
  // is classified on read-only paths too, and re-scanning there would make
  // status execute the scanner. FINALIZE proves the pin is still current
  // (`assertDiscoveryUnchanged`) before it holds anyone to it.
  const driftBinding = usesDirectLedgerDecisions(state)
    ? await (async () => {
        const pinned = await readOptionalJson(
          path.join(root, DISCOVERY_SCAN_FILE),
          "Discovery scan",
        );
        return {
          module: state.migrationId,
          ...factValue(legacySource),
          discoveryDigest: pinned?.discoveryDigest,
          algorithmVersion: pinned?.algorithmVersion,
        };
      })()
    : null;

  /**
   * Whether an operator decision actually authorizes this drifted path, at this
   * record's format. Pre-19: the historical byte comparison. 19: the same
   * byte binding *and* the full direct-ledger resolution -- candidate digest,
   * pinned policy, required principal, group authority, no receipt.
   */
  const acceptsDrift = async (relative) => {
    const { pathDigest, rationale } = await driftCandidateFacts(roots.targetRoot, relative, autoResolvable);
    if (!usesDirectLedgerDecisions(state)) {
      return pathDigest === accepted.get(relative);
    }
    // Format 19 only (returned above otherwise), where the census
    // `moduleDecisionCandidate` is exactly the format-19 decisions builder.
    const candidate = await createNewFormatDecisionCandidate({
      projectRoot: roots.targetRoot,
      kind: "TARGET_DRIFT_ACCEPTED",
      subjectType: "TARGET_FILE",
      subjectPath: relative,
      rationale,
      boundTo: { ...driftBinding, pathDigest },
    });
    try {
      await requireModuleDecision({
        state,
        decisions,
        row: null,
        label: `Target drift '${relative}'`,
        candidate,
      });
      return true;
    } catch {
      // A refusal here is "not accepted", which the caller already reports as
      // unclaimed drift with its own message. The resolver's reason surfaces
      // through the pending-decision projection, not by failing the scan.
      return false;
    }
  };

  // Target files the *record itself* authored, not any slice: the OpenSpec
  // requirements authority the bootstrap writes, and the brief it was given.
  // They are accounted for by `requirementsAuthority.digest` and the brief pin
  // rather than by a slice, so counting them as unattributable drift would make
  // FINALIZE unreachable for every migration by construction.
  const engineAuthored = new Set(
    [state.requirementsAuthority?.source, state.brief?.path]
      .filter((value) => typeof value === "string" && value)
      .map((value) => value.replaceAll("\\", "/")),
  );

  const owners = plannedTargetOwners(slices);
  // Whether ownership is a question this record can answer at all. With owners,
  // "inside the migration's scope" and "outside it" are both decidable, and a
  // finding that lands inside is deterministic drift the AUTO principal may
  // resolve. With none, neither answer is derivable -- so every finding stays
  // unclaimed *and* stays a human decision. Ambiguity is the one drift case
  // `--mode auto` must not decide, and this is where that is recorded.
  const autoResolvable = owners.length > 0;
  const laterOwners = plannedTargetOwners(
    slices.filter(
      (slice) =>
        slice.id !== state.activeSlice &&
        (state.pendingSlices ?? []).includes(slice.id),
    ),
  );
  const withinLaterSlice = (relative) =>
    laterOwners.length > 0 && withinPlannedScope(relative, laterOwners);
  const findings = [];
  for (const entry of dirty.entries) {
    const relative = entry.path.replaceAll("\\", "/");
    if (claimed.has(relative)) continue;
    if (engineAuthored.has(relative)) {
      findings.push({ path: relative, class: DRIFT_CLASSES.ENGINE_AUTHORED });
      continue;
    }
    // Outside every owned subtree: somebody else's edit. Ordered ahead of the
    // rework, delegation and acceptance branches so a path this migration never
    // owned cannot pick up a claim from one of them by accident.
    if (!withinPlannedScope(relative, owners)) {
      findings.push({
        path: relative,
        class: DRIFT_CLASSES.UNRELATED_USER_CHANGE,
        reason:
          "modified outside every target subtree this migration's slice plan owns; preserved and not attributed to this migration",
      });
      continue;
    }
    // Not drift yet: a later pending slice still scopes this path, and its own
    // IMPLEMENT gate (`unlistedSliceFiles`) asks that slice to list it.
    if (withinLaterSlice(relative)) continue;
    // Brownfield: already dirty before the migration started and unchanged
    // since is not this migration's doing.
    if (changedSinceBaseline && !changedSinceBaseline(relative)) continue;
    if ([...reworkOwned].some((owner) => relative.startsWith(owner))) {
      findings.push({ path: relative, class: DRIFT_CLASSES.AUTHORIZED_REWORK });
      continue;
    }
    if (delegatedOwners.some((owner) => relative.startsWith(owner))) {
      findings.push({
        path: relative,
        class: DRIFT_CLASSES.AUTHORIZED_DELEGATION,
      });
      continue;
    }
    if (accepted.has(relative)) {
      // W4-5: the acceptance binds to the bytes. Editing the file after
      // acceptance invalidates the decision, exactly as a classification
      // approval stops applying when its candidate changes.
      if (await acceptsDrift(relative)) {
        findings.push({ path: relative, class: DRIFT_CLASSES.OPERATOR_ACCEPTED });
        continue;
      }
      findings.push({
        path: relative,
        class: DRIFT_CLASSES.UNCLAIMED_TARGET_DRIFT,
        autoResolvable,
        reason:
          "an operator accepted this path, but its bytes changed since; the acceptance no longer applies",
      });
      continue;
    }
    findings.push({
      path: relative,
      class: DRIFT_CLASSES.UNCLAIMED_TARGET_DRIFT,
      autoResolvable,
      ...(autoResolvable ? {} : { reason: UNDERIVABLE_OWNERSHIP_REASON }),
    });
  }
  return findings;
};

/**
 * The IMPLEMENT gate's candidates: the paths VERIFY_SLICES would report as
 * unclaimed drift inside the active slice's planned scope, with the slice
 * record they would be listed in, or null when the gate does not apply. Which
 * of them the slice *could* list is the `unlistedSliceFiles` seam's question,
 * because it revalidates the implementation (Track A4).
 */
export const unlistedSliceCandidates = async (root, state, roots, sliceId, facts) => {
  if (!usesSliceRework(state) || !roots?.targetRoot) return null;
  const plan = await readOptionalJson(path.join(root, initialArtifacts.slices), "Slice index");
  const slices = Array.isArray(plan?.slices) ? plan.slices : [];
  const scope = plannedTargetOwners(slices.filter((slice) => slice.id === sliceId));
  if (scope.length === 0) return null;
  const record = await readJson(path.join(root, `slices/${sliceId}.json`), `Slice ${sliceId}`);
  // Classified as the VERIFY_SLICES this advance enters will classify it.
  const findings = await classifyTargetDrift(
    root,
    { ...state, currentStep: "VERIFY_SLICES" },
    roots,
    slices,
    facts,
  );
  return {
    record,
    candidates: unclaimedTargetDrift(findings)
      .map(({ path: relative }) => relative)
      .filter((relative) => withinPlannedScope(relative, scope)),
  };
};

/**
 * The drift candidates an operator may accept, derived under the same rules
 * `classifyTargetDrift` applies. Exported for `record-decision.mjs`, which owns
 * every approval; nothing here records anything.
 */
export const pendingTargetDriftCandidates = async (root, state, roots, facts) => {
  // Only where drift is a meaningful question. Before slices exist nothing can
  // have claimed a file yet, so every modified path would read as unclaimed and
  // the operator would be asked to accept the migration's own work.
  if (!DRIFT_OWNERSHIP_STEPS.has(state.currentStep)) return [];
  if (!usesSliceRework(state) || !roots?.targetRoot) return [];
  const plan = await readOptionalJson(
    path.join(root, initialArtifacts.slices),
    "Slice index",
  );
  const slices = Array.isArray(plan?.slices) ? plan.slices : [];
  const unclaimed = unclaimedTargetDrift(
    await classifyTargetDrift(root, state, roots, slices, facts),
  );
  return Promise.all(
    unclaimed.map(async (finding) => ({
      subjectPath: finding.path,
      // Carried, not recomputed: whether ownership was derivable is a fact
      // about the plan `classifyTargetDrift` already read, and re-deriving it
      // here is how the two answers drift apart.
      autoResolvable: finding.autoResolvable !== false,
      ...(await driftCandidateFacts(roots.targetRoot, finding.path, finding.autoResolvable !== false)),
    })),
  );
};

export const unclaimedTargetDrift = (findings) =>
  findings.filter(
    (finding) => finding.class === DRIFT_CLASSES.UNCLAIMED_TARGET_DRIFT,
  );

/**
 * W4-3. Blocking mid-flight would make ordinary editing hostile, so
 * VERIFY_SLICES only reports. FINALIZE is the guarantee that matters: COMPLETE
 * must mean every byte this migration changed is accounted for by a validated
 * slice, an authorized rework, an authorized delegation, or a ledger-backed
 * operator acceptance.
 */
export const assertNoUnclaimedTargetDrift = async (
  root,
  state,
  roots,
  slices,
  facts,
  // The transport's command renderer, injected like A3's `approveCommand`.
  engineCommand,
) => {
  const unclaimed = unclaimedTargetDrift(
    await classifyTargetDrift(root, state, roots, slices, facts),
  );
  if (unclaimed.length === 0) return;
  throw new Error(
    `UNCLAIMED_TARGET_DRIFT: ${unclaimed.length} modified target file(s) are attributable to no validated slice, no authorized rework, no delegated artifact, and no operator acceptance: ${unclaimed
      .map((finding) =>
        finding.reason ? `${finding.path} (${finding.reason})` : finding.path,
      )
      .join(
        ", ",
      )}. Two exits, both legitimate: claim each file in the slice it belongs to with '${engineCommand(
      "cli/discover-module.mjs",
      "<module>",
      "--amend-slice",
      "<slice>",
      "--add-file",
      "<path>",
    )}' -- add-only, at least one --add-file, on a reopened slice -- or record a TARGET_DRIFT_ACCEPTED operator decision for it. COMPLETE must mean every byte this migration changed is accounted for.`,
  );
};
