/**
 * Lifecycle: MC1 engine prefill. Writes the mechanical part of the current
 * checkpoint's authored artifact straight into the record, so an agent never
 * transcribes a scan, a pinned measurement or a binding through its own output.
 *
 * Engine owns mechanics, agent owns judgments, operator owns decisions:
 * - only values a validator re-derives from an authority it already trusts are
 *   written (the scan, the pinned legacy-runtime capture, the gate binding, a
 *   file's content identity);
 * - every judgment is left `null` -- never a placeholder string, which a
 *   non-empty check would accept -- so the draft is refused until authored;
 * - nothing authored is overwritten or removed, and nothing is pinned, advanced,
 *   approved or appended. Validation stays the only authority on the result.
 *
 * Explicit and writing, unlike `--scan` and `--evidence-binding`: one atomic
 * replace-write of one record file, under the module lock, after every input
 * has been read and checked, so a refusal leaves no byte changed.
 */
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { readCanonicalModuleBoundary, withUiRemediation } from "../census/index.mjs";
import {
  initialArtifacts,
  LEGACY_RUNTIME_CONTEXT_FILE,
  MODULE_CLASSIFICATION_FILE,
  VISUAL_ACCEPTANCE_FILE,
} from "../formats/index.mjs";
import { assertPlainObject, dirtyManifest, execFileAsync, isPlainObject } from "../shared/index.mjs";
import { TARGET_DIRTY_SCOPE } from "../slices/index.mjs";
import {
  atomicWrite,
  evidencePathClaim,
  fileExists,
  readJson,
  resolveEvidencePath,
} from "../store/index.mjs";
import {
  HARDENED_VISUAL_VERSION,
  REQUIRED_FACT_KINDS,
  REQUIRED_FACT_NAMES,
  uiBehaviorIsRequired,
  usesVisualContract,
  visualAuthorityOf,
} from "../visual/index.mjs";
import { readContext } from "./context.mjs";
import {
  gateBindingContext,
  PONYTAIL_GATE_EVIDENCE,
  referenceDigest,
  repositoryRealpaths,
} from "./gates.mjs";
import { withModuleLock } from "./lock.mjs";
import { assertCurrentOpenSpecAuthority } from "./openspec.mjs";
import { readState } from "./record.mjs";

const refuse = (message) => {
  throw Object.assign(new Error(`PREFILL_REFUSED: ${message} Nothing was written.`), { validationCode: "PREFILL_REFUSED" });
};

/** An authored list, or an empty one when absent; never a replaced non-list. */
const listOf = (document, key, label) => {
  if (document[key] === undefined) return [];
  if (!Array.isArray(document[key])) refuse(`${label}.${key} is authored but is not an array; prefill never replaces authored content.`);
  return document[key];
};

/** Leaf values written by the engine; `null` is a slot left for authoring. */
const leaves = (value) =>
  value === null
    ? 0
    : Array.isArray(value) || isPlainObject(value)
      ? Object.values(value).reduce((sum, item) => sum + leaves(item), 0)
      : 1;

const missing = (value) => value === undefined || value === null;

