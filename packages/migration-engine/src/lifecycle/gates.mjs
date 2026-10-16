/**
 * Lifecycle: FINALIZE gate evidence -- the binding every evidence entry must
 * carry, the validation of `gates.json` against it, and the read-only preview
 * of that same binding (QW3). Moved out of `validation.mjs`, which may not
 * grow; one binding reader serves both, so the preview cannot drift from what
 * validation enforces.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { initialArtifacts } from "../formats/index.mjs";
import {
  assertArray,
  assertIsoTimestamp,
  assertNonEmpty,
  assertPlainObject,
  assertUniqueIds,
  dirtyManifest,
  gitRevision,
  isContentIdentity,
  isLexicallyWithin,
  isPlainObject,
  issueCollector,
  throwIssues,
} from "../shared/index.mjs";
import {
  assertEvidenceReference,
  evidencePathClaim,
  fileIdentity,
  readHistoryEvents,
  readJson,
  resolveEvidencePath,
} from "../store/index.mjs";
import { TARGET_DIRTY_SCOPE } from "../slices/index.mjs";
import { FINAL_GATES } from "./checkpoints.mjs";
import { readContext } from "./context.mjs";
import { assertCurrentOpenSpecAuthority } from "./openspec.mjs";
import { readState } from "./record.mjs";

// Contract 5 decision 1.3: typed Ponytail evidence, never a regex over prose.
const PONYTAIL_GATE_EVIDENCE = {
  full: [["SIMPLIFY_ONCE", "review"]],
  "full-audit": [
    ["SIMPLIFY_ONCE", "review"],
    ["PRECOMMIT_GATE", "audit"],
  ],
};

/** When `legacyRevision`/`requirementsAuthority` were last pinned, for the
 * gate-evidence freshness check. Both are fixed at bootstrap; `legacyRevision`
 * can move forward again via a `REFRESHED` history event. */
const pinnedInputTimestamps = async (root, state) => {
  const events = await readHistoryEvents(root);
  let legacyRevisionPinnedAt = state.createdAt;
  for (const event of events) {
    if (
      // A stale-evidence reopen (`from` FINALIZE/ACTIVE) never re-pins the
      // legacy revision, so it must not age the gate evidence bound to it.
      (event.event === "REFRESHED" ||
        (event.event === "UI_REMEDIATION_REOPENED" &&
          !["FINALIZE", "ACTIVE"].includes(event.from)) ||
        (event.event === "COMPLETE_REOPENED" && event.toLegacyRevision)) &&
      typeof event.at === "string"
    ) {
      if (
        legacyRevisionPinnedAt === undefined ||
        event.at > legacyRevisionPinnedAt
      ) {
        legacyRevisionPinnedAt = event.at;
      }
    }
  }
  return {
    requirementsAuthorityPinnedAt: state.createdAt,
    legacyRevisionPinnedAt,
  };
};

/** What every gate evidence entry's `boundTo` must equal now, and the instant its `producedAt` may not predate. */
export const gateBindingContext = async (root, state, roots) => {
  const currentLegacyRevision = await gitRevision(roots.legacyRoot);
  const currentTargetRevision = await gitRevision(roots.targetRoot);
  const currentLegacyDirty = await dirtyManifest(roots.legacyRoot);
  const currentTargetDirty = await dirtyManifest(
    roots.targetRoot,
    TARGET_DIRTY_SCOPE,
  );
  const { requirementsAuthorityPinnedAt, legacyRevisionPinnedAt } =
    await pinnedInputTimestamps(root, state);
  return {
    target: state.targetModule,
    legacyRevision: currentLegacyRevision.revision,
    targetRevision: currentTargetRevision.revision,
    requirementsDigest: state.requirementsAuthority.digest,
    dataSourceMode: state.dataSourceMode,
    legacyDirtyDigest: currentLegacyDirty.digest,
    targetDirtyDigest: currentTargetDirty.digest,
    freshSince:
      requirementsAuthorityPinnedAt > legacyRevisionPinnedAt
        ? requirementsAuthorityPinnedAt
        : legacyRevisionPinnedAt,
  };
};

