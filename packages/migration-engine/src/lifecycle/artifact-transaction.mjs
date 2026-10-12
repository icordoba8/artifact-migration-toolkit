/**
 * Lifecycle: the artifact transaction -- input validation, replay proofs,
 * recovery phases, finish and recovery. Its journal format is unchanged and
 * separate from the module's (DR13 is Track B). Moved verbatim from
 * `artifact/artifact-migration.mjs` (Track A8).
 */
import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { verifyConsumedHistory } from "../decisions/index.mjs";
import {
  assertPonytailTarget,
  HISTORY_FILE,
  INTEGRITY_FILE,
  resolveDesignSource,
  STATE_FILE,
  toolkitIdentityKey,
  TRANSACTION_FILE,
  usesArtifactDirectLedger,
  validateState,
  validateToolkitIdentity,
} from "../formats/index.mjs";
import { captureBinding, targetPathsFor } from "../census/index.mjs";
import {
  assertArray as arrayOf,
  assertNonEmpty as nonEmpty,
  assertPlainObject as plainObject,
  assertSafeName,
  canonicalJson as canonical,
  exactObject,
  jsonBytes,
  jsonBytesEqual,
  normalizeRelative,
  samePath,
  sha256Hex as sha256,
  unique,
  versionOne,
} from "../shared/index.mjs";
import {
  atomicWrite,
  fileExists as exists,
  historyPrefixContent,
  integrityFor,
  revalidatePins,
} from "../store/index.mjs";
import { nextState, previewAdvance } from "./artifact-checkpoints.mjs";
import {
  bootstrapEventInput,
  EMPTY_HISTORY,
  eventFor,
  initialArtifactState,
  ledgerPrefixesFor,
  readHistory,
  TRANSACTION_VERSION,
} from "./artifact-record.mjs";

export const pristineFormatUpgrade = async (root, state, history, journalled = false) => {
  const refuse = () => {
    throw Object.assign(new Error("LEGACY_COMPATIBILITY_ACTION_REQUIRED: Artifact 13 is not a pristine bootstrap record."), {
      code: "LEGACY_COMPATIBILITY_ACTION_REQUIRED",
    });
  };
  if (state.formatVersion !== 13 || history.events.length < 1 || history.events.length > (journalled ? 2 : 1)) refuse();
  const bootstrapHistory = { events: history.events.slice(0, 1) };
  const bootstrapBytes = `${JSON.stringify(bootstrapHistory.events[0])}\n`;
  if (history.content !== (journalled && history.events.length === 2
    ? `${bootstrapBytes}${JSON.stringify(history.events[1])}\n`
    : bootstrapBytes)) refuse();
  const files = [];
  const visit = async (directory, relative = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const details = await lstat(path.join(directory, entry.name));
      if (details.isDirectory()) {
        files.push(`${child}/`);
        await visit(path.join(directory, entry.name), child);
      } else if (details.isFile()) files.push(child);
      else refuse();
    }
  };
  await visit(root);
  const expectedFiles = ["history/", "history/history.ndjson", "integrity.json", "state.json", ...(journalled ? ["transaction.json"] : [])].sort();
  if (canonical(files.sort()) !== canonical(expectedFiles)) refuse();
  const [sourceBinding, targetBinding] = await Promise.all([
    captureBinding(state.source.root, state.bindings.source.paths, "source"),
    captureBinding(state.target.root, state.bindings.target.paths, "target"),
  ]);
  if (canonical(sourceBinding) !== canonical(state.bindings.source) ||
      canonical(targetBinding) !== canonical(state.bindings.target)) refuse();
  const resolved = {
    id: state.artifactId,
    artifactType: state.artifactType,
    formatVersion: 13,
    source: state.source,
    sourcePaths: state.bindings.source.paths,
    target: state.target,
    targetPaths: state.bindings.target.paths,
    ...resolveDesignSource({ designSource: state.designSource, figma: (state.figmaSources ?? []).map((item) => item.raw) }),
    ...(state.ponytail ? { ponytail: state.ponytail } : {}),
  };
  const expectedState = initialArtifactState(resolved, sourceBinding, targetBinding, state.createdAt);
  if (canonical(state) !== canonical(expectedState) || state.updatedAt !== state.createdAt ||
      canonical(bootstrapHistory.events[0]) !== canonical(eventFor(EMPTY_HISTORY, expectedState, bootstrapEventInput()))) refuse();
  const previousIntegrity = integrityFor(state, bootstrapBytes);
  const confirmationId = sha256(canonical({ state, previousIntegrity, bootstrapBytes })).slice(0, 16);
  return { bootstrapHistory, bootstrapBytes, previousIntegrity, confirmationId };
};