/* DISCOVERY_COMPLETENESS: rows the canonical scan computes; dispositions are judgments. */
const classificationDraft = async ({ root, state, roots }) => {
  // The one boundary loader validation uses: same recorded scanner version,
  // same declared roots and edge targets, same format-20 algorithm-4 rule.
  const { classification, scan } = await readCanonicalModuleBoundary(root, state, roots);
  const label = "Module classification";
  const files = listOf(classification, "files", label);
  const supporting = listOf(classification, "supporting", label);
  const classified = new Map(files.filter(isPlainObject).map((row) => [row.path, row]));
  const census = new Set(scan.census);
  const rows = scan.census
    .filter((filePath) => !classified.has(filePath))
    .map((filePath) => ({
      path: filePath,
      scope: "OWNED",
      reachability: scan.reachability[filePath],
      kind: scan.kinds[filePath],
      disposition: null,
    }));
  const recorded = new Set(supporting.map((row) => row?.path));
  const types = new Map((scan.boundary?.supporting ?? []).map((entry) => [entry.path, entry.type]));
  const supportingRows = scan.supporting
    .filter((filePath) => !recorded.has(filePath))
    .map((filePath) => ({
      ...(scan.algorithmVersion >= 2 ? { relation: "SUPPORTING", type: types.get(filePath) } : {}),
      path: filePath,
      requiredBy: [...(scan.requiredBy[filePath] ?? [])],
    }));
  const findingRows = new Set(listOf(classification, "findings", label).map((row) => row?.id));
  const undisposed = [...files, ...rows].filter((row) => missing(row?.disposition)).length;
  return {
    relative: MODULE_CLASSIFICATION_FILE,
    document: {
      ...classification,
      files: [...files, ...rows],
      ...(supporting.length + supportingRows.length > 0 ? { supporting: [...supporting, ...supportingRows] } : {}),
    },
    added: [...rows, ...supportingRows],
    rows: rows.length + supportingRows.length,
    authority: { scanner: scan.algorithmVersion, discoveryDigest: scan.discoveryDigest, census: scan.census.length },
    unresolved: [
      undisposed && {
        field: "files[].disposition",
        count: undisposed,
        need: "BEHAVIOR_BACKED with behaviorIds/routeFlowIds from inventories/legacy.json; INFRASTRUCTURE_ONLY or NO_OBSERVABLE_BEHAVIOR with rationale and a full evidence checklist (never for a production-reachable COMPONENT, STYLE or ASSET); DEAD or EXCLUDED_APPROVED only with an operator decision.",
      },
      ...[
        ["findings[]", scan.findings.filter((finding) => !findingRows.has(finding.id)).map((finding) => `${finding.id} ${finding.type} ${finding.file}:${finding.line}`),
          "A row per finding with its concrete tracked targets and an operator EDGE_RESOLUTION decision; the scan cannot prove where the edge lands."],
        ["unresolvedReferences", scan.unresolved.map((entry) => `${entry.from} -> '${entry.spec}'`),
          "Fix the specifier; a first-party reference that resolves to nothing blocks the checkpoint."],
      ].map(([field, items, need]) => items.length > 0 && { field, count: items.length, items, need }),
    ].filter(Boolean),
    // Authored rows the scan contradicts are reported, never corrected.
    conflicts: [
      ...[...classified]
        .filter(([filePath, row]) => !census.has(filePath) || row.kind !== scan.kinds[filePath] || row.reachability !== scan.reachability[filePath])
        .map(([filePath]) => `files: '${filePath}' is not in the census or records a kind/reachability the scan does not compute`),
      ...supporting
        .filter((row) => !scan.supporting.includes(row?.path))
        .map((row) => `supporting: '${row?.path}' has no supporting relation in the canonical boundary`),
    ],
  };
};

