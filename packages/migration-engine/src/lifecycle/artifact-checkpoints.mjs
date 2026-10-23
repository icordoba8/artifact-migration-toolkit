/**
 * Lifecycle: artifact checkpoint validation and dispatch. The artifact
 * checkpoint contract stays separate from the module one. Moved verbatim from
 * `artifact/artifact-migration.mjs` (Track A8).
 */
import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  artifactCandidateEvidence,
  artifactDecisionCandidate,
  artifactVisualDecisionRows,
  consumedFrom,
  createNewFormatDecisionCandidate,
  decisionAppliesToCandidate,
  decisionRationaleDigest,
  projectArtifactDecision,
  readRecordedDecisions,
  reconcileArtifactDecisionRows,
} from "../decisions/index.mjs";
import {
  ARTIFACT_RESOLUTIONS,
  MIGRATION_STEPS,
  usesArtifactDirectLedger,
  VISUAL_ACCEPTANCE_FILE,
} from "../formats/index.mjs";
import {
  artifactUiInventory,
  artifactVisualAuthority,
  pendingVisualUnbackedCandidates,
  strictVisualState,
  validateArtifactVisualAcceptance,
  validateArtifactVisualEvidence,
  visualAuthorityOf,
} from "../visual/index.mjs";
import {
  architectureFindings,
  asEngineFault,
  captureBinding,
  dispositionValidator,
  engineFault,
  externalRequirementPackage,
  hasExecutableCodeFiles,
  isExcluded,
  legacyDependencies,
  metrics,
  sourceRequirements,
  STRUCTURAL_SCRIPT_EXTENSIONS,
  structuralParser,
  structuralUnits as structuralUnitsRaw,
  UI_RUNTIME_STATES,
  validateEvidenceFile,
  validateSourceInventoryDocument,
} from "../census/index.mjs";
import { engineCommand } from "../engine-paths.mjs";
import {
  assertArray as arrayOf,
  assertNonEmpty as nonEmpty,
  assertPlainObject as plainObject,
  assertSafeName,
  canonicalJson as canonical,
  exactObject,
  jsonBytes,
  normalizeRelative,
  sameMembers,
  samePath,
  sha256Hex as sha256,
  unique,
  versionOne,
} from "../shared/index.mjs";
import {
  artifactEvidenceDigest,
  fileExists as exists,
  fileHash,
  pinDigest,
  readJsonAt,
  secureHash,
} from "../store/index.mjs";
import {
  diffEntries,
  implementationCoversDrift,
  migrationChangedFiles,
} from "../slices/index.mjs";
import {
  assertTargetProvides,
  executeGenericCheck,
  EXECUTION_CAPABILITY,
  hasCodeValidationCheck,
} from "./artifact-execution.mjs";
import { ponytailTime, validateGateEvidence, validatePonytailEvidence } from "./artifact-gates.mjs";
import { consumedAtCheckpoint, RESOLUTION_KIND } from "./artifact-record.mjs";
import { FINAL_GATES } from "./checkpoints.mjs";

// A requirement disposed with one of these claims the element is carried into
// the target, so it owes concrete preservation evidence at FINALIZE. The rest
// are terminal without a target file: TARGET_NATIVE_EQUIVALENT is proved by its
// target-native row, EXTERNAL_DEPENDENCY by the target's own manifest, and the
// remaining four say the element is deliberately not carried.
const PRESERVED_DISPOSITIONS = Object.freeze([
  "MIGRATED_BEHAVIOR",
  "FEATURE_LOCAL",
  "INTENTIONAL_FIX",
  "INTENTIONAL_DESIGN_ADAPTATION",
]);

export const validateSourceInventory = async (root, state) => {
  const { relative, document, behaviorIds, contractIds, visualIds } =
    await validateSourceInventoryDocument(root, state);
  // The authored row proposes a decision; only the verified ledger can satisfy it.
  const { byId, decisions: ledger } = await readRecordedDecisions(root);
  const historical = usesArtifactDirectLedger(state.formatVersion) && state.currentStep !== "DISCOVER_LEGACY"
    ? await consumedAtCheckpoint(root, "DISCOVER_LEGACY") : null;
  const decisions = [];
  if (historical && historical.length !== document.operatorDecisions.length) {
    throw new Error("Consumed source decisions do not match the committed source inventory.");
  }
  for (const [index, row] of arrayOf(document.operatorDecisions, "source inventory.operatorDecisions").entries()) {
    exactObject(row, `source inventory.operatorDecisions[${index}]`, ["id", "subject"], usesArtifactDirectLedger(state.formatVersion) ? [] : ["decisionId"]);
    const id = nonEmpty(row.id, `operator decision[${index}].id`);
    nonEmpty(row.subject, `operator decision '${id}' subject`);
    const decisionId = row.decisionId ?? null;
    if (decisionId !== null) nonEmpty(decisionId, `operator decision '${id}' decisionId`);
    const candidate = historical ? null : usesArtifactDirectLedger(state.formatVersion)
      ? await createNewFormatDecisionCandidate({
          projectRoot: state.target.root,
          kind: "ARTIFACT_DECISION",
          subjectType: "ARTIFACT_DECISION",
          subjectPath: row.id,
          rationale: row.subject,
          targets: state.bindings.target.paths,
          boundTo: {
            ...artifactCandidateEvidence(state, document),
            sourceDecision: row,
          },
        })
      : artifactDecisionCandidate(state, row);
    const projection = historical ? null : usesArtifactDirectLedger(state.formatVersion)
      ? await projectArtifactDecision({ decisions: ledger, candidate, label: `operator decision '${id}'`, row })
      : null;
    const consumed = historical?.filter((identity) => {
      const line = byId.get(identity.decisionId);
      return line?.kind === "ARTIFACT_DECISION" && line.subject?.path === id;
    });
    if (historical && (consumed.length !== 1 ||
        canonical(byId.get(consumed[0].decisionId)?.boundTo?.sourceDecision) !== canonical(row) ||
        byId.get(consumed[0].decisionId)?.rationaleDigest !== decisionRationaleDigest(row.subject) ||
        byId.get(consumed[0].decisionId)?.boundTo?.sourceInventoryDigest !== `sha256:${sha256(canonical(document))}` ||
        canonical(byId.get(consumed[0].decisionId)?.boundTo?.sourceBinding) !== canonical(state.bindings.source))) {
      throw new Error(`operator decision '${id}' has no provable consumed identity at DISCOVER_LEGACY.`);
    }
    const satisfied = historical ? true : projection
      ? projection.state === "APPROVED_APPLICABLE"
      : decisionId !== null && decisionAppliesToCandidate(byId.get(decisionId), candidate);
    // The receipt for an approval already in the ledger but not yet cited --
    // what a terminal approval leaves behind. Bound by the same predicate that
    // decides `satisfied`, so it can only ever name a line this candidate owns;
    // finding one is never itself satisfaction, only the id to cite.
    const recorded = candidate ? ledger.find((line) => decisionAppliesToCandidate(line, candidate)) ?? null : null;
    decisions.push({ id, subject: row.subject, decisionId, candidate, satisfied, recorded, ...(projection ? { projection } : {}) });
  }
  unique(decisions.map((row) => row.id), "operator decision ids");
  return { relative, document, behaviorIds, contractIds, visualIds, decisions };
};

/**
 * The terminal rules for an external requirement, applied wherever the
 * completeness rows are read -- at DISCOVERY_COMPLETENESS and again at
 * FINALIZE, so a dependency the target has since dropped cannot ride a stale
 * approval into a COMPLETE record.
 */
const validateExternalRequirements = async (state, rows, label) => {
  for (const row of rows) {
    const required = externalRequirementPackage(row, label);
    if (!required) continue;
    await assertTargetProvides(state.target.root, required.expected, `${label} '${required.element}'`);
  }
};