// Strict discriminated transition input: ADVANCE carries the selected slice
// explicitly, independently of the event's slice (which retains the existing
// previous-active-slice semantics); BOOTSTRAP carries exactly what the shared
// initial-state constructor and resolver need.
const validateTransactionInput = (input, label) => {
  plainObject(input, label);
  if (input.kind === "BOOTSTRAP") {
    exactObject(
      input,
      label,
      ["kind", "artifactType", "source", "target"],
      ["designSource", "figmaSources", "sourcePaths", "ponytail", "pilotFormat", "formatVersion"],
    );
    assertSafeName(input.artifactType, `${label}.artifactType`);
    if (input.pilotFormat !== undefined && input.pilotFormat !== 14) {
      throw new Error(`${label}.pilotFormat must be 14.`);
    }
    if (input.formatVersion !== undefined && input.formatVersion !== 14) {
      throw new Error(`${label}.formatVersion must be 14.`);
    }
    for (const key of ["source", "target"]) {
      exactObject(input[key], `${label}.${key}`, ["root", "path"]);
      nonEmpty(input[key].root, `${label}.${key}.root`);
      normalizeRelative(input[key].path, `${label}.${key}.path`);
    }
    if (input.sourcePaths !== undefined) {
      const paths = arrayOf(input.sourcePaths, `${label}.sourcePaths`);
      unique(paths, `${label}.sourcePaths`);
      if (!paths.includes(input.source.path) || canonical(paths) !== canonical([...paths].sort())) {
        throw new Error(`${label}.sourcePaths must be sorted and include the primary source.`);
      }
      for (const file of paths) normalizeRelative(file, `${label}.sourcePaths`);
    }
    if (input.designSource !== undefined) {
      const design = resolveDesignSource({
        designSource: input.designSource,
        figma: (input.figmaSources ?? []).map((source) => source?.raw),
      });
      if (canonical(design.figmaSources) !== canonical(input.figmaSources ?? [])) {
        throw new Error(`${label}.figmaSources are not canonical.`);
      }
    }
    if (input.ponytail !== undefined) assertPonytailTarget(input.ponytail);
  } else if (input.kind === "ADVANCE") {
    exactObject(input, label, ["kind", "selectedSlice"]);
    if (input.selectedSlice !== null) nonEmpty(input.selectedSlice, `${label}.selectedSlice`);
  } else if (input.kind === "FORMAT_UPGRADE") {
    exactObject(input, label, ["kind", "from", "to", "confirmationId"]);
    if (input.from !== 13 || input.to !== 14) throw new Error(`${label} must describe 13 -> 14.`);
    nonEmpty(input.confirmationId, `${label}.confirmationId`);
  } else if (input.kind === "TOOLKIT_IDENTITY") {
    // Engine maintenance, not a lifecycle transition: it moves no step, slice,
    // pin, binding or decision. It is a third transaction kind rather than a
    // special ADVANCE precisely so `proveAdvanceTransaction` -- which reruns the
    // whole previewAdvance/nextState chain -- can never be asked to reproduce it.
    exactObject(input, label, ["kind", "previous", "next"]);
    if (input.previous !== null) validateToolkitIdentity(input.previous, `${label}.previous`);
    validateToolkitIdentity(input.next, `${label}.next`);
  } else {
    throw new Error(`${label}.kind must be BOOTSTRAP, ADVANCE, FORMAT_UPGRADE or TOOLKIT_IDENTITY.`);
  }
};