// `boundTo` field -> the refusal when it disagrees with the current binding.
const BINDING_MISMATCH = {
  target: (label, recorded, current) =>
    `${label} is bound to target '${recorded}', which does not match the migration's current target '${current}'.`,
  legacyRevision: (label, recorded, current) =>
    `${label} is bound to legacy revision '${recorded}', which does not match the current legacy revision '${current}'. Evidence from a stale legacy revision never satisfies a gate.`,
  targetRevision: (label, recorded, current) =>
    `${label} is bound to target revision '${recorded}', which does not match the current target revision '${current}'. Evidence from a stale target revision never satisfies a gate.`,
  requirementsDigest: (label, recorded, current) =>
    `${label} is bound to requirements digest '${recorded}', which does not match the current requirements digest '${current}'. Evidence from a changed spec never satisfies a gate.`,
  dataSourceMode: (label, recorded, current) =>
    `${label} is bound to data-source mode '${recorded}', which does not match the migration's current data-source mode '${current}'. Mock-mode evidence never satisfies a standard-mode gate, or vice versa.`,
  legacyDirtyDigest: (label, recorded, current) =>
    `${label} is bound to legacy dirty-tree digest '${recorded}', which does not match the current uncommitted legacy tree '${current}'. Evidence from before an uncommitted legacy change never satisfies a gate.`,
  // Nothing is committed before FINALIZE, so `legacyRevision`/`targetRevision`
  // never move while a slice edits a file. Binding the dirty manifest too
  // means any uncommitted change to either tree -- even one no evidence entry
  // ever names -- invalidates evidence authored before it happened.
  targetDirtyDigest: (label, recorded, current) =>
    `${label} is bound to target dirty-tree digest '${recorded}', which does not match the current uncommitted target tree '${current}'. Evidence from before an uncommitted target change never satisfies a gate.`,
};

// Fix B (candidate change; analysis/inventory.md Defect "Gate evidence has no
// freshness, hash, or binding enforcement" / `references/migration-contract.md`
// "Final gates"): each evidence entry is a structured, bound record instead of
// an arbitrary string. Rejects an entry (and therefore the gate) when a
// required field is missing, when `boundTo` disagrees with the migration's
// current binding, when `producedAt` predates the most recently pinned legacy
// revision or requirements digest, or when a file reference's hash is not its
// current digest.
//
// QW3: each field is checked on its own, so one run reports every problem of
// the entry. A check runs only when what it reads is valid: no comparison
// against a missing `boundTo`, no freshness on an invalid timestamp, no hash
// comparison on a malformed hash.
const checkEvidenceEntry = async ({ add, check }, entry, label, context, roots) => {
  if (!(await check(label, () => assertPlainObject(entry, label)))) return;
  for (const field of ["kind", "reference"]) {
    await check(`${label}.${field}`, () => assertNonEmpty(entry[field], `${label}.${field}`));
  }
  const timed = await check(`${label}.producedAt`, () => assertIsoTimestamp(entry.producedAt, `${label}.producedAt`));
  for (const field of ["producer", "environment"]) {
    await check(`${label}.${field}`, () => assertNonEmpty(entry[field], `${label}.${field}`));
  }
  const hashed = isContentIdentity(entry.hash);
  if (!hashed) {
    add(`${label}.hash`, `${label}.hash must be a SHA-256 digest ('sha256:<64 hex>') of the referenced artifact, or of the reference string if it isn't a file.`);
  }
  if (await check(`${label}.boundTo`, () => assertPlainObject(entry.boundTo, `${label}.boundTo`))) {
    for (const [field, mismatch] of Object.entries(BINDING_MISMATCH)) {
      const at = `${label}.boundTo.${field}`;
      const recorded = entry.boundTo[field];
      if (field === "dataSourceMode") {
        if (!["standard", "mock"].includes(recorded)) {
          add(at, `${at} must be 'standard' or 'mock'.`);
          continue;
        }
      } else if (!(await check(at, () => assertNonEmpty(recorded, at)))) {
        continue;
      }
      if (recorded !== context[field]) {
        add(at, mismatch(label, recorded, context[field]), {
          code: "EVIDENCE_BINDING_STALE",
          cause: `boundTo.${field}=${recorded}`,
        });
      }
    }
  }
  if (timed && Date.parse(entry.producedAt) < Date.parse(context.freshSince)) {
    add(
      `${label}.producedAt`,
      `${label}.producedAt (${entry.producedAt}) predates the most recently pinned legacy revision or requirements digest (${context.freshSince}). Evidence timestamped before the thing it claims to satisfy was pinned is stale by construction.`,
      { code: "EVIDENCE_PRODUCED_BEFORE_PIN" },
    );
  }
  if (hashed && typeof entry.reference === "string") {
    await check(`${label}.reference`, () => assertEvidenceReference(entry, label, roots), {
      cause: `reference=${entry.reference}#${entry.hash}`,
    });
  }
};