const validateCompleteness = async (root, state) => {
  const source = await validateSourceInventory(root, state);
  const relative = "inventories/completeness.json";
  const document = await readJsonAt(root, relative, "discovery completeness");
  exactObject(document, "discovery completeness", [
    "version",
    "sourceFiles",
    "units",
    "requirements",
  ]);
  versionOne(document.version, "discovery completeness");
  sameMembers(document.sourceFiles, source.document.sourceFiles, "discovery completeness.sourceFiles");
  const disposed = dispositionValidator(source);

  // The machine census defines the completeness universe; behavior prose never
  // bounds it. It runs unconditionally and censuses the artifact's own files --
  // not only the global contracts the authoring agent chose to volunteer, which
  // made an empty `globalContracts` disable the whole gate.
  const parser = await structuralParser();
  const census = new Map();
  const censusFiles = [
    ...source.document.sourceFiles,
    ...source.document.globalContracts.map((contract) => contract.sourcePath),
  ];
  for (const file of [...new Set(censusFiles)].sort()) {
    const script = STRUCTURAL_SCRIPT_EXTENSIONS.has(path.extname(file).toLowerCase());
    // A censused file that resolves but cannot be read is a resource failure,
    // not "author the next artifact": it must stop the loop, loudly.
    const text = script
      ? await asEngineFault(`Cannot read source file '${file}'`, () =>
          readFile(path.join(state.source.root, file), "utf8"),
        )
      : "";
    metrics.filesParsed += 1;
    const units = await asEngineFault(`Cannot census source file '${file}'`, () =>
      structuralUnitsRaw(parser, file, text),
    );
    // A structural unit path is a binding name, unique only within its file, so
    // the census key qualifies it. A whole-file unit keys as the file itself.
    for (const unit of units) {
      census.set(unit.path === file ? file : `${file}#${unit.path}`, unit);
    }
  }
  const documented = [];
  for (const [index, unit] of arrayOf(document.units, "discovery completeness.units").entries()) {
    exactObject(unit, `completeness.units[${index}]`, ["path", "disposition"], ["ref", "rationale"]);
    const unitPath = nonEmpty(unit.path, `completeness.units[${index}].path`);
    documented.push(unitPath);
    disposed(unit, unitPath, "completeness unit");
  }
  unique(documented, "discovery completeness.units paths");
  sameMembers(documented, [...census.keys()], "discovery completeness.units");

  // Nothing the artifact requires from outside itself may be silently dropped:
  // every out-of-boundary element and every undecidable reference carries a
  // disposition before this checkpoint advances.
  const scan = await sourceRequirements(state);
  // The scan censuses through git. If the bound artifact has files on disk but
  // none in the census, the graph is empty because git cannot see them, not
  // because the artifact requires nothing -- and an empty graph would let every
  // requirement through unnoticed.
  if (scan.census.length === 0 && source.document.sourceFiles.length > 0) {
    throw engineFault(
      `The source requirement graph is empty for '${state.source.path}' although it has ${source.document.sourceFiles.length} file(s)`,
      "the scan censuses through git; the artifact is ignored or outside a repository",
    );
  }
  const required = [];
  for (const [index, row] of arrayOf(document.requirements, "discovery completeness.requirements").entries()) {
    exactObject(row, `completeness.requirements[${index}]`, ["element", "disposition"], ["ref", "rationale"]);
    const element = nonEmpty(row.element, `completeness.requirements[${index}].element`);
    required.push(element);
    disposed(row, element, "completeness requirement");
  }
  unique(required, "discovery completeness.requirements elements");
  // Naming what is missing beats printing the whole universe: a silently
  // omitted element is exactly the failure this gate exists to make loud.
  const authored = new Set(required);
  const discovered = new Set(scan.elements);
  const missing = scan.elements.filter((element) => !authored.has(element));
  const unexpected = required.filter((element) => !discovered.has(element));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `discovery completeness.requirements must dispose of every discovered element (missing: ${missing.join(", ") || "none"}; not discovered: ${unexpected.join(", ") || "none"}).`,
    );
  }
  // A path requirement is a claim about a real file. Checking it here is what
  // makes a resolved-but-unreadable dependency loud: the scanner keeps the node
  // whether or not the bytes can still be read, so without this the disposition
  // would settle something the engine cannot actually see.
  for (const element of required) {
    if (element.includes(" ")) continue; // a reference token, not a path
    await asEngineFault(`Cannot read required source element '${element}'`, async () => {
      const details = await lstat(path.join(state.source.root, element));
      if (!details.isFile()) throw new Error("it is not a readable regular file");
    });
  }
  await validateExternalRequirements(state, document.requirements, "completeness requirement");
  await validateExternalRequirements(
    state,
    document.units.map((unit) => ({ ...unit, element: unit.path })),
    "completeness unit",
  );
  return { relative, document };
};

const validateTargetInventory = async (root, state) => {
  const source = await validateSourceInventory(root, state);
  const relative = "inventories/target.json";
  const document = await readJsonAt(root, relative, "target inventory");
  const assessmentCompleted = state.completedSteps.includes("ASSESS_TARGET");
  exactObject(document, "target inventory", ["version", "artifactId", "resolution", "targetFiles", "targetNative", "evidence"]);
  versionOne(document.version, "target inventory");
  if (document.artifactId !== state.artifactId) throw new Error("target inventory artifactId does not match state.");
  if (!ARTIFACT_RESOLUTIONS.includes(document.resolution)) throw new Error(`Unknown target resolution '${document.resolution}'.`);
  if (!assessmentCompleted) {
    const targetExists = await exists(path.join(state.target.root, state.target.path));
    const inPlace = samePath(state.source.root, state.target.root) &&
      state.bindings.source.paths.includes(state.target.path);
    if (document.resolution === "MIGRATE_NEW" && targetExists && !inPlace) {
      throw new Error("MIGRATE_NEW requires the bound target artifact to be absent.");
    }
    if (document.resolution !== "MIGRATE_NEW" && !targetExists) {
      throw new Error(`${document.resolution} requires the bound target artifact to exist.`);
    }
  }
  const targetFiles = arrayOf(document.targetFiles, "target inventory.targetFiles").map((file) =>
    normalizeRelative(file, "target inventory target file"),
  );
  unique(targetFiles, "target inventory.targetFiles");
  for (const file of targetFiles) await access(path.join(state.target.root, file));
  // TARGET_REUSE/EXTEND integrity: reuse is proven against the bound target,
  // never laundered through an unrelated file. MIGRATE_NEW creates the target
  // during implementation, so it is exempt from the bound-target membership.
  const targetFileSet = new Set(targetFiles);
  if (document.resolution !== "MIGRATE_NEW" && !targetFileSet.has(normalizeRelative(state.target.path, "bound target"))) {
    throw new Error(`target inventory.targetFiles must include the bound target '${state.target.path}'.`);
  }
  const nativeIds = [];
  for (const [index, row] of arrayOf(document.targetNative, "target inventory.targetNative").entries()) {
    exactObject(row, `target inventory.targetNative[${index}]`, ["id", "path", "description", "evidence"]);
    nativeIds.push(nonEmpty(row.id, `target inventory.targetNative[${index}].id`));
    const nativePath = normalizeRelative(row.path, `target-native '${row.id}' path`);
    if (!targetFileSet.has(nativePath)) throw new Error(`target-native '${row.id}' path '${nativePath}' is not a declared target file.`);
    nonEmpty(row.description, `target-native '${row.id}' description`);
    const evidence = arrayOf(row.evidence, `target-native '${row.id}' evidence`);
    if (evidence.length === 0) throw new Error(`target-native '${row.id}' requires verified evidence.`);
    for (const [evidenceIndex, item] of evidence.entries()) {
      if (!targetFileSet.has(normalizeRelative(item.path, `target-native '${row.id}' evidence path`))) {
        throw new Error(`target-native '${row.id}' evidence[${evidenceIndex}] path is not a declared target file.`);
      }
      if (assessmentCompleted) {
        exactObject(item, `target-native '${row.id}' evidence[${evidenceIndex}]`, ["path", "sha256", "status"]);
      } else {
        await validateEvidenceFile(state.target.root, item, `target-native '${row.id}' evidence[${evidenceIndex}]`);
      }
    }
  }
  unique(nativeIds, "target-native ids");
  // A TARGET_NATIVE_EQUIVALENT unit is a claim that a named target-native row
  // already covers it. The claim is authored at DISCOVERY_COMPLETENESS, before
  // target.json exists, so it is settled here -- the first point where the
  // real target-native ids are known.
  const nativeIdSet = new Set(nativeIds);
  const completeness = await readJsonAt(root, "inventories/completeness.json", "discovery completeness");
  const claims = [
    ...(Array.isArray(completeness?.units) ? completeness.units : []).map((unit) => ({
      label: "unit",
      key: unit?.path,
      ...unit,
    })),
    ...(Array.isArray(completeness?.requirements) ? completeness.requirements : []).map((row) => ({
      label: "requirement",
      key: row?.element,
      ...row,
    })),
  ];
  for (const claim of claims) {
    if (claim?.disposition !== "TARGET_NATIVE_EQUIVALENT") continue;
    if (!nativeIdSet.has(claim.ref)) {
      throw new Error(
        `completeness ${claim.label} '${claim.key}' names target-native '${claim.ref}', which is not a declared targetNative row.`,
      );
    }
  }
  const verifiedBehaviors = [];
  for (const [index, item] of arrayOf(document.evidence, "target inventory.evidence").entries()) {
    exactObject(item, `target inventory.evidence[${index}]`, ["behaviorId", "path", "sha256", "status"]);
    if (!source.behaviorIds.includes(item.behaviorId)) throw new Error(`target evidence names unknown behavior '${item.behaviorId}'.`);
    if (!targetFileSet.has(normalizeRelative(item.path, `target evidence[${index}] path`))) {
      throw new Error(`target evidence[${index}] path '${item.path}' is not a declared target file.`);
    }
    if (!assessmentCompleted) {
      await validateEvidenceFile(state.target.root, item, `target evidence[${index}]`, ["behaviorId"]);
    }
    verifiedBehaviors.push(item.behaviorId);
  }
  if (document.resolution === "TARGET_REUSE") {
    sameMembers(verifiedBehaviors, source.behaviorIds, "TARGET_REUSE verified behavior evidence");
    // Reuse is a claim about the bound target, so every behavior has to be
    // proven on it. Listing the bound target among targetFiles while every
    // evidence row cites a sibling only launders an unrelated file as proof.
    const boundTarget = normalizeRelative(state.target.path, "bound target");
    const provenOnBoundTarget = new Set(
      document.evidence
        .filter((item) => normalizeRelative(item.path, "target evidence path") === boundTarget)
        .map((item) => item.behaviorId),
    );
    for (const behaviorId of source.behaviorIds) {
      if (!provenOnBoundTarget.has(behaviorId)) {
        throw new Error(
          `TARGET_REUSE behavior '${behaviorId}' has no evidence on the bound target '${boundTarget}'.`,
        );
      }
    }
  }
  if (document.resolution === "TARGET_EXTEND" && document.targetNative.length === 0) {
    throw new Error("TARGET_EXTEND requires at least one verified targetNative row.");
  }
  if (document.resolution === "MIGRATE_NEW" && document.targetNative.length > 0) {
    throw new Error("MIGRATE_NEW cannot declare targetNative rows.");
  }
  return { relative, document, source, nativeIds, targetFiles };
};

