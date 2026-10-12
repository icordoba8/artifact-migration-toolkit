/**
 * Lifecycle: the artifact record -- command rendering, history and integrity
 * reads, initial state, invocation binding, and the toolkit-identity gate.
 * Moved verbatim from `artifact/artifact-migration.mjs` (Track A8).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { verifyConsumedHistory } from "../decisions/index.mjs";
import {
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_WORKFLOW_VERSION,
  assertPonytailTarget,
  AUTO_DECISIONS_FILE,
  DECISIONS_FILE,
  HISTORY_FILE,
  INTEGRITY_FILE,
  MIGRATION_STEPS,
  replayToolkitIdentity,
  resolveDesignSource,
  STATE_FILE,
  TOOLKIT_IDENTITY_EVENTS,
  toolkitIdentityBlocker,
  toolkitIdentityKey,
  TRANSACTION_FILE,
  usesArtifactDirectLedger,
  validateState,
} from "../formats/index.mjs";
import { artifactIdFor, sourcePathAtRoot, sourcePathForId } from "../census/index.mjs";
import { engineCommand, quoteCommandToken } from "../engine-paths.mjs";
import { activeToolkitIdentity } from "../toolkit-identity.mjs";
import {
  assertArray as arrayOf,
  canonicalJson as canonical,
  exactObject,
  normalizeRelative,
  sameMembers,
  samePath,
  sha256Hex as sha256,
  versionOne,
} from "../shared/index.mjs";
import {
  artifactRoot,
  fileExists as exists,
  HISTORY_EVENT_KEYS,
  integrityFor,
  revalidatePins,
} from "../store/index.mjs";

// Version 2 carries the previous state/integrity preimage and the exact
// transition input alongside the proposed state/event, so a later process with
// no in-memory proof can independently reconstruct and prove the transition
// before mutating anything. Version 1 (state+event only) is still accepted for
// recovery where its proof is reconstructible; see reconstructLegacyTransaction.
export const TRANSACTION_VERSION = 2;

export const RESOLUTION_KIND = {
  TARGET_REUSE: "REUSE",
  TARGET_EXTEND: "EXTEND",
  MIGRATE_NEW: "NEW",
};

export const artifactArgumentsFor = ({ artifactType, source, target, sourcePaths, sourceBinding, bindings, designSource, figmaSources, ponytail }) => [
  source.path,
  ...(sourcePaths ?? sourceBinding?.paths ?? bindings?.source?.paths ?? [source.path])
    .filter((file) => file !== source.path)
    .flatMap((file) => ["--source", file]),
  "--type",
  artifactType,
  "--target",
  target.path,
  "--source-root",
  source.root,
  "--target-root",
  target.root,
  // Forwarded for every non-default source, so the delegated artifact record
  // is pinned to the same authority the module record chose.
  ...(designSource && designSource !== "target-system"
    ? [
        "--design-source",
        designSource,
        ...(figmaSources ?? []).flatMap((item) => ["--figma", item.raw]),
      ]
    : []),
  ...(ponytail ? ["--ponytail", ponytail] : []),
];

export const artifactCommandFor = (binding) =>
  `/migrate-artifact ${artifactArgumentsFor(binding)
    .map((argument) => JSON.stringify(argument))
    .join(" ")}`;

/**
 * The only events allowed to carry anything beyond the fixed nine keys, and the
 * only extra keys they may carry. ADVANCED may record a verified visualComparison;
 * any other unknown key is still rejected.
 *
 * `BOOTSTRAPPED` carries the creating toolkit's identity when there was one, so
 * it is optional there; the two identity events must carry both ends of the
 * change, so those are required.
 */
const historyEventExtraKeys = (event) =>
  event === "BOOTSTRAPPED"
    ? ["toolkitIdentity"]
    : event === "ADVANCED"
      ? ["visualComparison", "consumedDecisions", "decisionLedgerPrefixes"]
    : event === "COMPLETED"
      ? ["consumedDecisions", "decisionLedgerPrefixes"]
    : TOOLKIT_IDENTITY_EVENTS.includes(event)
      ? ["previous", "next"]
      : [];