// Exactly the checks `finishTransaction` would perform, without writing, and
// without ever calling `previewAdvance`/`nextState`/`eventFor` -- this is the
// one read-only structural proof shared by `--status`, a normal commit's
// persistence, and recovery's pre-check. It binds the envelope shape and the
// event's position against history; it never proves the lifecycle transition
// itself. Both `--status` and `run` call it, so a transaction that `run` will
// refuse can never be reported as healthy by the read-only path SKILL.md
// mandates first.
export const assertTransactionReplayable = async (root, transaction) => {
  if (transaction.version === TRANSACTION_VERSION) {
    const directAdvance = usesArtifactDirectLedger(transaction.state?.formatVersion) && transaction.input?.kind === "ADVANCE";
    exactObject(transaction, "artifact transaction", ["version", "previousState", "previousIntegrity", "input", "state", "event"],
      directAdvance ? ["consumedDecisions", "decisionLedgerPrefixes"] : []);
    validateTransactionInput(transaction.input, "artifact transaction.input");
    if (directAdvance) {
      if (canonical(transaction.consumedDecisions ?? []) !== canonical(transaction.event.consumedDecisions ?? []) ||
          canonical(transaction.decisionLedgerPrefixes ?? null) !== canonical(transaction.event.decisionLedgerPrefixes ?? null)) {
        throw new Error("Artifact transaction and history disagree on consumed decision authority.");
      }
    }
    if (transaction.input.kind === "BOOTSTRAP") {
      if (transaction.previousState !== null || transaction.previousIntegrity !== null) {
        throw new Error("Bootstrap transaction must not carry a previous state.");
      }
    } else {
      plainObject(transaction.previousState, "artifact transaction.previousState");
      validateState(transaction.previousState, transaction.previousState.artifactId);
      exactObject(
        transaction.previousIntegrity,
        "artifact transaction.previousIntegrity",
        ["version", "stateSha256", "historyBytes", "historySha256", "historyEvents", "artifactHashesSha256"],
      );
      versionOne(transaction.previousIntegrity.version, "artifact transaction.previousIntegrity");
    }
  } else if (transaction.version === 1) {
    exactObject(transaction, "artifact transaction", ["version", "state", "event"]);
  } else {
    throw new Error(`Unsupported artifact transaction version ${transaction.version}.`);
  }
  validateState(transaction.state, transaction.state.artifactId);
  const history = await readHistory(root);
  const matching = history.events.find((event) => event.seq === transaction.event.seq);
  if (matching && canonical(matching) !== canonical(transaction.event)) {
    throw new Error("Artifact transaction conflicts with append-only history.");
  }
  if (!matching && transaction.event.seq !== history.events.length + 1) {
    throw new Error("Artifact transaction cannot be appended in sequence.");
  }
  // The journal may describe only the exact old prefix or that prefix plus
  // its complete serialized event. Never normalize a torn/reformatted suffix,
  // or accept an event buried in a longer history before mutating authority.
  const prefix = historyPrefixContent(history.content, transaction.event.seq - 1);
  const expected = matching ? `${prefix}${JSON.stringify(transaction.event)}\n` : prefix;
  if (history.content !== expected || (matching && history.events.length !== transaction.event.seq)) {
    throw new Error("Artifact transaction history is not its exact persisted prefix or completed event.");
  }
  return { history, matching };
};