// Seam (Track A6): the decision rows are read here (ledger, history) and
// handed to the visual acceptance rule as data, in the same order as before.
const artifactVisualAcceptance = async (root, state, source, target) => {
  const decisions = usesArtifactDirectLedger(state.formatVersion)
    ? await artifactVisualDecisions(root, state, source) : [];
  return validateArtifactVisualAcceptance(root, state, source, decisions);
};

// Visual and lifecycle facts are read here and handed to decisions as data:
// the unbacked states (visual), the committed matrix, both ledgers and, past
// BUILD_BASELINE, the identities that checkpoint consumed (lifecycle).
export const artifactVisualDecisions = async (root, state, source) => {
  if (!visualAuthorityOf(strictVisualState(state))) return [];
  const candidates = await pendingVisualUnbackedCandidates(
    root,
    strictVisualState(state),
    source ? artifactUiInventory(source) : undefined,
  );
  if (candidates.length === 0) return [];
  const matrix = await readJsonAt(root, VISUAL_ACCEPTANCE_FILE, "Visual acceptance matrix");
  const { byId, decisions } = await readRecordedDecisions(root);
  const historical = usesArtifactDirectLedger(state.formatVersion) && state.currentStep !== "BUILD_BASELINE"
    ? await consumedAtCheckpoint(root, "BUILD_BASELINE") : null;
  return artifactVisualDecisionRows({ state, source, candidates, matrix, ledger: { byId, decisions }, historical });
};

const validateBaseline = async (root, state, { final = false } = {}) => {
  const target = await validateTargetInventory(root, state);
  const resolution = state.resolution ?? target.document.resolution;
  const files = {
    parity: "matrices/parity.json",
    native: "matrices/target-native.json",
    design: "matrices/design-system.json",
    global: "matrices/global-contract.json",
  };
  const parity = await readJsonAt(root, files.parity, "parity matrix");
  exactObject(parity, "parity matrix", ["version", "rows"]);
  versionOne(parity.version, "parity matrix");
  const parityBehaviorIds = [];
  for (const [index, row] of arrayOf(parity.rows, "parity matrix.rows").entries()) {
    exactObject(row, `parity matrix.rows[${index}]`, ["id", "behaviorId", "resolution", "status", "targetEvidence"]);
    nonEmpty(row.id, `parity row[${index}].id`);
    parityBehaviorIds.push(nonEmpty(row.behaviorId, `parity row[${index}].behaviorId`));
    if (row.resolution !== resolution) throw new Error(`parity row '${row.id}' resolution does not match ${resolution}.`);
    if (!["PLANNED", "VERIFIED"].includes(row.status)) throw new Error(`parity row '${row.id}' status is invalid.`);
    const evidence = arrayOf(row.targetEvidence, `parity row '${row.id}' targetEvidence`);
    if ((resolution === "TARGET_REUSE" || final) && row.status !== "VERIFIED") {
      throw new Error(`parity row '${row.id}' must be VERIFIED.`);
    }
    if (row.status === "VERIFIED" && evidence.length === 0) throw new Error(`parity row '${row.id}' requires target evidence.`);
    for (const [evidenceIndex, item] of evidence.entries()) {
      await validateEvidenceFile(state.target.root, item, `parity row '${row.id}' evidence[${evidenceIndex}]`);
    }
  }
  sameMembers(parityBehaviorIds, target.source.behaviorIds, "parity behavior coverage");

  const native = await readJsonAt(root, files.native, "target-native matrix");
  exactObject(native, "target-native matrix", ["version", "rows"]);
  versionOne(native.version, "target-native matrix");
  const nativeIds = [];
  for (const [index, row] of arrayOf(native.rows, "target-native matrix.rows").entries()) {
    exactObject(row, `target-native matrix.rows[${index}]`, ["id", "path", "description", "status", "evidence"], ["controls"]);
    nativeIds.push(nonEmpty(row.id, `target-native matrix row[${index}].id`));
    normalizeRelative(row.path, `target-native matrix '${row.id}' path`);
    nonEmpty(row.description, `target-native matrix '${row.id}' description`);
    if (!["PLANNED", "PRESERVED", "VERIFIED"].includes(row.status)) throw new Error(`target-native row '${row.id}' status is invalid.`);
    if (final && !["PRESERVED", "VERIFIED"].includes(row.status)) throw new Error(`target-native row '${row.id}' is not preserved.`);
    for (const control of arrayOf(row.controls ?? [], `target-native row '${row.id}' controls`)) {
      exactObject(control, `target-native row '${row.id}' control`, ["role", "name"]);
      nonEmpty(control.role, `target-native row '${row.id}' control role`);
      nonEmpty(control.name, `target-native row '${row.id}' control name`);
    }
    const evidence = arrayOf(row.evidence, `target-native row '${row.id}' evidence`);
    if (final && evidence.length === 0) throw new Error(`target-native row '${row.id}' requires final evidence.`);
    for (const [evidenceIndex, item] of evidence.entries()) {
      await validateEvidenceFile(state.target.root, item, `target-native row '${row.id}' evidence[${evidenceIndex}]`);
    }
  }
  sameMembers(nativeIds, target.nativeIds, "target-native matrix rows");

  const design = await readJsonAt(root, files.design, "design-system matrix");
  exactObject(design, "design-system matrix", ["version", "rows"]);
  versionOne(design.version, "design-system matrix");
  const visibleIds = target.source.document.behaviors.filter((row) => row.visible).map((row) => row.id);
  const designBehaviorIds = [];
  const recordedDecisions = new Set(
    target.source.decisions.filter((row) => row.satisfied).map((row) => row.id),
  );
  for (const [index, row] of arrayOf(design.rows, "design-system matrix.rows").entries()) {
    exactObject(row, `design-system matrix.rows[${index}]`, [
      "id",
      "behaviorId",
      "scope",
      "targetComponent",
      "requiredComponent",
      "status",
      "evidence",
      "decisionId",
    ]);
    nonEmpty(row.id, `design-system row[${index}].id`);
    designBehaviorIds.push(nonEmpty(row.behaviorId, `design-system row[${index}].behaviorId`));
    if (!['FEATURE_LOCAL', 'GLOBAL'].includes(row.scope)) throw new Error(`design-system row '${row.id}' scope is invalid.`);
    nonEmpty(row.targetComponent, `design-system row '${row.id}' targetComponent`);
    nonEmpty(row.requiredComponent, `design-system row '${row.id}' requiredComponent`);
    if (!["PLANNED", "COMPLIANT", "EXCEPTION_RECORDED"].includes(row.status)) throw new Error(`design-system row '${row.id}' status is invalid.`);
    if (final && !["COMPLIANT", "EXCEPTION_RECORDED"].includes(row.status)) throw new Error(`design-system row '${row.id}' is not terminal.`);
    if (row.status === "EXCEPTION_RECORDED" && !recordedDecisions.has(row.decisionId)) {
      throw new Error(`design-system row '${row.id}' lacks a recorded operator decision.`);
    }
    // MR-5: reuse the required primitive before writing a new one. Shipping
    // something other than the component the row itself names is the exception,
    // and an exception is only ever an operator's call, never an agent's.
    if (row.targetComponent !== row.requiredComponent && row.status !== "EXCEPTION_RECORDED") {
      throw new Error(
        `design-system row '${row.id}' ships '${row.targetComponent}' instead of the required '${row.requiredComponent}' without a recorded exception.`,
      );
    }
    const evidence = arrayOf(row.evidence, `design-system row '${row.id}' evidence`);
    if (final && evidence.length === 0) throw new Error(`design-system row '${row.id}' requires evidence.`);
    for (const [evidenceIndex, item] of evidence.entries()) {
      await validateEvidenceFile(state.target.root, item, `design-system row '${row.id}' evidence[${evidenceIndex}]`);
    }
  }
  sameMembers(designBehaviorIds, visibleIds, "design-system visible behavior coverage");

  const global = await readJsonAt(root, files.global, "global-contract matrix");
  exactObject(global, "global-contract matrix", ["version", "rows"]);
  versionOne(global.version, "global-contract matrix");
  const globalIds = [];
  for (const [index, row] of arrayOf(global.rows, "global-contract matrix.rows").entries()) {
    exactObject(row, `global-contract matrix.rows[${index}]`, [
      "id",
      "sourceContractId",
      "kind",
      "targetPath",
      "consumers",
      "status",
      "evidence",
    ]);
    nonEmpty(row.id, `global-contract row[${index}].id`);
    const sourceContractId = nonEmpty(row.sourceContractId, `global-contract row[${index}].sourceContractId`);
    if (target.source.visualIds.includes(sourceContractId)) {
      throw new Error(`Feature-local visual '${sourceContractId}' cannot enter the global-contract matrix.`);
    }
    const sourceContract = target.source.document.globalContracts.find((entry) => entry.id === sourceContractId);
    if (!sourceContract) throw new Error(`global-contract row '${row.id}' names unknown source contract '${sourceContractId}'.`);
    globalIds.push(sourceContractId);
    if (row.kind !== sourceContract.kind) throw new Error(`global-contract row '${row.id}' kind does not match source.`);
    normalizeRelative(row.targetPath, `global-contract row '${row.id}' targetPath`);
    sameMembers(row.consumers, sourceContract.consumers, `global-contract row '${row.id}' consumers`);
    if (!["PLANNED", "VERIFIED"].includes(row.status)) throw new Error(`global-contract row '${row.id}' status is invalid.`);
    if (final && row.status !== "VERIFIED") throw new Error(`global-contract row '${row.id}' must be VERIFIED.`);
    const evidence = arrayOf(row.evidence, `global-contract row '${row.id}' evidence`);
    if (final && evidence.length === 0) throw new Error(`global-contract row '${row.id}' requires evidence.`);
    for (const [evidenceIndex, item] of evidence.entries()) {
      await validateEvidenceFile(state.target.root, item, `global-contract row '${row.id}' evidence[${evidenceIndex}]`);
    }
  }
  sameMembers(globalIds, target.source.contractIds, "global-contract source coverage");
  const visualRows = artifactVisualAuthority(state)
    ? await artifactVisualAcceptance(root, state, target.source, target)
    : null;
  return { files, parity, native, design, global, target, visualRows };
};