/* BUILD_BASELINE, legacy-runtime only: a pinned frame *is* its state, so the binding is mechanical. */
const visualAcceptanceDraft = async ({ root, state }) => {
  const authority = visualAuthorityOf(state);
  if (!usesVisualContract(state) || authority.contextFile !== LEGACY_RUNTIME_CONTEXT_FILE) {
    refuse(
      `${VISUAL_ACCEPTANCE_FILE} is prefilled only for designSource legacy-runtime, where each pinned frame is exactly one runtime state. Under figma-mcp, binding a runtime state to a design node and state is an authored judgment; target-system has no visual contract.`,
    );
  }
  // The validator's own view: an adopted UI remediation replaces the UI rows.
  const legacy = await withUiRemediation(root, state, await readJson(path.join(root, initialArtifacts.legacyInventory), "Legacy inventory"), "uiBehaviors");
  const target = await withUiRemediation(root, state, await readJson(path.join(root, initialArtifacts.targetInventory), "Target inventory"), "uiMismatches");
  // The validator's own reader: hashes, revision and capture block re-checked,
  // facts re-derived from the pinned measurements. A stale capture refuses here.
  const frames = await authority.validateContext(root, state, undefined, legacy);
  const file = path.join(root, VISUAL_ACCEPTANCE_FILE);
  const matrix = (await fileExists(file))
    ? assertPlainObject(await readJson(file, "Visual acceptance matrix"), "Visual acceptance matrix")
    : { version: HARDENED_VISUAL_VERSION, rows: [] };
  if (matrix.version !== HARDENED_VISUAL_VERSION) {
    refuse(`${VISUAL_ACCEPTANCE_FILE} declares version ${JSON.stringify(matrix.version)}; prefill derives version ${HARDENED_VISUAL_VERSION} rows only.`);
  }
  const rows = listOf(matrix, "rows", "Visual acceptance matrix");
  const unbacked = listOf(matrix, "unbacked", "Visual acceptance matrix");
  const covered = new Set([...rows, ...unbacked].filter(isPlainObject).map((item) => `${item.uiBehaviorId}::${item.state}`));
  const ids = new Set(rows.map((row) => row?.id));
  let next = 0;
  const nextId = () => {
    let id;
    do id = `VIS-${String(++next).padStart(3, "0")}`;
    while (ids.has(id));
    return id;
  };
  const mismatches = new Map((target.uiMismatches ?? []).map((row) => [row.uiBehaviorId, row]));
  const added = [];
  const uncovered = [];
  // Legacy inventory order, then runtime-state order: deterministic, and the
  // order an agent reads the behaviors in.
  for (const uiBehavior of legacy.uiBehaviors ?? []) {
    if (!uiBehaviorIsRequired(uiBehavior, mismatches.get(uiBehavior.id))) continue;
    for (const runtimeState of uiBehavior.runtimeStates ?? []) {
      const key = `${uiBehavior.id}::${runtimeState}`;
      if (covered.has(key)) continue;
      const frame = frames.get(key);
      if (frame?.extraction.fidelity !== "COMPLETE" || Object.keys(frame.facts ?? {}).length === 0) {
        uncovered.push(`${key} (${!frame ? "no frame" : frame.extraction.fidelity !== "COMPLETE" ? `frame ${frame.extraction.fidelity}` : "the pinned capture carries no version-2 facts"})`);
        continue;
      }
      const names = [
        ...REQUIRED_FACT_NAMES.filter((name) => frame.facts[name] !== undefined),
        ...Object.keys(frame.facts).filter((name) => REQUIRED_FACT_KINDS[name] === undefined).sort(),
      ];
      added.push({
        id: nextId(),
        uiBehaviorId: uiBehavior.id,
        state: runtimeState,
        [authority.rowFrameKey]: frame.key,
        viewport: { width: frame.viewport.width, height: frame.viewport.height },
        // The value is the authority's own normalized value -- what
        // VISUAL_CONTRACT_DIVERGES compares against. Only the taxonomy fixes a
        // kind; where a fact is measured on the target is not in the capture.
        expect: Object.fromEntries(
          names.map((name) => [name, { kind: REQUIRED_FACT_KINDS[name] ?? null, value: frame.facts[name].value, locator: null }]),
        ),
      });
    }
  }
  // An operator's VISUAL_UNBACKED approval binds the whole contract's digest,
  // rows included: a row prefill added would silently void it.
  if (unbacked.length > 0 && added.length > 0) {
    refuse(`${VISUAL_ACCEPTANCE_FILE} already lists unbacked states, and the visual contract digest their operator decisions bind would change with ${added.length} derived row(s). Add the rows deliberately and have the decisions approved again.`);
  }
  const facts = added.flatMap((row) => Object.entries(row.expect));
  const untyped = [...new Set(facts.filter(([, fact]) => fact.kind === null).map(([name]) => name))];
  return {
    relative: VISUAL_ACCEPTANCE_FILE,
    document: { ...matrix, rows: [...rows, ...added] },
    added,
    rows: added.length,
    authority: {
      designSource: state.designSource,
      context: authority.contextFile,
      contextIdentity: state.artifactHashes?.[authority.contextFile] ?? null,
    },
    unresolved: [
      facts.length > 0 && {
        field: "rows[].expect.*.locator",
        count: facts.length,
        need: "The target locator each fact is measured at; the pinned capture records values, not where they were read.",
      },
      untyped.length > 0 && {
        field: "rows[].expect.<fact>.kind",
        count: facts.filter(([, fact]) => fact.kind === null).length,
        items: untyped,
        need: "Kind of each non-taxonomy fact (count, px, equals or present); at least one bounded count per row.",
      },
      uncovered.length > 0 && {
        field: "rows[] | unbacked[]",
        count: uncovered.length,
        items: uncovered,
        need: "No COMPLETE pinned frame: capture the state again at ASSESS_TARGET, or list it under unbacked with its reason and an operator VISUAL_UNBACKED decision.",
      },
    ].filter(Boolean),
    conflicts: [],
  };
};