// The real writer only ever leaves state.json/integrity.json in one of the
// crash-window table's phases (write order is: append history, replace state,
// replace integrity). This proves the actual bytes on disk are genuinely one
// of those phases before finishTransaction is allowed to overwrite them --
// never trusting a freshly computed integrity document to excuse arbitrary
// existing corruption, and never treating a state/integrity anchor that
// belongs to neither the previous nor the proposed transition as recoverable.
const assertKnownRecoveryPhase = async (root, transaction, prefixContent) => {
  const readOrNull = (file) =>
    readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  const [actualState, actualIntegrity] = await Promise.all([
    readOrNull(path.join(root, STATE_FILE)),
    readOrNull(path.join(root, INTEGRITY_FILE)),
  ]);
  const isBootstrap = transaction.previousState === null;
  const finalIntegrity = integrityFor(transaction.state, `${prefixContent}${JSON.stringify(transaction.event)}\n`);

  const stateIsPrevious = !isBootstrap && jsonBytesEqual(actualState, transaction.previousState);
  const stateIsAbsent = actualState === null;
  const stateIsNext = jsonBytesEqual(actualState, transaction.state);
  if (!stateIsPrevious && !stateIsAbsent && !stateIsNext) {
    throw new Error("Artifact state.json matches neither the previous nor the proposed state.");
  }
  if (!isBootstrap && stateIsAbsent) {
    throw new Error("Artifact state.json is missing for a non-bootstrap transaction.");
  }

  const integrityIsPrevious = !isBootstrap && jsonBytesEqual(actualIntegrity, transaction.previousIntegrity);
  const integrityIsAbsent = actualIntegrity === null;
  const integrityIsFinal = jsonBytesEqual(actualIntegrity, finalIntegrity);
  if (!integrityIsPrevious && !integrityIsAbsent && !integrityIsFinal) {
    throw new Error("Artifact integrity.json matches neither the retained nor the proposed anchor.");
  }
  if (!isBootstrap && integrityIsAbsent) {
    throw new Error("Artifact integrity.json is missing for a non-bootstrap transaction.");
  }

  const previousPaired = isBootstrap ? stateIsAbsent : stateIsPrevious;
  if (previousPaired && integrityIsFinal) {
    throw new Error("Artifact integrity anchor is ahead of its state.");
  }
  if (stateIsNext && !isBootstrap && integrityIsAbsent) {
    throw new Error("Artifact integrity anchor is behind its state.");
  }
};

// Independently reconstructs and proves a bootstrap transaction from its input
// alone: no previous state exists to anchor against, so the proof is that the
// shared constructor, given the same resolved identity and freshly captured
// bindings, reproduces the exact persisted proposal.
const proveBootstrapTransaction = async (root, transaction) => {
  const { input, state } = transaction;
  // Historical journals without a format binding remain format 13; never
  // reinterpret them through today's creation default.
  if (state.formatVersion !== (input.formatVersion ?? input.pilotFormat ?? 13)) {
    throw new Error("Recovered artifact bootstrap does not match its format binding.");
  }
  const resolved = {
    id: state.artifactId,
    artifactType: input.artifactType,
    formatVersion: state.formatVersion,
    source: input.source,
    sourcePaths: input.sourcePaths ?? [input.source.path],
    target: input.target,
    targetPaths: targetPathsFor(input.source.path, input.target.path, input.sourcePaths ?? [input.source.path]),
    ...(input.ponytail ? { ponytail: input.ponytail } : {}),
    // The journal's design fields are optional (see validateTransactionInput);
    // absent means normal execution resolved the default, so recovery resolves
    // it through the same shared resolver rather than reproducing a record with
    // no design source at all -- which no bootstrap constructor can ever emit.
    ...resolveDesignSource({
      designSource: input.designSource,
      figma: (input.figmaSources ?? []).map((source) => source?.raw),
    }),
  };
  const [sourceBinding, targetBinding] = await Promise.all([
    captureBinding(resolved.source.root, resolved.sourcePaths, "source"),
    captureBinding(resolved.target.root, resolved.targetPaths, "target"),
  ]);
  const expectedState = initialArtifactState(resolved, sourceBinding, targetBinding, state.updatedAt);
  if (canonical(expectedState) !== canonical(state)) {
    throw new Error("Recovered bootstrap transaction does not reproduce the persisted proposal.");
  }
  const expectedEvent = eventFor(EMPTY_HISTORY, expectedState, bootstrapEventInput());
  if (canonical(expectedEvent) !== canonical(transaction.event)) {
    throw new Error("Recovered bootstrap transaction event does not reproduce the persisted proposal.");
  }
  await assertKnownRecoveryPhase(root, transaction, "");
};