const validatePlan = async (root, state) => {
  const baseline = await validateBaseline(root, state);
  const relative = "slices/index.json";
  const document = await readJsonAt(root, relative, "slice plan");
  exactObject(document, "slice plan", ["version", "slices"]);
  versionOne(document.version, "slice plan");
  const ids = [];
  const covered = [];
  for (const [index, row] of arrayOf(document.slices, "slice plan.slices").entries()) {
    exactObject(row, `slice plan.slices[${index}]`, ["id", "behaviorIds", "dependsOn", "kind"]);
    const id = assertSafeName(row.id, `slice plan.slices[${index}].id`);
    ids.push(id);
    if (row.kind !== RESOLUTION_KIND[state.resolution]) throw new Error(`slice '${id}' kind does not match ${state.resolution}.`);
    const behaviorIds = arrayOf(row.behaviorIds, `slice '${id}' behaviorIds`).map((value) => nonEmpty(value, `slice '${id}' behavior id`));
    unique(behaviorIds, `slice '${id}' behaviorIds`);
    if (behaviorIds.length === 0) throw new Error(`slice '${id}' has no behaviors.`);
    covered.push(...behaviorIds);
    const dependencies = arrayOf(row.dependsOn, `slice '${id}' dependsOn`);
    for (const dependency of dependencies) {
      if (!ids.slice(0, -1).includes(dependency)) throw new Error(`slice '${id}' dependency '${dependency}' must name an earlier slice.`);
    }
  }
  if (ids.length === 0) throw new Error("slice plan requires at least one slice.");
  unique(ids, "slice ids");
  unique(covered, "planned behavior ids");
  sameMembers(covered, baseline.target.source.behaviorIds, "slice behavior coverage");
  return { relative, document, ids, baseline };
};

const validateImplementation = async (root, state, capability) => {
  const plan = await validatePlan(root, state);
  const missingDependencies = plan.document.slices
    .find((slice) => slice.id === state.activeSlice)?.dependsOn
    .filter((dependency) => !state.completedSlices.includes(dependency)) ?? [];
  if (missingDependencies.length > 0) {
    throw new Error(`Slice '${state.activeSlice}' requires completed slices: ${missingDependencies.join(", ")}.`);
  }
  const relative = `slices/${state.activeSlice}.json`;
  const document = await readJsonAt(root, relative, "slice implementation");
  exactObject(document, "slice implementation", [
    "version",
    "sliceId",
    "status",
    "changedFiles",
    "checks",
    "preservedTargetNativeIds",
  ]);
  versionOne(document.version, "slice implementation");
  if (document.sliceId !== state.activeSlice) throw new Error("slice implementation does not match activeSlice.");
  if (document.status !== "COMPLETE") throw new Error("slice implementation status must be COMPLETE.");
  const changedFiles = [];
  for (const [index, item] of arrayOf(document.changedFiles, "slice implementation.changedFiles").entries()) {
    exactObject(item, `slice implementation.changedFiles[${index}]`, ["path", "sha256"]);
    const relativeFile = normalizeRelative(item.path, `changed file[${index}].path`);
    // Provider, generated and dependency trees are excluded from the target
    // binding manifest, so drift inside one is invisible to every later
    // freshness check. Migration state, the engine's own sources and the
    // generated provider copies are all under those prefixes.
    if (isExcluded(relativeFile)) {
      throw new Error(
        `changed file '${relativeFile}' is under a provider/generated path that this migration must never write.`,
      );
    }
    const actual = await secureHash(state.target.root, relativeFile, `changed file[${index}].path`);
    if (actual !== item.sha256) throw new Error(`changed file hash does not match ${relativeFile}.`);
    changedFiles.push(relativeFile);
  }
  unique(changedFiles, "changed files");
  if (state.resolution === "TARGET_REUSE" && changedFiles.length > 0) {
    throw new Error("TARGET_REUSE cannot change target files.");
  }
  const checks = arrayOf(document.checks, "slice implementation.checks");
  if (checks.length === 0) throw new Error("slice implementation requires at least one check.");
  const deferredExecution = [];
  for (const [index, check] of checks.entries()) {
    const label = `slice implementation.checks[${index}]`;
    if (Object.hasOwn(check, "validator")) {
      exactObject(check, label, ["validator", "status"]);
      plainObject(check.validator, `${label}.validator`);
      if (check.validator.kind === "TYPESCRIPT") {
        exactObject(check.validator, `${label}.validator`, ["kind", "project"]);
        normalizeRelative(check.validator.project, `${label}.validator.project`);
      } else if (check.validator.kind === "NODE_CHECK") {
        exactObject(check.validator, `${label}.validator`, ["kind", "file"]);
        normalizeRelative(check.validator.file, `${label}.validator.file`);
      } else {
        throw new Error(`${label}.validator.kind is unsupported.`);
      }
    } else {
      exactObject(check, label, ["command", "status"]);
      nonEmpty(check.command, `${label}.command`);
    }
    if (check.status !== "PASS") throw new Error(`slice implementation check '${check.command ?? check.validator.kind}' did not PASS.`);
    // An applicable generic check is executed, not believed -- but only when
    // the caller was granted execution. A read-only caller defers it (P1 #6).
    if (check.command) {
      if (capability.execution) await executeGenericCheck(check.command, state.target.root, label, capability);
      else deferredExecution.push(check.command);
    }
  }
  // The structural half of this checkpoint -- the changed-file manifest and its
  // hashes -- is pure filesystem reading, so it still runs for a read-only
  // caller and keeps P1 #2 target-drift acceptance exact. The executable half
  // is reported as deferred instead of being trusted or faked.
  const needsValidatorEvidence = hasExecutableCodeFiles(changedFiles);
  if (needsValidatorEvidence && !capability.execution) {
    for (const check of checks.filter((entry) => entry.validator)) deferredExecution.push(check.validator.kind);
  }
  const validation = needsValidatorEvidence && capability.execution
    ? await hasCodeValidationCheck(checks, changedFiles, state.target.root, capability)
    : { passed: true, evidence: [] };
  if (!validation.passed) {
    throw new Error(
      "IMPLEMENT_SLICES changed executable code (.ts/.tsx/.js/.jsx/.mts/.mjs) but trusted validator evidence does not cover every changed file.",
    );
  }
  const preserved = arrayOf(document.preservedTargetNativeIds, "slice implementation.preservedTargetNativeIds");
  if (state.resolution === "TARGET_EXTEND") {
    sameMembers(preserved, plan.baseline.native.rows.map((row) => row.id), "TARGET_EXTEND preservedTargetNativeIds");
  }
  return { relative, document, changedFiles, validationEvidence: validation.evidence, deferredExecution, plan };
};

