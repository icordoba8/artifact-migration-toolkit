import path from "node:path";
import {
  createDecisionCandidate,
  createNewFormatDecisionCandidate,
  edgeDecisionSubject,
  readRecordedDecisions,
  requireModuleDecision,
} from "../decisions/index.mjs";
import { initialArtifacts, usesDirectLedgerDecisions } from "../formats/index.mjs";
import { assertArray, assertNonEmpty, assertPlainObject, isPlainObject } from "../shared/index.mjs";
import { readJson } from "../store/index.mjs";
import {
  assertLegacyEvidenceWithinBoundary,
  implicitModuleRoots,
  readCanonicalModuleBoundary,
} from "./boundary.mjs";
import { assertEvidenceChecklist } from "./inventory.mjs";
import { legacySourceBinding } from "./sources.mjs";

/* ------------------------------------------------------------------ *
 * DISCOVERY_COMPLETENESS
 *
 * DISCOVER_LEGACY runs every check in one direction: declared evidence ->
 * the file exists. Nothing ran the other way, so an unmentioned file was
 * indistinguishable from a nonexistent one, and a file could be discussed in
 * step prose, consciously dropped, and produce zero behaviors, zero parity
 * rows, and zero approvals. This checkpoint runs the missing direction: the
 * file exists -> what does the inventory say about it?
 * ------------------------------------------------------------------ */

export const CLASSIFICATION_SCOPES = [
  "OWNED",
  "SUPPORTING",
  "INBOUND_CONSUMER",
  "GOVERNING_FRAMEWORK",
  "EXTERNAL",
  "UNRESOLVED",
];

export const DISPOSITIONS = [
  "BEHAVIOR_BACKED",
  "INFRASTRUCTURE_ONLY",
  "NO_OBSERVABLE_BEHAVIOR",
  "DEAD",
  "EXCLUDED_APPROVED",
];

/** Dispositions an operator, and only an operator, can grant. */
export const DECISION_BACKED_DISPOSITIONS = {
  DEAD: "DEAD_CONFIRMATION",
  EXCLUDED_APPROVED: "EXCLUSION",
};

/**
 * The mandatory safeguard. A user can see these; "no observable behavior" and
 * "infrastructure only" are exactly the claims that made a decorative
 * component vanish from a migration in the first place, and an agent must
 * never be able to make that claim about something on screen by itself.
 */
export const AGENT_DISMISSIBLE = new Set([
  "NO_OBSERVABLE_BEHAVIOR",
  "INFRASTRUCTURE_ONLY",
]);

/**
 * The candidate a module decision gate binds to, at whichever format the record
 * actually is. Pre-19 keeps the unbound legacy candidate byte for byte; 19
 * binds the trusted policy identity, digest and required principal into the
 * candidate's own digest, so an approval recorded under a different policy
 * cannot apply to it.
 */
export const moduleDecisionCandidate = (state, projectRoot, input) =>
  usesDirectLedgerDecisions(state)
    ? createNewFormatDecisionCandidate({ projectRoot, ...input })
    : createDecisionCandidate(input);