export const readHistory = async (root) => {
  const file = path.join(root, HISTORY_FILE);
  const content = await readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const events = [];
  for (const [index, line] of content.split("\n").filter(Boolean).entries()) {
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new Error(`History line ${index + 1} is invalid JSON: ${error.message}`);
      }
      exactObject(event, `history[${index}]`, HISTORY_EVENT_KEYS, historyEventExtraKeys(event.event));
      const { digest, ...body } = event;
      if (event.seq !== index + 1) throw new Error(`History sequence breaks at line ${index + 1}.`);
      const expectedPrevious = index === 0 ? null : events[index - 1].digest;
      if (event.prevDigest !== expectedPrevious || digest !== sha256(canonical(body))) {
        throw new Error(`History integrity breaks at line ${index + 1}.`);
      }
      events.push(event);
  }
  return { content, events };
};

export const ledgerPrefixesFor = async (root) => Object.fromEntries(await Promise.all(
  [["operator", DECISIONS_FILE], ["auto", AUTO_DECISIONS_FILE]].map(async ([key, file]) => {
    const content = await readFile(path.join(root, file), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return [key, { bytes: Buffer.byteLength(content), sha256: sha256(content) }];
  }),
));

const validateIntegrity = async (root, state) => {
  const document = JSON.parse(await readFile(path.join(root, INTEGRITY_FILE), "utf8"));
  exactObject(document, "integrity", ["version", "stateSha256", "historyBytes", "historySha256", "historyEvents", "artifactHashesSha256"]);
  versionOne(document.version, "integrity");
  const history = await readHistory(root);
  const expected = integrityFor(state, history.content);
  if (canonical(document) !== canonical(expected)) throw new Error("Artifact integrity anchor does not match state/history.");
  if (history.events.at(-1)?.revision !== state.revision) throw new Error("History does not end at the state revision.");
  if (toolkitIdentityKey(replayToolkitIdentity(history.events)) !== toolkitIdentityKey(state.toolkitIdentity ?? null)) {
    throw new Error("Artifact state toolkitIdentity is not the identity its append-only history proves.");
  }
  await verifyConsumedHistory(root, state, history);
  await revalidatePins(root, state);
};

export const readArtifactState = async (targetRoot, id) => {
  const root = artifactRoot(targetRoot, id);
  if (await exists(path.join(root, TRANSACTION_FILE))) {
    throw new Error(`Artifact transaction recovery is required at ${root}.`);
  }
  const file = path.join(root, STATE_FILE);
  let state;
  try {
    state = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw error;
    throw new Error(`Invalid artifact state JSON at '${file}': ${error.message}`);
  }
  validateState(state, id);
  await validateIntegrity(root, state);
  return state;
};

export const eventFor = (history, state, event) => {
  const body = {
    seq: history.events.length + 1,
    at: state.updatedAt,
    event: event.event,
    from: event.from,
    to: event.to,
    slice: event.slice ?? null,
    revision: state.revision,
    prevDigest: history.events.at(-1)?.digest ?? null,
    // Only BOOTSTRAPPED and the two identity maintenance events have any, and
    // they go *inside* the digested body, so the existing hash chain covers
    // toolkit identity exactly as it covers every other event field.
    ...Object.fromEntries(
      historyEventExtraKeys(event.event)
        .filter((key) => Object.hasOwn(event, key))
        .map((key) => [key, event[key]]),
    ),
  };
  return { ...body, digest: sha256(canonical(body)) };
};

export const consumedAtCheckpoint = async (root, step) => {
  const history = await readHistory(root);
  const event = history.events.find((entry) => entry.from === step &&
    (entry.event === "ADVANCED" || entry.event === "COMPLETED"));
  if (!event) throw new Error(`No committed ${step} checkpoint proves consumed decisions.`);
  return event.consumedDecisions ?? [];
};

// The shared deterministic bootstrap constructor: normal execution and
// recovery both build the initial state this same way, from a resolved
// artifact identity and the bindings captured at the given timestamp. No
// bootstrap rule lives anywhere else.
export const initialArtifactState = (resolved, sourceBinding, targetBinding, timestamp) => ({
  contractVersion: ARTIFACT_CONTRACT_VERSION,
  formatVersion: resolved.formatVersion,
  workflowVersion: ARTIFACT_WORKFLOW_VERSION,
  artifactId: resolved.id,
  artifactType: resolved.artifactType,
  source: resolved.source,
  target: resolved.target,
  ...(resolved.designSource
    ? { designSource: resolved.designSource, figmaSources: resolved.figmaSources }
    : {}),
  ...(resolved.ponytail ? { ponytail: resolved.ponytail } : {}),
  resolution: null,
  hasVisibleUi: null,
  status: "ACTIVE",
  currentStep: "DISCOVER_LEGACY",
  activeSlice: null,
  completedSteps: ["RESOLVE"],
  pendingSteps: MIGRATION_STEPS.slice(1),
  completedSlices: [],
  pendingSlices: [],
  bindings: { source: sourceBinding, target: targetBinding },
  artifactHashes: {},
  // Born stamped under a released toolkit, born unstamped under a source
  // checkout -- which is the state every pre-extraction record is already in.
  ...(activeToolkitIdentity() ? { toolkitIdentity: activeToolkitIdentity() } : {}),
  revision: 0,
  nextAction: "Author the source inventory.",
  nextCommand: artifactCommandFor(resolved),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const bootstrapEventInput = () => ({
  event: "BOOTSTRAPPED",
  from: "NOT_STARTED",
  to: "DISCOVER_LEGACY",
  slice: null,
  ...(activeToolkitIdentity() ? { toolkitIdentity: activeToolkitIdentity() } : {}),
});

export const EMPTY_HISTORY = { events: [] };

export const locate = ({ targetRoot = process.cwd(), id, source, type = "artifact", sourceRoot } = {}) => {
  const resolvedTargetRoot = path.resolve(targetRoot);
  const artifactId = id ?? artifactIdFor({ source, type, sourceRoot });
  return { targetRoot: resolvedTargetRoot, id: artifactId, root: artifactRoot(resolvedTargetRoot, artifactId) };
};

export const assertInvocationMatches = (state, options) => {
  if (options.pilotFormat !== undefined && (options.pilotFormat !== 14 || !usesArtifactDirectLedger(state.formatVersion))) {
    throw new Error("Invocation pilot format conflicts with persisted state.");
  }
  if (options.type && options.type !== state.artifactType) throw new Error("Invocation artifact type conflicts with persisted state.");
  if (options.source !== undefined) {
    const requestedSource = sourcePathForId({ source: options.source, sourceRoot: options.sourceRoot });
    // Fold case on win32 exactly as artifactIdFor does, so a case-variant path
    // to the same physical artifact is a match, not a conflict.
    const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
    if (fold(requestedSource) !== fold(state.source.path)) throw new Error("Invocation source path conflicts with persisted state.");
  }
  if (options.sources !== undefined) {
    const requested = [...new Set([
      state.source.path,
      ...arrayOf(options.sources, "sources").map((file) => sourcePathAtRoot(state.source.root, file)),
    ])].sort();
    sameMembers(requested, state.bindings.source.paths, "Invocation source paths");
  }
  if (options.sourceRoot && !samePath(options.sourceRoot, state.source.root)) throw new Error("Invocation sourceRoot conflicts with persisted state.");
  if (options.target && normalizeRelative(options.target, "target") !== state.target.path) throw new Error("Invocation target conflicts with persisted state.");
  if (options.targetRoot && !samePath(options.targetRoot, state.target.root)) throw new Error("Invocation targetRoot conflicts with persisted state.");
  if (options.ponytail !== undefined) {
    assertPonytailTarget(options.ponytail);
    if (options.ponytail !== state.ponytail) throw new Error("Invocation Ponytail target conflicts with persisted state.");
  }
  const designExplicit =
    options.designSource !== undefined ||
    (Array.isArray(options.figma) ? options.figma.length > 0 : options.figma !== undefined);
  if (designExplicit) {
    const requested = resolveDesignSource(options);
    if (
      requested.designSource !== (state.designSource ?? "target-system") ||
      canonical(requested.figmaSources) !== canonical(state.figmaSources ?? [])
    ) {
      throw new Error("Invocation design source conflicts with persisted state.");
    }
  }
};

// Reads the artifact's authored operator-decision rows with each row's
// reproducible candidate and ledger-backed satisfaction. record-decision.mjs
// --artifact uses this to present and approve child decisions; the engine never
// records one itself (approval lives only in record-decision.mjs).
/** The artifact-side twin of the module gate. Mutation only; never a read. */
export const artifactIdentityCommand = (state, mode) => engineCommand(
  "cli/toolkit-identity.mjs", mode,
  "--artifact", quoteCommandToken(state.source.path),
  "--type", state.artifactType,
  "--source-root", quoteCommandToken(state.source.root),
  "--target-root", quoteCommandToken(state.target.root),
);

export const assertArtifactToolkitIdentity = (state, id, action) => {
  const blocker = toolkitIdentityBlocker(state.toolkitIdentity ?? null, activeToolkitIdentity(), {
    action,
    adoptCommand: artifactIdentityCommand(state, "adopt"),
    updateCommand: artifactIdentityCommand(state, "update"),
  });
  if (blocker) throw Object.assign(new Error(blocker), { toolkitIdentity: true });
};