const validateBoundTo = (boundTo, state, label, sliceDigest, origin) => {
  exactObject(
    boundTo,
    label,
    ["sourceDigest", "targetDigest", "sliceDigest"],
    artifactVisualAuthority(state)
      ? [artifactVisualAuthority(state).boundToDigestField]
      : [],
  );
  if (boundTo.sourceDigest !== state.bindings.source.digest ||
    (origin === "TARGET" && boundTo.targetDigest !== state.bindings.target.digest) ||
    (origin === "LEGACY" && !/^[a-f0-9]{64}$/.test(boundTo.targetDigest))) {
    throw new Error(`${label} is stale for the current source/target binding.`);
  }
  if (boundTo.sliceDigest !== sliceDigest) throw new Error(`${label}.sliceDigest is stale.`);
  const authority = artifactVisualAuthority(state);
  if (
    authority &&
    boundTo[authority.boundToDigestField] !==
      state.artifactHashes[authority.contextFile]
  ) {
    throw new Error(`${label}.${authority.boundToDigestField} is stale.`);
  }
};

const validateVerification = async (root, state, capability) => {
  const implementation = await validateImplementation(root, state, capability);
  const relative = `evidence/${state.activeSlice}/result.json`;
  const document = await readJsonAt(root, relative, "slice verification");
  exactObject(document, "slice verification", ["version", "sliceId", "status", "checks", "runtimeEvidence"]);
  versionOne(document.version, "slice verification");
  if (document.sliceId !== state.activeSlice || document.status !== "PASS") {
    throw new Error("slice verification must match activeSlice and PASS.");
  }
  const slice = implementation.plan.document.slices.find((row) => row.id === state.activeSlice);
  const checkIds = [];
  for (const [index, check] of arrayOf(document.checks, "slice verification.checks").entries()) {
    exactObject(check, `slice verification.checks[${index}]`, ["behaviorId", "status", "evidence"]);
    checkIds.push(nonEmpty(check.behaviorId, `slice verification.checks[${index}].behaviorId`));
    if (check.status !== "PASS") throw new Error(`verification check '${check.behaviorId}' did not PASS.`);
    const evidence = arrayOf(check.evidence, `verification check '${check.behaviorId}' evidence`);
    if (evidence.length === 0) throw new Error(`verification check '${check.behaviorId}' requires evidence.`);
    for (const [evidenceIndex, item] of evidence.entries()) {
      await validateEvidenceFile(state.target.root, item, `verification check '${check.behaviorId}' evidence[${evidenceIndex}]`);
    }
  }
  sameMembers(checkIds, slice.behaviorIds, "slice verification behavior coverage");
  const sliceDigest = await pinDigest(root, implementation.relative);
  const behaviors = implementation.plan.baseline.target.source.document.behaviors;
  const visibleBehaviors = behaviors.filter((row) => row.visible && slice.behaviorIds.includes(row.id));
  const declaredStates = new Map(visibleBehaviors.map((row) => [row.id, row.runtimeStates ?? []]));
  const slots = new Set();
  const targetSlots = new Set();
  const capturePaths = new Set();
  const visualComparison = [];
  for (const [index, row] of arrayOf(document.runtimeEvidence, "slice verification.runtimeEvidence").entries()) {
    exactObject(row, `runtimeEvidence[${index}]`, [
      "behaviorId",
      "origin",
      "state",
      "route",
      "viewport",
      "actions",
      "artifacts",
      "boundTo",
      "provider",
    ], ["sessionId", "figmaNodeId", "legacyFrameId", "capture", "measurements"]);
    const behaviorId = nonEmpty(row.behaviorId, `runtimeEvidence[${index}].behaviorId`);
    if (row.origin !== "LEGACY" && row.origin !== "TARGET") throw new Error(`runtimeEvidence[${index}].origin must be 'LEGACY' or 'TARGET'.`);
    nonEmpty(row.state, `runtimeEvidence[${index}].state`);
    if (!UI_RUNTIME_STATES.has(row.state)) throw new Error(`runtimeEvidence[${index}].state '${row.state}' is not supported.`);
    if (!declaredStates.has(behaviorId)) throw new Error(`runtimeEvidence[${index}] names '${behaviorId}', which is not a visible behavior in this slice.`);
    if (!declaredStates.get(behaviorId).includes(row.state)) throw new Error(`runtimeEvidence[${index}] state '${row.state}' is not declared by behavior '${behaviorId}'.`);
    nonEmpty(row.route, `runtimeEvidence[${index}].route`);
    if (row.provider !== "playwright") throw new Error(`runtimeEvidence[${index}].provider must be playwright.`);
    if (row.sessionId !== undefined) nonEmpty(row.sessionId, `runtimeEvidence[${index}].sessionId`);
    exactObject(row.viewport, `runtimeEvidence[${index}].viewport`, ["width", "height"]);
    if (!Number.isInteger(row.viewport.width) || !Number.isInteger(row.viewport.height)) throw new Error("runtime viewport must use integer width/height.");
    const actions = arrayOf(row.actions, `runtimeEvidence[${index}].actions`);
    if (actions.length === 0) throw new Error(`runtime evidence '${row.behaviorId}' requires actions.`);
    for (const [actionIndex, action] of actions.entries()) {
      exactObject(action, `runtimeEvidence[${index}].actions[${actionIndex}]`, ["kind", "target", "expected", "actual", "status"]);
      for (const field of ["kind", "target", "expected", "actual"]) nonEmpty(action[field], `runtime action ${field}`);
      if (action.status !== "PASS") throw new Error(`runtime action for '${row.behaviorId}' did not PASS.`);
    }
    const kinds = [];
    for (const [artifactIndex, artifact] of arrayOf(row.artifacts, `runtimeEvidence[${index}].artifacts`).entries()) {
      exactObject(artifact, `runtimeEvidence[${index}].artifacts[${artifactIndex}]`, ["kind", "path", "sha256"]);
      if (!["ACCESSIBILITY_SNAPSHOT", "SCREENSHOT"].includes(artifact.kind)) throw new Error(`runtime artifact kind '${artifact.kind}' is invalid.`);
      kinds.push(artifact.kind);
      const artifactPath = normalizeRelative(artifact.path, "runtime artifact path");
      if (!artifactPath.startsWith(`evidence/${state.activeSlice}/ui/`)) throw new Error("runtime artifacts must stay under the active slice evidence/ui directory.");
      // A persisted capture file backs exactly one logical observation; the same
      // reference reused across slots is rejected (byte-identical distinct files
      // stay legal, since identity is the path, not the SHA).
      if (capturePaths.has(artifactPath)) throw new Error(`runtime artifact '${artifactPath}' is reused across logical observations.`);
      capturePaths.add(artifactPath);
      if ((await secureHash(root, artifactPath, "runtime artifact path")) !== artifact.sha256) throw new Error(`runtime artifact hash does not match ${artifactPath}.`);
    }
    sameMembers(kinds, ["ACCESSIBILITY_SNAPSHOT", "SCREENSHOT"], `runtime evidence '${row.behaviorId}' artifact kinds`);
    validateBoundTo(row.boundTo, state, `runtime evidence '${row.behaviorId}' boundTo`, sliceDigest, row.origin);
    const visualRow =
      row.origin === "TARGET"
        ? implementation.plan.baseline.visualRows?.find(
            (item) => item.uiBehaviorId === behaviorId && item.state === row.state,
          )
        : null;
    if (visualRow) {
      const comparison = await validateArtifactVisualEvidence(
        root,
        state,
        row,
        visualRow,
        `runtimeEvidence[${index}]`,
        implementation.plan.baseline.native.rows,
      );
      if (comparison) visualComparison.push(comparison);
    }
    // Logical observation identity: origin + behavior + runtime state. A given
    // logical slot is captured at most once; byte-identical images across
    // distinct slots stay legal (no pixel-equality rule is carried over).
    const slot = `${row.origin}::${behaviorId}::${row.state}`;
    if (slots.has(slot)) throw new Error(`runtimeEvidence[${index}] logical slot '${slot}' is captured more than once.`);
    slots.add(slot);
    if (row.origin === "TARGET") targetSlots.add(`${behaviorId}::${row.state}`);
  }
  if (state.hasVisibleUi) {
    const requiredTargetSlots = [];
    for (const behavior of visibleBehaviors) {
      for (const runtimeState of behavior.runtimeStates ?? []) requiredTargetSlots.push(`${behavior.id}::${runtimeState}`);
    }
    sameMembers([...targetSlots], requiredTargetSlots, "Playwright TARGET runtime coverage");
  } else if (document.runtimeEvidence.length > 0) {
    throw new Error("Non-UI artifact cannot carry runtime UI evidence.");
  }
  return { relative, document, implementation, semanticDigest: artifactEvidenceDigest(document), visualComparison };
};