export const validateDiscoveryCompleteness = async (
  root,
  state,
  roots,
  { scan: precomputed } = {},
) => {
  const { VISUAL_KINDS, PRODUCTION_REACHABILITY } =
    await import("./scan.mjs");
  const { classification, declaredRoots, scan } =
    await readCanonicalModuleBoundary(root, state, roots, {
      scan: precomputed,
    });
  const { byId, decisions: ledger } = await readRecordedDecisions(root);
  // The canonical migration identity, not `state.legacyModule`: the recorder
  // binds every approval to `migrationId`, so validation has to recompute the
  // candidate under the same key or a multi-source record (where `migrationId
  // === targetModule` but `legacyModule === legacySources[0]`) could never
  // match an approved APP id. Identical at format <= 14, where
  // `migrationId === legacyModule`.
  //
  // Every binding an approval is checked against now lives here and nowhere
  // else: `requireDecision` reads the discovery digest and legacy source off
  // the candidate, so validation and the recorder cannot drift apart.
  const candidateBoundTo = {
    module: state.migrationId,
    ...(await legacySourceBinding(roots.legacyRoot)),
    discoveryDigest: scan.discoveryDigest,
    algorithmVersion: scan.algorithmVersion,
  };

  // C9: at most one root per declared source may be implicit -- the slice that
  // source is named after (`implicitModuleRoots`). Every additional root widens
  // the module's boundary, and widening it is an operator decision, not an
  // agent's.
  const implicitRoots = implicitModuleRoots(state, declaredRoots, scan.moduleRoots);
  for (const [index, entry] of declaredRoots.entries()) {
    const label = `moduleRoots[${index}]`;
    const rootPath = assertNonEmpty(
      isPlainObject(entry) ? entry.path : entry,
      `${label}.path`,
    );
    assertNonEmpty(
      isPlainObject(entry) ? entry.reason : null,
      `${label}.reason`,
    );
    if (implicitRoots.has(rootPath)) continue;
    await requireModuleDecision({
      state,
      byId,
      decisions: ledger,
      row: {
        decisionId: entry.decisionId,
        decisionDigest: entry.decisionDigest,
      },
      label,
      // Built exactly as `record-decision.mjs` builds the candidate it
      // challenges on, at every scanner version: same kind, subject type,
      // rationale normalization and binding, so the same id comes out.
      candidate: await moduleDecisionCandidate(state, roots.targetRoot, {
        kind: "ROOT_DECLARATION",
        subjectType: "MODULE_ROOT",
        subjectPath: rootPath,
        rationale: entry.reason ?? "",
        boundTo: candidateBoundTo,
      }),
    });
  }

  const inventory = await readJson(
    path.join(root, initialArtifacts.legacyInventory),
    "Legacy inventory",
  );
  await assertLegacyEvidenceWithinBoundary(inventory, scan, roots);
  const behaviorIds = new Set(
    (inventory.behaviors ?? []).map((behavior) => behavior?.id),
  );
  const flowIds = new Set((inventory.routeFlows ?? []).map((flow) => flow?.id));

  const rows = assertArray(classification.files, "Module classification files");
  const seen = new Map();
  const censusSet = new Set(scan.census);
  const edgeSources = new Map();
  for (const edge of scan.edges) {
    if (!edgeSources.has(edge.to)) edgeSources.set(edge.to, new Set());
    edgeSources.get(edge.to).add(edge.from);
  }

  for (const [index, row] of rows.entries()) {
    const label = `files[${index}]`;
    assertPlainObject(row, label);
    const filePath = assertNonEmpty(row.path, `${label}.path`);
    // C2: a row for a file the census does not contain is either a typo or an
    // attempt to satisfy C1 without touching the real file.
    if (!censusSet.has(filePath)) {
      throw new Error(
        `${label} classifies '${filePath}', which is not in the module census (${scan.census.length} file(s) under ${scan.moduleRoots.join(", ")}). Classify only files the module owns; a file outside the roots belongs in 'supporting'.`,
      );
    }
    if (seen.has(filePath)) {
      throw new Error(
        `Module classification records '${filePath}' twice (${seen.get(filePath)} and ${label}).`,
      );
    }
    seen.set(filePath, label);
    if (row.scope !== "OWNED") {
      throw new Error(
        `${label}.scope must be 'OWNED' for a census file; got '${row.scope}'. Valid scopes are ${CLASSIFICATION_SCOPES.join(", ")}.`,
      );
    }
    // reachability and kind are computed, never authored: otherwise the
    // safeguard below is defeated by relabelling a visible component
    // UNREACHABLE.
    const reachability = scan.reachability[filePath];
    if (row.reachability !== reachability) {
      throw new Error(
        `${label}.reachability records '${row.reachability}', but the scan computes '${reachability}'. Reachability is derived, not declared.`,
      );
    }
    const kind = scan.kinds[filePath];
    if (row.kind !== kind) {
      throw new Error(
        `${label}.kind records '${row.kind}', but '${filePath}' is a ${kind}.`,
      );
    }
    for (const source of assertArray(
      row.reachedFrom ?? [],
      `${label}.reachedFrom`,
    )) {
      if (!edgeSources.get(filePath)?.has(source)) {
        throw new Error(
          `${label}.reachedFrom names '${source}', which does not reference '${filePath}' in the scanned graph.`,
        );
      }
    }
    if (!DISPOSITIONS.includes(row.disposition)) {
      throw new Error(
        `${label}.disposition must be one of ${DISPOSITIONS.join(", ")}; got ${JSON.stringify(row.disposition)}. Prose is not a disposition.`,
      );
    }
    // The mandatory safeguard.
    if (
      VISUAL_KINDS.has(kind) &&
      PRODUCTION_REACHABILITY.has(reachability) &&
      AGENT_DISMISSIBLE.has(row.disposition)
    ) {
      throw new Error(
        `${label} ('${filePath}') is a production-reachable ${kind} classified ${row.disposition} on agent-authored rationale alone. A ${kind} a user can reach is BEHAVIOR_BACKED with a real behavior id, or EXCLUDED_APPROVED with an operator decision recorded at a terminal. Rationale is never enough for something on screen.`,
      );
    }
    if (row.disposition === "BEHAVIOR_BACKED") {
      const cited = [
        ...assertArray(row.behaviorIds ?? [], `${label}.behaviorIds`),
        ...assertArray(row.routeFlowIds ?? [], `${label}.routeFlowIds`),
      ];
      if (cited.length === 0) {
        throw new Error(
          `${label} is BEHAVIOR_BACKED but cites no behaviorIds or routeFlowIds.`,
        );
      }
      for (const id of cited) {
        if (!behaviorIds.has(id) && !flowIds.has(id)) {
          throw new Error(
            `${label} cites '${id}', which ${initialArtifacts.legacyInventory} does not define.`,
          );
        }
      }
      continue;
    }
    assertNonEmpty(row.rationale, `${label}.rationale`);
    await assertEvidenceChecklist(
      row.evidence,
      `${label}.evidence`,
      roots,
      state?.requirementsAuthority,
    );
    const expectedKind = DECISION_BACKED_DISPOSITIONS[row.disposition];
    if (expectedKind) {
      await requireModuleDecision({
        state,
        byId,
        decisions: ledger,
        row,
        label,
        candidate: await moduleDecisionCandidate(state, roots.targetRoot, {
          kind: expectedKind,
          subjectType: "FILE",
          subjectPath: filePath,
          rationale: row.rationale ?? "",
          boundTo: candidateBoundTo,
        }),
      });
    }
    if (
      row.disposition === "DEAD" &&
      !row.evidence.some(
        (item) =>
          item?.category === "RUNTIME_OBSERVATION" &&
          item?.status === "PRESENT",
      )
    ) {
      throw new Error(
        `${label} is DEAD but records no PRESENT RUNTIME_OBSERVATION evidence. "Nothing imports it" is a graph fact, not proof it never runs.`,
      );
    }
  }

  // C1: the decisive check. Every file the census found, whether anything
  // imports it or not, must have been classified.
  const missing = scan.census.filter((filePath) => !seen.has(filePath));
  if (missing.length > 0) {
    throw new Error(
      `Module classification omits ${missing.length} file(s) the census found under ${scan.moduleRoots.join(", ")}: ${missing.join(", ")}. Every owned file needs a disposition, including files nothing imports. An unmentioned file is not an excluded file.`,
    );
  }

  // C4: what the module needs from outside its roots is recorded, so a
  // "supporting" file cannot be quietly relied on and then left behind.
  const supportingRows = new Map();
  for (const [index, row] of assertArray(
    classification.supporting ?? [],
    "Module classification supporting",
  ).entries()) {
    const label = `supporting[${index}]`;
    const filePath = assertNonEmpty(row?.path, `${label}.path`);
    if (supportingRows.has(filePath)) {
      throw new Error(
        `Module classification records supporting file '${filePath}' twice.`,
      );
    }
    supportingRows.set(filePath, { row, label });
  }
  const computedSupporting = new Map(
    (scan.boundary?.supporting ?? []).map((entry) => [entry.path, entry]),
  );
  for (const filePath of scan.supporting) {
    const entry = supportingRows.get(filePath);
    if (!entry) {
      throw new Error(
        `Module classification omits supporting file '${filePath}', which an owned file requires (required by ${(scan.requiredBy[filePath] ?? []).join(", ")}). It sits outside the declared roots, so it needs no disposition -- but it must be recorded.`,
      );
    }
    const declared = assertArray(
      entry.row.requiredBy ?? [],
      `${entry.label}.requiredBy`,
    );
    if (declared.length === 0) {
      throw new Error(
        `${entry.label}.requiredBy must name at least one requiring file.`,
      );
    }
    if (scan.algorithmVersion >= 2) {
      const computed = computedSupporting.get(filePath);
      if ((entry.row.relation ?? entry.row.scope) !== "SUPPORTING") {
        throw new Error(`${entry.label}.relation must be 'SUPPORTING'.`);
      }
      if (entry.row.type !== computed?.type) {
        throw new Error(
          `${entry.label}.type records '${entry.row.type}', but the canonical boundary computes '${computed?.type}'.`,
        );
      }
      if (
        JSON.stringify([...declared].sort()) !==
        JSON.stringify(scan.requiredBy[filePath] ?? [])
      ) {
        throw new Error(
          `${entry.label}.requiredBy must exactly match the canonical boundary evidence for '${filePath}'.`,
        );
      }
    }
    for (const requirer of declared) {
      if (!(scan.requiredBy[filePath] ?? []).includes(requirer)) {
        throw new Error(
          `${entry.label}.requiredBy names '${requirer}', which does not require '${filePath}' in the scanned graph.`,
        );
      }
    }
  }
  for (const [filePath, entry] of supportingRows) {
    if (!scan.supporting.includes(filePath)) {
      throw new Error(
        `${entry.label} classifies '${filePath}' as SUPPORTING, but the canonical boundary has no supporting relation to it. Shared files do not become dependencies by declaration.`,
      );
    }
  }

  // C5: an unresolved first-party reference is a hole in the graph, and a hole
  // in the graph is exactly where a missed file hides.
  if (scan.unresolved.length > 0) {
    throw new Error(
      `${scan.unresolved.length} first-party reference(s) could not be resolved: ${scan.unresolved
        .map((entry) => `${entry.from} -> '${entry.spec}'`)
        .join(
          "; ",
        )}. Fix the specifier, or record why it resolves to nothing first-party.`,
    );
  }
  for (const [index, entry] of assertArray(
    classification.unresolvedReferences ?? [],
    "unresolvedReferences",
  ).entries()) {
    assertPlainObject(entry, `unresolvedReferences[${index}]`);
    assertNonEmpty(entry.reason, `unresolvedReferences[${index}].reason`);
  }

  // C6: an edge whose target cannot be proven is not a resolved edge.
  const findingRows = new Map(
    assertArray(classification.findings ?? [], "findings").map((row, index) => [
      assertNonEmpty(row?.id, `findings[${index}].id`),
      { row, label: `findings[${index}]` },
    ]),
  );
  for (const finding of scan.findings) {
    const entry = findingRows.get(finding.id);
    if (!entry) {
      throw new Error(
        `Unresolved ${finding.type} at ${finding.file}:${finding.line} ('${finding.spec}') has no ${finding.id} row in the classification. The scan cannot prove where this edge lands; resolve it explicitly.`,
      );
    }
    if (finding.type === "I18N_NAMESPACE") {
      if (scan.algorithmVersion >= 2) {
        throw new Error(
          `${finding.id} namespace '${finding.spec}' at ${finding.file}:${finding.line} has no proven runtime resource. Add the tracked namespace mapping to governing i18n configuration; an authored path is not proof.`,
        );
      }
      const resolution = assertNonEmpty(
        entry.row.resolution,
        `${entry.label}.resolution`,
      );
      if (!censusSet.has(resolution) && !scan.supporting.includes(resolution)) {
        throw new Error(
          `${entry.label}.resolution '${resolution}' is neither an owned nor a supporting file. Map the namespace to the resource that actually backs it.`,
        );
      }
      const cited = assertArray(
        entry.row.behaviorIds ?? [],
        `${entry.label}.behaviorIds`,
      );
      if (cited.length === 0) {
        throw new Error(
          `${entry.label} maps namespace '${finding.spec}' to '${resolution}' but cites no behavior. Translated copy is observable behavior.`,
        );
      }
      for (const id of cited) {
        if (!behaviorIds.has(id) && !flowIds.has(id)) {
          throw new Error(
            `${entry.label} cites '${id}', which ${initialArtifacts.legacyInventory} does not define.`,
          );
        }
      }
      continue;
    }
    if (scan.algorithmVersion >= 2) {
      const targets = assertArray(entry.row.targets, `${entry.label}.targets`);
      if (targets.length === 0) {
        throw new Error(
          `${entry.label} must name at least one concrete tracked target for ${finding.type}; prose or approval alone never resolves a module edge.`,
        );
      }
      if (
        JSON.stringify([...targets].sort()) !==
        JSON.stringify(finding.resolvedTargets ?? [])
      ) {
        throw new Error(
          `${entry.label}.targets do not match the scanner's concrete tracked targets for ${finding.id}. Re-run discovery and use its current targets.`,
        );
      }
    }
    await requireModuleDecision({
      state,
      byId,
      decisions: ledger,
      row: {
        decisionId: entry.row.decisionId,
        decisionDigest: entry.row.decisionDigest,
      },
      label: entry.label,
      candidate: await moduleDecisionCandidate(state, roots.targetRoot, {
        kind: "EDGE_RESOLUTION",
        // The pre-2 scanner has no edge identity, so its subject is the file --
        // which is exactly what `record-decision.mjs` challenges on there too.
        subjectType: scan.algorithmVersion >= 2 ? "MODULE_EDGE" : "FILE",
        subjectPath:
          scan.algorithmVersion >= 2
            ? edgeDecisionSubject(finding)
            : finding.file,
        rationale: entry.row.resolution ?? entry.row.rationale ?? "",
        targets: finding.resolvedTargets ?? [],
        boundTo: candidateBoundTo,
      }),
    });
  }
  for (const [findingId, entry] of findingRows) {
    if (!scan.findings.some((finding) => finding.id === findingId)) {
      throw new Error(
        `${entry.label} names stale finding '${findingId}'. Re-run discovery and remove or replace the stale row.`,
      );
    }
  }

  return { classification, scan };
};
