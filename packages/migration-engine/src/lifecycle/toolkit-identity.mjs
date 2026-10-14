/**
 * Lifecycle: module toolkit-identity transitions -- the record gate, automatic
 * adoption and the manual identity change. Moved verbatim from
 * `resumable-migration.mjs` (Track A8).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { engineCommand } from "../engine-paths.mjs";
import {
  autoAdoptableToolkitTransition,
  INTEGRITY_FILE,
  renderToolkitIdentity,
  sameToolkitIdentity,
  toolkitIdentityBlocker,
} from "../formats/index.mjs";
import { now } from "../shared/index.mjs";
import {
  assertHistoryAppendable,
  atomicWrite,
  migrationRoot,
  renderState,
  statePathFor,
} from "../store/index.mjs";
import { removeJournal, writeJournalAtomic } from "./journal.mjs";
import { withModuleLock } from "./lock.mjs";
import { activeToolkitIdentity } from "../toolkit-identity.mjs";
import { readContext } from "./context.mjs";
import { isAutoAuthority } from "./policy.mjs";
import {
  ADVANCE_JOURNAL,
  appendHistoryOnce,
  readState,
  recoverPendingAdvance,
  renderIntegrityNow,
} from "./record.mjs";

/**
 * One journalled transaction: preserve the prior context byte-for-byte, swap
 * the fresh evidence in, pin the contract, stamp format 17, and write an
 * immutable adoption record. No step, slice, approval, or evidence pin moves;
 * the affected slices are named and must be reopened with --reopen-ui before
 * the record resumes.
 *
 * ponytail: the record stays COMPLETE until that reopen, guarded by a resume
 * blocker. Ceiling: a reader of `status` alone misses it. Upgrade path: fold
 * the reopen into this transaction.
 */
/** The one command the fail-closed identity message ever names. */
const TOOLKIT_IDENTITY_SCRIPT = "cli/toolkit-identity.mjs";

export const toolkitAdoptCommand = (name, kind = "module") =>
  engineCommand(TOOLKIT_IDENTITY_SCRIPT, "adopt", `--${kind}`, name);

/**
 * The gate. Every module path that is about to write to a record calls this
 * first; no read-only path calls it at all.
 *
 * It is deliberately not folded into `readState`: status, validation and
 * decision *listing* must keep working on an unstamped or mismatched record --
 * refusing to let an operator look at a record is how a fail-closed gate turns
 * into an outage -- while every mutation must stop before the first byte.
 */
export const assertRecordToolkitIdentity = (state, name, action, kind = "module") => {
  const blocker = toolkitIdentityBlocker(
    state.toolkitIdentity ?? null,
    activeToolkitIdentity(),
    { action, adoptCommand: toolkitAdoptCommand(name, kind) },
  );
  if (blocker) throw Object.assign(new Error(blocker), { toolkitIdentity: true });
};

/**
 * Adoption under `--mode auto`, run before the gate rather than instead of it.
 *
 * Which build may write to a record is implementation metadata, not a migration
 * decision -- no contract, format, workflow value or pin depends on it -- and
 * the running toolkit is the authoritative source for its own identity. So
 * "this record pins 1.2.3 and I am 1.2.4" is answerable from evidence already
 * in hand, and making a human type the adopt command added a stop without
 * adding a judgement.
 *
 * It routes through `changeModuleToolkitIdentity`, so an auto adoption is the
 * same journalled transaction as a typed one and leaves the same
 * `TOOLKIT_IDENTITY_ADOPTED`/`TOOLKIT_IDENTITY_CHANGED` history event naming
 * `previous` and `next`. Nothing is adopted silently; it is adopted and
 * recorded.
 *
 * Returns `null` without writing when there is nothing to decide from: under
 * `step` a human owns the call, and a source checkout carries no
 * `build-identity.json`, so it has no identity to prove or stamp. That second
 * case is a genuine external blocker -- the gate below still refuses it, and
 * the remedy is to install a released toolkit.
 */
export const autoAdoptToolkitIdentity = async ({
  registryPath,
  moduleName,
  mode,
  // A bootstrap has no record to stamp yet; `bootstrapMigration` stamps the one
  // it creates. Passed rather than probed so this never swallows a read error
  // that means something else.
  started = true,
}) => {
  if (!started || !isAutoAuthority(mode)) return null;
  const active = activeToolkitIdentity();
  if (!active) return null;
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  const { state } = await readState(registryData.targetRoot, resolved.canonical);
  // `autoAdoptableToolkitTransition` is the whole decision, and it is narrow:
  // an unstamped record, or a strictly newer release of the same toolkit. A
  // mismatch that is not a forward upgrade -- a downgrade, or the same version
  // built twice -- returns `null` and falls through to the gate below, which
  // refuses it exactly as it always has. AUTO adopts what is verifiable; it
  // never adopts its way past a safety check.
  const transition = autoAdoptableToolkitTransition(state.toolkitIdentity ?? null, active);
  if (!transition) return null;
  return changeModuleToolkitIdentity({ registryPath, moduleName, mode: transition });
};