export const validateFinal = async (root, state) => {
  const baseline = await validateBaseline(root, state, { final: true });
  const plan = await validatePlan(root, state);
  const relative = "gates.json";
  const document = await readJsonAt(root, relative, "final gates");
  exactObject(document, "final gates", ["version", "gates", "uiEvidence", "requirementEvidence"]);
  versionOne(document.version, "final gates");
  const changedFiles = await migrationChangedFiles(root, plan);
  const gateScope = new Set([
    ...changedFiles,
    ...baseline.target.targetFiles,
    normalizeRelative(state.target.path, "bound target"),
  ]);
  // The gate names promise the repository's mandatory architecture rules. These
  // are those rules, evaluated for real -- a gate whose rule is violated cannot
  // be declared PASS.
  const architecture = await architectureFindings(state.target.root, changedFiles);
  const gateFailures = {
    ARCHITECTURE_IMPLEMENTATION_GATE: architecture.implementation,
    PRECOMMIT_GATE: architecture.precommit,
  };
  const reviewedFiles = changedFiles.size > 0 ? changedFiles : new Set([normalizeRelative(state.target.path, "bound target")]);
  const names = [];
  let ponytailReviewAt;
  let ponytailAuditAt;
  let precommitReviewedAt;
  for (const [index, gate] of arrayOf(document.gates, "final gates.gates").entries()) {
    exactObject(gate, `final gates.gates[${index}]`, ["name", "status", "evidence"], ["ponytailEvidence", "reviewedAt"]);
    names.push(nonEmpty(gate.name, `final gates.gates[${index}].name`));
    if (gate.status !== "PASS") throw new Error(`final gate '${gate.name}' did not PASS.`);
    const evidence = arrayOf(gate.evidence, `final gate '${gate.name}' evidence`);
    if (evidence.length === 0) throw new Error(`final gate '${gate.name}' requires evidence.`);
    for (const [evidenceIndex, item] of evidence.entries()) {
      await validateGateEvidence(state, item, `final gate '${gate.name}' evidence[${evidenceIndex}]`, gateScope);
    }
    const failures = gateFailures[gate.name] ?? [];
    if (failures.length > 0) {
      throw new Error(`final gate '${gate.name}' cannot PASS: ${failures.join(" ")}`);
    }
    if (state.ponytail && gate.name === "SIMPLIFY_ONCE") {
      ponytailReviewAt = await validatePonytailEvidence(state, gate, "review", reviewedFiles);
    }
    if (state.ponytail === "full-audit" && gate.name === "PRECOMMIT_GATE") {
      ponytailAuditAt = await validatePonytailEvidence(state, gate, "audit");
      precommitReviewedAt = ponytailTime(gate.reviewedAt, "PRECOMMIT_GATE.reviewedAt");
    }
  }
  sameMembers(names, FINAL_GATES, "final gate names");
  if (state.ponytail === "full-audit" &&
      (ponytailReviewAt >= ponytailAuditAt || ponytailAuditAt >= precommitReviewedAt)) {
    throw new Error("Ponytail Review and Audit must precede the artifact pre-commit review in order.");
  }
  const uiRows = arrayOf(document.uiEvidence, "final gates.uiEvidence");
  if (state.hasVisibleUi) {
    const referenced = [];
    for (const [index, row] of uiRows.entries()) {
      exactObject(row, `final gates.uiEvidence[${index}]`, ["sliceId", "path", "sha256", "boundTo"]);
      const sliceId = assertSafeName(row.sliceId, `final gates.uiEvidence[${index}].sliceId`);
      referenced.push(sliceId);
      const expectedPath = `evidence/${sliceId}/result.json`;
      if (normalizeRelative(row.path, "final UI evidence path") !== expectedPath) throw new Error(`final UI evidence for '${sliceId}' has the wrong path.`);
      const evidence = await readJsonAt(root, expectedPath, `final UI evidence '${sliceId}'`);
      if (artifactEvidenceDigest(evidence) !== row.sha256) throw new Error(`final UI evidence hash for '${sliceId}' is stale.`);
      exactObject(row.boundTo, `final UI evidence '${sliceId}' boundTo`, ["sourceDigest", "targetDigest"]);
      if (row.boundTo.sourceDigest !== state.bindings.source.digest || row.boundTo.targetDigest !== state.bindings.target.digest) {
        throw new Error(`final UI evidence '${sliceId}' binding is stale.`);
      }
      for (const [rowIndex, runRow] of arrayOf(evidence.runtimeEvidence, `final UI evidence '${sliceId}' runtimeEvidence`).entries()) {
        for (const [artifactIndex, artifact] of arrayOf(runRow.artifacts, `final UI evidence '${sliceId}' runtimeEvidence[${rowIndex}].artifacts`).entries()) {
          exactObject(artifact, `final UI evidence '${sliceId}' runtimeEvidence[${rowIndex}].artifacts[${artifactIndex}]`, ["kind", "path", "sha256"]);
          const artifactPath = normalizeRelative(artifact.path, "runtime artifact path");
          if ((await secureHash(root, artifactPath, "runtime artifact path")) !== artifact.sha256) {
            throw new Error(`runtime artifact hash does not match ${artifactPath}.`);
          }
        }
        const visualRow = runRow.origin === "TARGET"
          ? baseline.visualRows?.find((item) => item.uiBehaviorId === runRow.behaviorId && item.state === runRow.state)
          : null;
        if (visualRow) {
          await validateArtifactVisualEvidence(
            root, { ...state, activeSlice: sliceId }, runRow, visualRow,
            `final UI evidence '${sliceId}' runtimeEvidence[${rowIndex}]`, baseline.native.rows,
          );
        }
      }
    }
    const uiSlices = plan.document.slices
      .filter((slice) => baseline.target.source.document.behaviors.some((behavior) => behavior.visible && slice.behaviorIds.includes(behavior.id)))
      .map((slice) => slice.id);
    sameMembers(referenced, uiSlices, "final UI evidence slices");
  } else if (uiRows.length > 0) {
    throw new Error("Final UI evidence is not applicable to this artifact format/type.");
  }
  const completeness = await readJsonAt(root, "inventories/completeness.json", "discovery completeness");
  const requirements = Array.isArray(completeness?.requirements) ? completeness.requirements : [];

  // A requirement disposed as carried into the target owes a target file that
  // actually carries it. Discovering a stylesheet, an asset, an i18n namespace
  // or a runtime URL and then never proving it downstream is how non-code
  // requirements were lost after the completeness gate approved them.
  const owedPreservation = requirements
    .filter((row) => PRESERVED_DISPOSITIONS.includes(row?.disposition))
    .map((row) => row.element);
  const provenPreservation = [];
  for (const [index, row] of arrayOf(document.requirementEvidence, "final gates.requirementEvidence").entries()) {
    const label = `final gates.requirementEvidence[${index}]`;
    await validateGateEvidence(state, row, label, gateScope, ["element"]);
    provenPreservation.push(nonEmpty(row.element, `${label}.element`));
  }
  unique(provenPreservation, "final gates.requirementEvidence elements");
  sameMembers(provenPreservation, owedPreservation, "final gates.requirementEvidence");

  // Re-asserted here, not inherited from the completeness checkpoint: a target
  // dependency dropped since then must block completion, not ride an old
  // approval into a COMPLETE record.
  await validateExternalRequirements(state, requirements, "final requirement");

  // In one root, only a source path actually changed by a migration slice is
  // migrated. Bootstrap prebinds every source path as a target, even untouched
  // legacy files. Separate-root migration keeps its existing full scope.
  const inPlace = samePath(state.source.root, state.target.root);
  const legacyPaths = [
    ...state.bindings.source.paths,
    ...(inPlace ? [] : requirements)
      .map((row) => row?.element)
      .filter((element) => typeof element === "string" && !element.includes(" ")),
  ].filter((file) =>
    !inPlace || !changedFiles.has(file),
  );
  const legacy = await legacyDependencies(state.target.root, state.source.root, legacyPaths, {
    changedFiles: [...changedFiles],
  });
  if (legacy.findings.length > 0) {
    throw new Error(
      `Target code still resolves to legacy modules: ${legacy.findings
        .map((finding) => `${finding.file} -> ${finding.legacyPath}`)
        .join(", ")}.`,
    );
  }
  if (legacy.undecidable.length > 0) {
    throw new Error(
      `Changed target code carries undecidable dynamic module references: ${legacy.undecidable
        .map((row) => `${row.file}: ${row.expression}`)
        .join(", ")}.`,
    );
  }
  return { relative, document };
};