const digestContext = async (roots) => ({ roots, repositories: await repositoryRealpaths(roots), added: [], problems: [] });

/**
 * Fill one absent digest slot: a file's content identity, read with QW3's
 * contained reader. `nonFile` supplies the contract's digest of a reference
 * that is not a file path (gate evidence only; result outputs must be files).
 * A file that does not resolve inside the repositories stays unresolved.
 */
const fillDigest = async (node, pathKey, digestKey, at, context, nonFile = false) => {
  if (typeof node[pathKey] !== "string" || !missing(node[digestKey])) return;
  const digest = await referenceDigest(node[pathKey], context.roots, context.repositories);
  const value = digest.hash ?? (nonFile && !digest.path
    ? `sha256:${createHash("sha256").update(node[pathKey]).digest("hex")}`
    : null);
  if (!nonFile && !digest.path) digest.problem = `'${node[pathKey]}' is not a file path; this slot needs a file persisted inside the legacy or target repository.`;
  if (value) {
    node[digestKey] = value;
    context.added.push(value);
  } else {
    context.problems.push(`${at}.${digestKey}: ${digest.problem}`);
  }
};

/** Every `outputPath`/`outputDigest` and `{reference, hash}` slot of a result document. */
const fillResultDigests = async (node, at, context) => {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) await fillResultDigests(item, `${at}[${index}]`, context);
    return;
  }
  if (!isPlainObject(node)) return;
  await fillDigest(node, "outputPath", "outputDigest", at, context);
  await fillDigest(node, "reference", "hash", at, context);
  for (const [key, value] of Object.entries(node)) await fillResultDigests(value, `${at}.${key}`, context);
};

/* VERIFY_SLICES: the active slice's result.json; only content identities are mechanical. */
const resultDraft = async ({ root, state, roots }) => {
  const relative = `evidence/${state.activeSlice}/result.json`;
  if (!(await fileExists(path.join(root, relative)))) {
    refuse(`${relative} does not exist. Author it with the commands actually executed and their captured outputs first; prefill only fills their content identities.`);
  }
  const document = assertPlainObject(await readJson(path.join(root, relative), `Evidence for ${state.activeSlice}`), `Evidence for ${state.activeSlice}`);
  const context = await digestContext(roots);
  await fillResultDigests(document, "result", context);
  return {
    relative,
    document,
    added: context.added,
    rows: 0,
    authority: { slice: state.activeSlice, digests: "content identity of files inside the legacy or target repository" },
    unresolved: context.problems.length > 0 ? [{ field: "digests", count: context.problems.length, items: context.problems, need: "Persist the captured output inside the legacy or target repository." }] : [],
    conflicts: [],
  };
};