export const validateGates = async (root, state, roots) => {
  // Prerequisites, fail-fast: without the document and its exact gate set
  // there is nothing whose rows could be checked independently.
  const document = assertPlainObject(
    await readJson(path.join(root, initialArtifacts.gates), "Final gates"),
    "Final gates",
  );
  const gates = assertArray(document.gates, "Final gates");
  const names = assertUniqueIds(
    gates.map((row) => ({ ...row, id: row.gate })),
    "Final gates",
  );
  if (
    names.size !== FINAL_GATES.length ||
    FINAL_GATES.some((gate) => !names.has(gate))
  ) {
    throw new Error(
      "gates.json must contain exactly the seven mandatory gates.",
    );
  }
  const bindingContext = await gateBindingContext(root, state, roots);

  const collector = issueCollector();
  const { add } = collector;
  for (const gate of gates) {
    if (gate.result !== "PASS") {
      add(`${gate.gate}.result`, `Gate ${gate.gate} is not PASS.`, { code: "GATE_NOT_PASS" });
    }
    if (
      !Number.isInteger(gate.attempts) ||
      gate.attempts < 1 ||
      gate.attempts > 3
    ) {
      add(`${gate.gate}.attempts`, `${gate.gate} attempts must be between 1 and 3.`);
    }
    if (!Array.isArray(gate.evidence)) {
      add(`${gate.gate}.evidence`, `${gate.gate}.evidence must be an array.`);
      continue;
    }
    if (gate.evidence.length === 0) {
      add(`${gate.gate}.evidence`, `${gate.gate} requires concrete evidence.`, { code: "GATE_EVIDENCE_MISSING" });
    }
    for (const [index, entry] of gate.evidence.entries()) {
      await checkEvidenceEntry(collector, entry, `${gate.gate}.evidence[${index}]`, bindingContext, roots);
    }
  }
  for (const [gateName, kind] of PONYTAIL_GATE_EVIDENCE[state?.ponytail] ??
    []) {
    const label = `${gateName}.ponytailEvidence`;
    const evidence = gates.find((row) => row.gate === gateName)?.ponytailEvidence;
    if (!isPlainObject(evidence)) {
      add(label, `Ponytail target '${state.ponytail}' requires gate ${gateName} to record a ponytailEvidence object of kind "${kind}".`, { code: "GATE_EVIDENCE_MISSING" });
      continue;
    }
    // The type/binding/freshness check runs too; Ponytail's `kind`
    // requirement is layered on top of it, never a substitute for it.
    await checkEvidenceEntry(collector, evidence, label, bindingContext, roots);
    if (evidence.kind !== kind) {
      add(`${label}.kind`, `Ponytail target '${state.ponytail}' requires gate ${gateName} to record ponytailEvidence of kind "${kind}", found "${evidence.kind}".`);
    }
  }
  throwIssues("gates.json", collector.issues);
  return gates;
};

/**
 * QW3. Read-only: the binding a gate evidence entry must carry right now, and
 * the current content identity of each named evidence file -- the values the
 * FINALIZE validation compares against, from the same readers, so they need
 * not be learned from a refusal. Takes no lock and writes nothing. It refuses
 * exactly where status does (pending transaction, broken integrity, changed
 * OpenSpec authority). A file it cannot resolve inside the legacy or target
 * repository gets no digest, so nothing outside them is read.
 */
export const previewEvidenceBinding = async ({ registryPath, moduleName, references = [] }) => {
  for (const reference of assertArray(references, "references")) assertNonEmpty(reference, "references[]");
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  const { state, root } = await readState(registryData.targetRoot, resolved.canonical);
  await assertCurrentOpenSpecAuthority(registryData.targetRoot, state);
  const roots = { legacyRoot: registryData.legacyRoot, targetRoot: registryData.targetRoot };
  const { freshSince, ...boundTo } = await gateBindingContext(root, state, roots);
  const repositories = await Promise.all([roots.legacyRoot, roots.targetRoot].map((root) => realpath(root)));
  return {
    module: resolved.canonical,
    currentStep: state.currentStep,
    boundTo,
    producedAtNotBefore: freshSince,
    references: await Promise.all(
      references.map(async (reference) => {
        const claim = evidencePathClaim(reference);
        const resolved = claim && (await resolveEvidencePath(claim, roots));
        // Stricter than validation's resolution on purpose: a digest is only
        // read for a file really inside one of the two repositories, never one
        // reached through their common parent or a symlink out of them.
        const real = resolved && (await realpath(resolved));
        const file = real && repositories.some((root) => isLexicallyWithin(root, real)) ? resolved : null;
        return file
          ? { reference, path: claim, hash: await fileIdentity(file) }
          : {
              reference,
              path: claim,
              hash: null,
              problem: claim
                ? `'${claim}' does not exist inside the legacy or target repository.`
                : "Not a file path; a reference that is not a file carries the digest of the reference string itself.",
            };
      }),
    ),
    note: "Values describe both trees now. Write every evidence file first, then read this, then write gates.json (the migration record is outside the dirty-tree scope). Any later change to either tree changes a dirty-tree digest; read it again.",
  };
};