const BASELINE_MATRICES = ["matrices/parity.json", "matrices/target-native.json", "matrices/design-system.json", "matrices/global-contract.json"];

export const checkpointArtifacts = (state) => {
  switch (state.currentStep) {
    case "RESOLVE": return ["state.json"];
    case "DISCOVER_LEGACY": return ["inventories/source.json"];
    case "DISCOVERY_COMPLETENESS": return ["inventories/completeness.json"];
    case "ASSESS_TARGET": return [
      "inventories/target.json",
      ...(artifactVisualAuthority(state)
        ? [artifactVisualAuthority(state).contextFile]
        : []),
    ];
    case "BUILD_BASELINE": return [...BASELINE_MATRICES, ...(artifactVisualAuthority(state) ? [VISUAL_ACCEPTANCE_FILE] : [])];
    case "PLAN": return ["slices/index.json"];
    case "IMPLEMENT_SLICES": return [`slices/${state.activeSlice}.json`];
    case "VERIFY_SLICES": return [`evidence/${state.activeSlice}/result.json`];
    // M9-R1 D2: FINALIZE requires every matrix row terminal (validateBaseline
    // `final`), so it declares them; only status/evidence may move -- the
    // BUILD_BASELINE `#immutable` pin still holds every other field.
    case "FINALIZE": return [...BASELINE_MATRICES, "gates.json"];
    default: return [];
  }
};

// The capability is required, never defaulted: P1 #6 was exactly a read-only
// caller silently inheriting the write path's right to run target code. Every
// result is stamped with the capability it was produced under, so a caller that
// turns a validation into a state transition can refuse one that skipped the
// executable half.
export const validateCheckpoint = async (root, state, capability) => {
  if (capability?.execution !== true && capability?.execution !== false) {
    throw new Error("validateCheckpoint requires an explicit execution capability.");
  }
  const result = await runCheckpointValidation(root, state, capability);
  return { ...result, executed: capability.execution };
};

// The approve-command hint is rendered here (transport vocabulary); every
// reconciliation rule is decisions'.
export const reconcileArtifactDecisions = (state, decisions) =>
  reconcileArtifactDecisionRows(state, decisions, (candidate) =>
    engineCommand(
      "record-decision.mjs",
      "--artifact",
      JSON.stringify(state.source.path),
      "--type",
      state.artifactType,
      "--source-root",
      JSON.stringify(state.source.root),
      "--target-root",
      JSON.stringify(state.target.root),
      "--approve",
      candidate.id,
  ));

const runCheckpointValidation = async (root, state, capability) => {
  try {
    switch (state.currentStep) {
      case "DISCOVER_LEGACY": {
        const result = await validateSourceInventory(root, state);
        const reconciled = reconcileArtifactDecisions(state, result.decisions);
        if (usesArtifactDirectLedger(state.formatVersion) && reconciled.projection.state === "REJECTED") {
          return { ready: false, outcome: "BLOCKED", reason: "Current source decision is REJECTED.", decisionProjection: reconciled.projection };
        }
        if (reconciled.approvable.length > 0) {
          return {
            ready: false,
            outcome: "OPERATOR_DECISION",
            reason: `${reconciled.approvable.length} source operator decision(s) require operator approval.`,
            pendingDecisions: reconciled.pendingDecisions,
            decisionReferences: reconciled.references,
            operatorApproval: { cwd: process.cwd(), candidates: reconciled.candidates },
            ...(reconciled.projection ? { decisionProjection: reconciled.projection } : {}),
          };
        }
        if (reconciled.citable.length > 0) {
          return {
            ready: false,
            reason: `${reconciled.citable.length} recorded operator decision(s) are not cited in inventories/source.json.`,
            pendingDecisions: reconciled.pendingDecisions,
            decisionReferences: reconciled.references,
            citations: reconciled.citations,
          };
        }
        return { ready: true, result,
          ...(usesArtifactDirectLedger(state.formatVersion) && capability.execution ? { consumedDecisions: consumedFrom(result.decisions) } : {}),
          ...(reconciled.projection ? { decisionProjection: reconciled.projection } : {}) };
      }
      case "DISCOVERY_COMPLETENESS": return { ready: true, result: await validateCompleteness(root, state) };
      case "ASSESS_TARGET": {
        const result = await validateTargetInventory(root, state);
        const authority = artifactVisualAuthority(state);
        if (authority) {
          await authority.validateContext(
            root,
            strictVisualState(state),
            undefined,
            artifactUiInventory(result.source),
          );
        }
        return { ready: true, result };
      }
      case "BUILD_BASELINE": {
        const visualDecisions = await artifactVisualDecisions(
          root,
          state,
          await validateSourceInventory(root, state),
        );
        const visual = reconcileArtifactDecisions(state, visualDecisions);
        if (usesArtifactDirectLedger(state.formatVersion) && visual.projection.state === "REJECTED") {
          return { ready: false, outcome: "BLOCKED", reason: "Current visual decision is REJECTED.", decisionProjection: visual.projection };
        }
        if (visual.approvable.length > 0) {
          return {
            ready: false,
            outcome: "OPERATOR_DECISION",
            reason: `${visual.approvable.length} visual state(s) require operator approval.`,
            pendingDecisions: visual.pendingDecisions,
            decisionReferences: visual.references,
            operatorApproval: { cwd: process.cwd(), candidates: visual.candidates },
            ...(visual.projection ? { decisionProjection: visual.projection } : {}),
          };
        }
        if (visual.citable.length > 0) {
          return {
            ready: false,
            reason: `${visual.citable.length} recorded visual decision(s) are not cited in ${VISUAL_ACCEPTANCE_FILE}.`,
            pendingDecisions: visual.pendingDecisions,
            decisionReferences: visual.references,
          };
        }
        return { ready: true, result: await validateBaseline(root, state),
          ...(usesArtifactDirectLedger(state.formatVersion) && capability.execution ? { consumedDecisions: consumedFrom(visualDecisions) } : {}),
          ...(visual.projection ? { decisionProjection: visual.projection } : {}) };
      }
      case "PLAN": return { ready: true, result: await validatePlan(root, state) };
      case "IMPLEMENT_SLICES": return { ready: true, result: await validateImplementation(root, state, capability) };
      case "VERIFY_SLICES": return { ready: true, result: await validateVerification(root, state, capability) };
      case "FINALIZE": return { ready: true, result: await validateFinal(root, state) };
      default: return { ready: false, outcome: "COMPLETE", reason: "Artifact migration is complete." };
    }
  } catch (error) {
    // A contract violation means "author the next artifact" -- CONTINUE. An
    // engine fault means the engine itself could not run, and reporting that as
    // CONTINUE made a crash indistinguishable from pending work, so an
    // automated driver looped on it forever.
    return error?.engineFault
      ? { ready: false, outcome: "BLOCKED", reason: error.message }
      : { ready: false, outcome: "CONTINUE", reason: error.message };
  }
};