/** Realpaths of every file a gate evidence entry cites. */
const citedFiles = async (gates, roots) => {
  const cited = new Set();
  for (const gate of gates.filter(isPlainObject)) {
    for (const entry of [...(Array.isArray(gate.evidence) ? gate.evidence : []), gate.ponytailEvidence]) {
      const claim = evidencePathClaim(entry?.reference);
      const resolved = claim && (await resolveEvidencePath(claim, roots));
      if (resolved) cited.add(await realpath(resolved));
    }
  }
  return cited;
};

/**
 * The newest modification among the dirty files of both trees -- the same
 * sets the dirty-tree digests cover -- skipping the cited evidence files, which
 * are written after the run they record.
 * ponytail: a deleted file has no mtime and is not seen here; the dirty digest
 * still moves with it, so evidence bound after a deletion is the agent's claim.
 */
const latestTreeChange = async (roots, cited) => {
  let latest = { at: 0, path: null };
  for (const [root, scope] of [[roots.legacyRoot, {}], [roots.targetRoot, TARGET_DIRTY_SCOPE]]) {
    // The binding carries the revision too: a commit after the run is a change
    // the dirty set no longer shows. Same scope as gitRevision: path, else HEAD.
    const committed = async (...scopeArgs) =>
      (await execFileAsync("git", ["-C", root, "log", "-1", "--format=%ct %h", ...scopeArgs], { encoding: "utf8" })).stdout.trim();
    const [seconds, commit] = ((await committed("--", ".")) || (await committed())).split(" ");
    if (Number(seconds) * 1000 > latest.at) latest = { at: Number(seconds) * 1000, path: `commit ${commit} in ${root}` };
    const base = await realpath(root);
    for (const entry of (await dirtyManifest(root, scope)).entries) {
      const file = path.join(base, entry.path);
      const at = cited.has(file) ? 0 : (await stat(file).catch(() => null))?.mtimeMs ?? 0;
      if (at > latest.at) latest = { at, path: entry.path };
    }
  }
  return latest;
};

/* FINALIZE: the binding the gate validator compares against, and file identities. */
const gatesDraft = async ({ root, state, roots }) => {
  const relative = initialArtifacts.gates;
  const document = assertPlainObject(await readJson(path.join(root, relative), "Final gates"), "Final gates");
  const gates = listOf(document, "gates", "Final gates");
  const { freshSince, ...boundTo } = await gateBindingContext(root, state, roots);
  const context = await digestContext(roots);
  const open = [];
  const ponytail = new Map(PONYTAIL_GATE_EVIDENCE[state.ponytail] ?? []);
  let tree;
  for (const gate of gates.filter(isPlainObject)) {
    const entries = [
      ...(Array.isArray(gate.evidence) ? gate.evidence.map((entry, index) => [entry, `${gate.gate}.evidence[${index}]`]) : []),
      ...(isPlainObject(gate.ponytailEvidence) ? [[gate.ponytailEvidence, `${gate.gate}.ponytailEvidence`]] : []),
    ];
    for (const [entry, at] of entries.filter(([entry]) => isPlainObject(entry))) {
      // Absent only: a recorded binding is never refreshed. And an absent one
      // is bound to the trees now only when the entry claims to postdate every
      // change in them; binding evidence from before a change would launder
      // it as fresh, the exact thing the dirty-tree digests exist to refuse.
      if (missing(entry.boundTo)) {
        const producedAt = typeof entry.producedAt === "string" ? Date.parse(entry.producedAt) : Number.NaN;
        const reason = Number.isNaN(producedAt)
          ? "needs a valid producedAt first"
          : producedAt < Date.parse(freshSince)
            ? `producedAt predates the pinned inputs (${freshSince})`
            : producedAt < (tree ??= await latestTreeChange(roots, await citedFiles(gates, roots))).at
              ? `'${tree.path}' changed after producedAt; re-run the verification`
              : null;
        if (reason) {
          open.push(`${at}.boundTo (${reason})`);
        } else {
          entry.boundTo = { ...boundTo };
          context.added.push(entry.boundTo);
        }
      }
      await fillDigest(entry, "reference", "hash", at, context, true);
      for (const field of ["kind", "reference", "producedAt", "producer", "environment"]) {
        if (missing(entry[field]) || entry[field] === "") open.push(`${at}.${field}`);
      }
    }
    if (gate.result !== "PASS") open.push(`${gate.gate}.result`);
    if (!Number.isInteger(gate.attempts) || gate.attempts < 1 || gate.attempts > 3) open.push(`${gate.gate}.attempts`);
    if (!Array.isArray(gate.evidence) || gate.evidence.length === 0) open.push(`${gate.gate}.evidence`);
    if (ponytail.has(gate.gate) && !isPlainObject(gate.ponytailEvidence)) open.push(`${gate.gate}.ponytailEvidence (kind "${ponytail.get(gate.gate)}")`);
  }
  return {
    relative,
    document,
    added: context.added,
    rows: 0,
    authority: { boundTo, producedAtNotBefore: freshSince },
    unresolved: [
      open.length > 0 && {
        field: "gates",
        count: open.length,
        items: open,
        need: "Evidence from verification actually run (kind, reference, producedAt, producer, environment) and each gate's result and attempts. A gate is PASS only on that evidence.",
      },
      context.problems.length > 0 && { field: "hash", count: context.problems.length, items: context.problems, need: "Persist the evidence inside the legacy or target repository." },
    ].filter(Boolean),
    conflicts: [],
  };
};