export const proveFormatUpgradeTransaction = async (root, transaction) => {
  const { previousState, previousIntegrity, input, state, event } = transaction;
  const history = await readHistory(root);
  const pristine = await pristineFormatUpgrade(root, previousState, history, true);
  if (canonical(previousIntegrity) !== canonical(pristine.previousIntegrity) ||
      input.confirmationId !== pristine.confirmationId) {
    throw new Error("Recovered artifact format upgrade does not match its pristine preimage.");
  }
  const expectedState = {
    ...previousState,
    formatVersion: 14,
    revision: 1,
    updatedAt: state.updatedAt,
  };
  const expectedEvent = eventFor(pristine.bootstrapHistory, expectedState, {
    event: "FORMAT_UPGRADED", from: "DISCOVER_LEGACY", to: "DISCOVER_LEGACY", slice: null,
  });
  if (canonical(state) !== canonical(expectedState) || canonical(event) !== canonical(expectedEvent) ||
      (history.events.length === 2 && canonical(history.events[1]) !== canonical(event))) {
    throw new Error("Recovered artifact format upgrade does not reproduce its proposal.");
  }
  await assertKnownRecoveryPhase(root, transaction, pristine.bootstrapBytes);
};

// Independently reconstructs and proves an advance transaction from its
// persisted preimage: rebinds the retained previous-history prefix by its
// recorded byte/hash/count boundary, then reruns the exact same
// previewAdvance -> nextState -> eventFor chain normal execution ran, from the
// persisted previousState and exact input, and compares every field.
const proveAdvanceTransaction = async (root, transaction) => {
  const { previousState, previousIntegrity, input } = transaction;
  validateState(previousState, previousState.artifactId);
  await revalidatePins(root, previousState);
  const history = await readHistory(root);
  const prefixContent = historyPrefixContent(history.content, previousIntegrity.historyEvents);
  const expectedPreviousIntegrity = integrityFor(previousState, prefixContent);
  if (canonical(expectedPreviousIntegrity) !== canonical(previousIntegrity)) {
    throw new Error("Recovered transaction previous integrity does not match retained history.");
  }
  const prefixEvents = history.events.slice(0, previousIntegrity.historyEvents);
  if (usesArtifactDirectLedger(previousState.formatVersion)) {
    await verifyConsumedHistory(root, previousState, { events: prefixEvents });
  }
  if (history.events.length !== prefixEvents.length && history.events.length !== prefixEvents.length + 1) {
    throw new Error("Recovered transaction history has diverged from its recorded prefix.");
  }
  if (
    history.events.length === prefixEvents.length + 1 &&
    canonical(history.events.at(-1)) !== canonical(transaction.event)
  ) {
    throw new Error("Recovered transaction history already advanced past its recorded prefix.");
  }
  // previewAdvance's "CONTINUE" reports two different things through the same
  // string: genuinely ready to commit, or still waiting on unauthored
  // checkpoint artifacts (validation.ready === false, exactly the case normal
  // execution itself refuses to commit from). Only the former reproves a
  // committed transaction; an unauthored checkpoint's CONTINUE is insufficient.
  const preview = await previewAdvance(root, previousState, { slice: input.selectedSlice });
  if (preview.outcome !== "CONTINUE" || (preview.validation && !preview.validation.ready)) {
    throw new Error(`Recovered transaction cannot be reproved: ${preview.reason ?? preview.outcome}.`);
  }
  if (usesArtifactDirectLedger(previousState.formatVersion)) {
    const expectedConsumed = preview.validation.consumedDecisions ?? [];
    if (canonical(expectedConsumed) !== canonical(transaction.consumedDecisions ?? [])) {
      throw new Error("Recovered transaction cannot reprove the same consumed decision identities.");
    }
    if (expectedConsumed.length && canonical(await ledgerPrefixesFor(root)) !== canonical(transaction.decisionLedgerPrefixes)) {
      throw new Error("Recovered transaction cannot reprove its consumed decision ledger prefix/head.");
    }
  }
  const proposed = await nextState(root, previousState, preview.validation, preview.fresh, input.selectedSlice);
  const expectedState = { ...proposed, updatedAt: transaction.state.updatedAt };
  if (canonical(expectedState) !== canonical(transaction.state)) {
    throw new Error("Recovered transaction does not reproduce the persisted proposal.");
  }
  const expectedEvent = eventFor({ events: prefixEvents }, expectedState, {
    event: expectedState.status === "COMPLETE" ? "COMPLETED" : "ADVANCED",
    from: previousState.currentStep,
    to: expectedState.currentStep,
    slice: previousState.activeSlice,
    ...(usesArtifactDirectLedger(previousState.formatVersion) && preview.validation.consumedDecisions?.length
      ? { consumedDecisions: preview.validation.consumedDecisions, decisionLedgerPrefixes: transaction.decisionLedgerPrefixes }
      : {}),
  });
  if (canonical(expectedEvent) !== canonical(transaction.event)) {
    throw new Error("Recovered transaction event does not reproduce the persisted proposal.");
  }
  await assertKnownRecoveryPhase(root, transaction, prefixContent);
};