export const freshness = async (root, state, validation = null) => {
  const [source, target] = await Promise.all([
    captureBinding(state.source.root, state.bindings.source.paths, "source"),
    captureBinding(state.target.root, state.bindings.target.paths, "target"),
  ]);
  const targetScope = new Set(state.bindings.target.paths);
  const sourceDrift = diffEntries(state.bindings.source.entries, source.entries)
    .filter((file) => !samePath(state.source.root, state.target.root) || !targetScope.has(file));
  const targetDrift = diffEntries(state.bindings.target.entries, target.entries);
  const acceptedTargetDrift =
    state.currentStep === "IMPLEMENT_SLICES" &&
    validation?.ready &&
    implementationCoversDrift(validation.result.changedFiles, targetDrift);
  const stale = sourceDrift.length > 0 || (targetDrift.length > 0 && !acceptedTargetDrift);
  return { stale, source, target, sourceDrift, targetDrift, acceptedTargetDrift };
};

export const requestFor = (state, reason) => ({
  checkpoint: state.currentStep,
  slice: state.activeSlice,
  artifacts: checkpointArtifacts(state),
  schemaRef: `references/artifact-contract.md#${state.currentStep.toLowerCase().replaceAll("_", "-")}`,
  reason,
});

const pinsFor = async (root, state, validation) => {
  const pins = {};
  const add = async (key) => {
    pins[key] = await pinDigest(root, key);
  };
  switch (state.currentStep) {
    case "DISCOVER_LEGACY": await add("inventories/source.json"); break;
    case "DISCOVERY_COMPLETENESS": await add("inventories/completeness.json"); break;
    case "ASSESS_TARGET":
      await add("inventories/target.json");
      if (artifactVisualAuthority(state)) {
        await add(artifactVisualAuthority(state).contextFile);
      }
      break;
    case "BUILD_BASELINE":
      for (const relative of Object.values(validation.result.files)) await add(`${relative}#immutable`);
      if (artifactVisualAuthority(state)) await add(VISUAL_ACCEPTANCE_FILE);
      break;
    case "PLAN": await add("slices/index.json"); break;
    case "IMPLEMENT_SLICES": await add(validation.result.relative); break;
    case "VERIFY_SLICES": await add(`${validation.result.relative}#semantic`); break;
    case "FINALIZE": for (const relative of checkpointArtifacts(state)) await add(relative); break;
  }
  return pins;
};

const pathsAfterCheckpoint = (state, validation) => {
  const targetPaths = new Set(state.bindings.target.paths);
  if (state.currentStep === "ASSESS_TARGET") {
    for (const file of validation.result.targetFiles) targetPaths.add(file);
    for (const row of validation.result.document.targetNative) targetPaths.add(row.path);
  }
  if (state.currentStep === "BUILD_BASELINE") {
    for (const row of validation.result.global.rows) targetPaths.add(row.targetPath);
  }
  if (state.currentStep === "IMPLEMENT_SLICES") {
    for (const file of validation.result.changedFiles) targetPaths.add(file);
  }
  return [...targetPaths].sort();
};

export const nextState = async (root, state, validation, fresh, selectedSlice) => {
  const next = structuredClone(state);
  next.revision += 1;
  next.artifactHashes = { ...state.artifactHashes, ...(await pinsFor(root, state, validation)) };
  next.bindings = {
    source: state.bindings.source,
    target: await captureBinding(state.target.root, pathsAfterCheckpoint(state, validation), "target"),
  };
  const current = state.currentStep;
  if (current === "DISCOVER_LEGACY") next.hasVisibleUi = validation.result.document.hasVisibleUi;
  if (current === "ASSESS_TARGET") next.resolution = validation.result.document.resolution;
  if (current === "PLAN") {
    const ids = validation.result.ids;
    const first = selectedSlice ?? ids[0];
    if (!ids.includes(first)) throw new Error(`Selected slice '${first}' is not in the plan.`);
    const missing = validation.result.document.slices
      .find((slice) => slice.id === first).dependsOn
      .filter((dependency) => !state.completedSlices.includes(dependency));
    if (missing.length > 0) throw new Error(`Slice '${first}' requires completed slices: ${missing.join(", ")}.`);
    next.completedSteps = [...state.completedSteps, current];
    next.currentStep = "IMPLEMENT_SLICES";
    next.activeSlice = first;
    next.pendingSlices = [first, ...ids.filter((id) => id !== first)];
  } else if (current === "IMPLEMENT_SLICES") {
    next.currentStep = "VERIFY_SLICES";
  } else if (current === "VERIFY_SLICES") {
    const remaining = state.pendingSlices.filter((id) => id !== state.activeSlice);
    next.completedSlices = [...state.completedSlices, state.activeSlice];
    next.pendingSlices = remaining;
    if (remaining.length > 0) {
      next.currentStep = "IMPLEMENT_SLICES";
      next.activeSlice = remaining[0];
    } else {
      next.completedSteps = [...state.completedSteps, "IMPLEMENT_SLICES", "VERIFY_SLICES"];
      next.currentStep = "FINALIZE";
      next.activeSlice = null;
    }
  } else if (current === "FINALIZE") {
    next.completedSteps = [...state.completedSteps, current];
    next.currentStep = "COMPLETE";
    next.status = "COMPLETE";
    next.activeSlice = null;
    next.pendingSlices = [];
  } else {
    next.completedSteps = [...state.completedSteps, current];
    next.currentStep = MIGRATION_STEPS[MIGRATION_STEPS.indexOf(current) + 1];
  }
  next.pendingSteps = next.currentStep === "COMPLETE"
    ? []
    : MIGRATION_STEPS.slice(MIGRATION_STEPS.indexOf(next.currentStep));
  next.nextAction = next.currentStep === "COMPLETE"
    ? "Artifact migration is complete."
    : `Author ${checkpointArtifacts(next).join(", ")}.`;
  return next;
};

export const previewAdvance = async (root, state, options) => {
  metrics.previewAdvanceCalls += 1;
  if (options.slice && ![state.activeSlice, null].includes(options.slice) && state.currentStep !== "PLAN") {
    return { state, outcome: "BLOCKED", reason: `Slice '${options.slice}' is not active (${state.activeSlice ?? "none"}).` };
  }
  const validation = state.status === "COMPLETE" ? null : await validateCheckpoint(root, state, EXECUTION_CAPABILITY);
  // The mirror of P1 #6: a transition must never be derived from a validation
  // that skipped the executable half.
  if (validation && validation.executed !== true) {
    throw new Error("An artifact transition cannot be derived from a read-only checkpoint validation.");
  }
  if (validation && !validation.ready) {
    if (usesArtifactDirectLedger(state.formatVersion)) {
      const fresh = await freshness(root, state, validation);
      if (fresh.stale) return {
        state, validation, fresh, outcome: "BLOCKED",
        reason: `Relevant artifact drift detected (source: ${fresh.sourceDrift.join(", ") || "none"}; target: ${fresh.targetDrift.join(", ") || "none"}).`,
      };
    }
    return { state, validation, outcome: validation.outcome, reason: validation.reason };
  }
  if (state.currentStep === "PLAN" && options.slice) {
    const selected = validation.result.document.slices.find((slice) => slice.id === options.slice);
    if (selected?.dependsOn.some((dependency) => !state.completedSlices.includes(dependency))) {
      return { state, validation, outcome: "BLOCKED", reason: `Slice '${options.slice}' requires completed slices: ${selected.dependsOn.join(", ")}.` };
    }
  }
  const fresh = await freshness(root, state, validation);
  if (fresh.stale) {
    return {
      state,
      validation,
      fresh,
      outcome: "BLOCKED",
      reason: state.status === "COMPLETE"
        ? "Previously completed output is stale and cannot be accepted as complete."
        : `Relevant artifact drift detected (source: ${fresh.sourceDrift.join(", ") || "none"}; target: ${fresh.targetDrift.join(", ") || "none"}).`,
    };
  }
  if (state.status === "COMPLETE") {
    if (state.ponytail) {
      try {
        await validateFinal(root, state);
      } catch (error) {
        return { state, outcome: "BLOCKED", reason: error.message };
      }
    }
    return { state, outcome: "COMPLETE", reason: "Artifact migration is complete." };
  }
  const snapshot = {
    artifactId: state.artifactId,
    revision: state.revision,
    checkpoint: state.currentStep,
    slice: state.activeSlice,
    selectedSlice: options.slice ?? null,
    stateSha256: sha256(jsonBytes(state)),
    sourceDigest: fresh.source.digest,
    targetDigest: fresh.target.digest,
    artifacts: await Promise.all(checkpointArtifacts(state).map(async (relative) => [relative, await fileHash(path.join(root, relative))])),
  };
  return {
    state,
    validation,
    fresh,
    outcome: "CONTINUE",
    confirmationId: sha256(canonical(snapshot)).slice(0, 16),
  };
};