const DRAFTS = {
  DISCOVERY_COMPLETENESS: classificationDraft,
  BUILD_BASELINE: visualAcceptanceDraft,
  VERIFY_SLICES: resultDraft,
  FINALIZE: gatesDraft,
};

/**
 * MC1. Prefill the current checkpoint's authored artifact in place and return a
 * concise summary -- path, what was derived, what is still the agent's or the
 * operator's -- never the document itself. The draft is not validated, pinned
 * or accepted; the normal run/validate path decides.
 */
export const prefillCheckpointDraft = async ({ registryPath, moduleName }) => {
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  const { targetRoot, legacyRoot } = registryData;
  return withModuleLock(targetRoot, resolved.canonical, async () => {
    const { state, root, pendingWrite } = await readState(targetRoot, resolved.canonical);
    if (pendingWrite) refuse("An advance is in flight; recover the record before prefilling.");
    await assertCurrentOpenSpecAuthority(targetRoot, state);
    const draft = DRAFTS[state.currentStep];
    if (!draft || state.status !== "ACTIVE" || (state.currentStep === "VERIFY_SLICES" && !state.activeSlice)) {
      refuse(`Checkpoint ${state.currentStep} (${state.status}) has no engine prefill. Prefill supports ${Object.keys(DRAFTS).join(", ")} on an ACTIVE record; author the rest per authoringRequest.schemaRef.`);
    }
    const roots = { legacyRoot, targetRoot };
    const result = await draft({ root, state, roots });
    if (state.artifactHashes?.[result.relative]) {
      refuse(`${result.relative} is pinned; prefill never rewrites a pinned record.`);
    }
    const file = path.join(root, result.relative);
    const content = `${JSON.stringify(result.document, null, 2)}\n`;
    const written = result.added.length > 0;
    if (written) {
      const mode = (await stat(file).catch(() => null))?.mode;
      await atomicWrite(targetRoot, file, content, { mode: mode === undefined ? 0o644 : mode & 0o777 });
    }
    return {
      module: resolved.canonical,
      step: state.currentStep,
      artifact: result.relative,
      path: file,
      written,
      // What an agent would otherwise have typed: the engine-written values only.
      derived: { rows: result.rows, values: leaves(result.added), bytes: written ? Buffer.byteLength(JSON.stringify(result.added)) : 0 },
      authority: result.authority,
      unresolved: result.unresolved,
      conflicts: result.conflicts,
      note: "A prefilled draft is not validated, pinned or accepted. Author every unresolved field, then validate through migration_run; the validator decides.",
    };
  });
};