// A version-1 journal never recorded a preimage/input once state.json is
// replaced, so it cannot always be reconstructed -- this is an explicit
// compatibility limit of the old envelope, not a new lifecycle rule. Bootstrap
// (no predecessor to lose) is always reconstructible via the shared
// constructor. A non-bootstrap advance is reconstructible only while the
// still-current state.json is genuinely its unreplaced preimage; once state.json
// already shows the proposed state, the preimage is gone and recovery must fail
// closed rather than invent one.
const reconstructLegacyTransaction = async (root, transaction) => {
  if (transaction.event.from === "NOT_STARTED" && transaction.event.seq === 1) {
    await proveBootstrapTransaction(root, {
      previousState: null,
      previousIntegrity: null,
      input: {
        kind: "BOOTSTRAP",
        artifactType: transaction.state.artifactType,
        source: transaction.state.source,
        ...(transaction.state.bindings.source.paths.length > 1
          ? { sourcePaths: transaction.state.bindings.source.paths }
          : {}),
        target: transaction.state.target,
        ...(transaction.state.designSource
          ? {
              designSource: transaction.state.designSource,
              figmaSources: transaction.state.figmaSources,
            }
          : {}),
      },
      state: transaction.state,
      event: transaction.event,
    });
    return;
  }
  const onDisk = await readFile(path.join(root, STATE_FILE), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (!onDisk || canonical(onDisk) === canonical(transaction.state)) {
    throw new Error(
      "Legacy artifact transaction has no reconstructible predecessor: version 1 does not retain a preimage once state.json is replaced.",
    );
  }
  const previousState = validateState(onDisk, onDisk.artifactId);
  const selectedSlice = previousState.currentStep === "PLAN" ? transaction.state.activeSlice : previousState.activeSlice;
  const { history, matching } = await assertTransactionReplayable(root, transaction);
  // HISTORY_APPENDED still retains the previous state/integrity pair, but its
  // history already includes the proposed event. Bind only the preimage prefix;
  // the shared proof below rejects conflicting, stale, or unanchored histories.
  const prefixContent = matching
    ? historyPrefixContent(history.content, transaction.event.seq - 1)
    : history.content;
  const previousIntegrity = integrityFor(previousState, prefixContent);
  await proveAdvanceTransaction(root, {
    previousState,
    previousIntegrity,
    input: { kind: "ADVANCE", selectedSlice },
    state: transaction.state,
    event: transaction.event,
  });
};

/**
 * The identity maintenance transition, reproved from its own preimage.
 *
 * Deliberately not routed through `proveAdvanceTransaction`: there is no
 * lifecycle transition to rerun, and the proof is correspondingly narrow --
 * the proposed state must be the previous state with *only* the identity, the
 * revision and the timestamp changed. Every other field, including every pin,
 * every binding and the whole navigation, must be byte-identical.
 */
const proveToolkitIdentityTransaction = async (root, transaction) => {
  const { previousState, previousIntegrity, input } = transaction;
  validateState(previousState, previousState.artifactId);
  await revalidatePins(root, previousState);
  const history = await readHistory(root);
  const prefixContent = historyPrefixContent(history.content, previousIntegrity.historyEvents);
  if (canonical(integrityFor(previousState, prefixContent)) !== canonical(previousIntegrity)) {
    throw new Error("Recovered toolkit identity transaction previous integrity does not match retained history.");
  }
  if (toolkitIdentityKey(previousState.toolkitIdentity ?? null) !== toolkitIdentityKey(input.previous)) {
    throw new Error("Recovered toolkit identity transaction does not start from the record's own identity.");
  }
  const prefixEvents = history.events.slice(0, previousIntegrity.historyEvents);
  const expectedState = {
    ...previousState,
    toolkitIdentity: input.next,
    revision: previousState.revision + 1,
    updatedAt: transaction.state.updatedAt,
  };
  if (canonical(expectedState) !== canonical(transaction.state)) {
    throw new Error("Recovered toolkit identity transaction does not reproduce the persisted proposal.");
  }
  const expectedEvent = eventFor({ events: prefixEvents }, expectedState, {
    event: input.previous === null ? "TOOLKIT_IDENTITY_ADOPTED" : "TOOLKIT_IDENTITY_CHANGED",
    from: previousState.currentStep,
    to: previousState.currentStep,
    slice: previousState.activeSlice,
    previous: input.previous,
    next: input.next,
  });
  if (canonical(expectedEvent) !== canonical(transaction.event)) {
    throw new Error("Recovered toolkit identity transaction event does not reproduce the persisted proposal.");
  }
  await assertKnownRecoveryPhase(root, transaction, prefixContent);
};

const finishTransaction = async (targetRoot, root, transaction) => {
  const { history, matching } = await assertTransactionReplayable(root, transaction);
  // Publish the whole next history atomically under the existing record lock:
  // interrupted temporary writes leave the proven prefix untouched; rename
  // exposes only the complete event. Recovery uses the same transition proof.
  if (!matching) {
    // Preserve the existing read-only-history contract when replacing its inode.
    await access(path.join(root, HISTORY_FILE), constants.W_OK).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await atomicWrite(targetRoot, path.join(root, HISTORY_FILE), `${history.content}${JSON.stringify(transaction.event)}\n`);
  }
  await atomicWrite(targetRoot, path.join(root, STATE_FILE), jsonBytes(transaction.state));
  const finalHistory = await readHistory(root);
  await atomicWrite(
    targetRoot,
    path.join(root, INTEGRITY_FILE),
    jsonBytes(integrityFor(transaction.state, finalHistory.content)),
  );
  await rm(path.join(root, TRANSACTION_FILE), { force: true });
  return transaction.state;
};

// Normal execution establishes the transition proof once, in-memory, before
// this ever runs (see buildAdvanceTransaction / createArtifactRecord), so this
// write+finish never re-runs previewAdvance/nextState/eventFor -- it just
// persists the already-proven transaction. Recovery, invoked from a later
// process with no in-memory proof, independently reproves through
// proveBootstrapTransaction/proveAdvanceTransaction before ever reaching here.
export const writeTransaction = async (targetRoot, root, transaction) => {
  await atomicWrite(targetRoot, path.join(root, TRANSACTION_FILE), jsonBytes(transaction));
  return finishTransaction(targetRoot, root, transaction);
};

// Binds the journal to the record it was found in before any evidence in it is
// dereferenced. A transaction is content, not location: without this, a
// transaction.json copied or left over from a different artifact directory
// would be recovered as if it belonged here, writing a foreign identity's
// state into this record.
const assertTransactionBoundToRecord = (targetRoot, root, transaction) => {
  plainObject(transaction, "artifact transaction");
  plainObject(transaction.state, "artifact transaction.state");
  const expectedId = path.basename(root);
  if (transaction.state.artifactId !== expectedId) {
    throw new Error("Artifact transaction identity does not match its directory.");
  }
  exactObject(transaction.state.target, "artifact transaction.state.target", ["root", "path"]);
  if (!samePath(transaction.state.target.root, targetRoot)) {
    throw new Error("Artifact transaction target root does not match its directory.");
  }
};

export const recoverTransaction = async (targetRoot, root) => {
  const file = path.join(root, TRANSACTION_FILE);
  if (!(await exists(file))) return;
  const transaction = JSON.parse(await readFile(file, "utf8"));
  assertTransactionBoundToRecord(targetRoot, root, transaction);
  if (transaction.version === TRANSACTION_VERSION) {
    if (transaction.input?.kind === "BOOTSTRAP") {
      await proveBootstrapTransaction(root, transaction);
    } else if (transaction.input?.kind === "FORMAT_UPGRADE") {
      await proveFormatUpgradeTransaction(root, transaction);
    } else if (transaction.input?.kind === "TOOLKIT_IDENTITY") {
      await proveToolkitIdentityTransaction(root, transaction);
    } else {
      await proveAdvanceTransaction(root, transaction);
    }
  } else if (transaction.version === 1) {
    if (usesArtifactDirectLedger(transaction.state.formatVersion)) {
      throw new Error("Artifact 14 cannot be recovered from a legacy bootstrap transaction.");
    }
    await reconstructLegacyTransaction(root, transaction);
  } else {
    throw new Error(`Unsupported artifact transaction version ${transaction.version}.`);
  }
  await finishTransaction(targetRoot, root, transaction);
};

// Establishes the advance transition exactly once, in-memory, from the
// previousState/input the running command already validated via
// `previewAdvance` -- nothing here is re-derived from disk by a later caller.
export const buildAdvanceTransaction = async (root, previousState, preview, selectedSlice) => {
  await mkdir(root, { recursive: true });
  const history = await readHistory(root);
  const previousIntegrity = integrityFor(previousState, history.content);
  const proposed = await nextState(root, previousState, preview.validation, preview.fresh, selectedSlice);
  const state = { ...proposed, updatedAt: new Date().toISOString() };
  const consumedDecisions = usesArtifactDirectLedger(previousState.formatVersion) ? preview.validation.consumedDecisions ?? [] : [];
  const decisionLedgerPrefixes = consumedDecisions.length ? await ledgerPrefixesFor(root) : null;
  const event = eventFor(history, state, {
    event: state.status === "COMPLETE" ? "COMPLETED" : "ADVANCED",
    from: previousState.currentStep,
    to: state.currentStep,
    slice: previousState.activeSlice,
    ...(consumedDecisions.length ? { consumedDecisions, decisionLedgerPrefixes } : {}),
    ...(previousState.currentStep === "VERIFY_SLICES" && preview.validation.result.visualComparison?.length
      ? { visualComparison: preview.validation.result.visualComparison }
      : {}),
  });
  return {
    version: TRANSACTION_VERSION,
    previousState,
    previousIntegrity,
    input: { kind: "ADVANCE", selectedSlice: selectedSlice ?? null },
    ...(consumedDecisions.length ? { consumedDecisions, decisionLedgerPrefixes } : {}),
    state,
    event,
  };
};