/**
 * Mismatch-only refusal, for the paths that legitimately operate on a record no
 * identity can have been adopted on yet.
 *
 * The v4->v5 upgrade coordinator is the whole reason this exists: a v4 tree
 * predates the standalone toolkit *and* cannot be opened by `readState`, so
 * demanding adoption first would make it permanently un-upgradable. It may
 * therefore run unstamped -- and the v5 record it produces is unstamped too, so
 * the very next lifecycle mutation still demands explicit adoption. What it may
 * never do is run against a record that pins a *different* build.
 */
export const assertToolkitIdentityNotMismatched = (recorded, action) => {
  if (!recorded) return;
  const blocker = toolkitIdentityBlocker(recorded, activeToolkitIdentity(), {
    action,
    adoptCommand: "",
  });
  if (blocker) throw Object.assign(new Error(blocker), { toolkitIdentity: true });
};

/**
 * Adopt, update or roll back the toolkit identity of one module record.
 *
 * Engine maintenance, not an operator migration decision and not a lifecycle
 * transition: it moves no step, no slice and no pin, creates no decision, and
 * touches no decision id, sequence, rationale digest, decision digest or ledger
 * hash. It runs the same journalled ordering as every other durable transition
 * -- prove history is appendable, record the intent, write the integrity
 * anchor, write state, append exactly one event, drop the journal -- so a death
 * in any gap is finished by `recoverPendingAdvance` on the next command.
 *
 * It then stops. The lifecycle resumes on the next invocation, so an adoption
 * can never be mistaken for, or ride along with, a checkpoint advance.
 */
export const changeModuleToolkitIdentity = async ({
  registryPath,
  moduleName,
  mode = "adopt",
}) => {
  if (!["adopt", "update", "rollback"].includes(mode)) {
    throw new Error(`Unknown toolkit identity mode '${mode}'.`);
  }
  const active = activeToolkitIdentity();
  if (!active) {
    throw new Error(
      "The running engine is a source checkout with no build-identity.json and has no identity to stamp. Install a released toolkit bundle and run this against that installation. Nothing was written.",
    );
  }
  const { registryData, resolved } = await readContext({ registryPath, moduleName });
  return withModuleLock(registryData.targetRoot, resolved.canonical, async () => {
    const root = migrationRoot(registryData.targetRoot, resolved.canonical);
    const statePath = statePathFor(registryData.targetRoot, resolved.canonical);
    // An interrupted lifecycle transition is completed before the record is
    // read, exactly as every other locked operation does it. Adoption never
    // stamps a half-written record.
    await recoverPendingAdvance(registryData.targetRoot, root, statePath);
    // Full integrity validation: anchor, append-only history and decision
    // ledger, and the state-graph replay. A record that cannot be proven
    // consistent is not a record an identity may be pinned to.
    const { state } = await readState(registryData.targetRoot, resolved.canonical);
    const previous = state.toolkitIdentity ?? null;
    if (mode === "adopt" && previous !== null && !sameToolkitIdentity(previous, active)) {
      throw new Error(
        `This record already pins toolkit ${renderToolkitIdentity(previous)}. Adoption is for an unstamped record; use update to move it to ${renderToolkitIdentity(active)}. Nothing was written.`,
      );
    }
    if (mode !== "adopt" && previous === null) {
      throw new Error(
        "This record carries no toolkit identity, so there is nothing to update or roll back. Adopt one first. Nothing was written.",
      );
    }
    // Idempotent and therefore replayable: re-running the command that already
    // succeeded is a no-op, not a second history event.
    if (sameToolkitIdentity(previous, active)) {
      return {
        changed: false,
        statePath,
        migrationRoot: root,
        state,
        previous,
        next: active,
        resolved,
      };
    }
    const at = now();
    const stamped = {
      ...state,
      toolkitIdentity: active,
      revision: state.revision + 1,
      updatedAt: at,
    };
    const event = {
      event: previous === null ? "TOOLKIT_IDENTITY_ADOPTED" : "TOOLKIT_IDENTITY_CHANGED",
      previous,
      next: active,
      at,
      revision: stamped.revision,
    };
    const integrityPath = path.join(root, INTEGRITY_FILE);
    const integrityBefore = await readFile(integrityPath, "utf8");
    const nextIntegrity = await renderIntegrityNow(root, stamped, event);
    const journalFile = path.join(root, ADVANCE_JOURNAL);
    await assertHistoryAppendable(registryData.targetRoot, root);
    await writeJournalAtomic(journalFile, {
      fromRevision: state.revision,
      toRevision: stamped.revision,
      event,
      startedAt: at,
      pid: process.pid,
      integrity: { content: nextIntegrity, before: integrityBefore },
    });
    await atomicWrite(registryData.targetRoot, integrityPath, nextIntegrity);
    await atomicWrite(registryData.targetRoot, statePath, renderState(stamped));
    await appendHistoryOnce(registryData.targetRoot, root, event);
    await removeJournal(journalFile);
    return {
      changed: true,
      statePath,
      migrationRoot: root,
      state: stamped,
      previous,
      next: active,
      resolved,
    };
  });
};
