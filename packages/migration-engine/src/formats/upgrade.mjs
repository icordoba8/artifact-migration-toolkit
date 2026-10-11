/** Formats: the format-upgrade walk and the upgrade transaction's pure vocabulary. */

import { createHash } from "node:crypto";
import path from "node:path";

/**
 * The format-upgrade primitives both engines share: walk the registry one
 * adjacent increment at a time, classify one increment, prove the registry
 * covers every increment from the floor to the runtime format, and project a
 * pending increment for a read-only caller.
 *
 * Pure by construction and importing neither engine. The registries they walk
 * are split (baseline §4.1): the eligibility rows (`FORMAT_INCREMENTS`,
 * `ARTIFACT_FORMAT_INCREMENTS`) are formats, and each engine joins its own
 * handlers onto them, so anything here importing an engine back would close
 * an ESM cycle around the registry it is trying to walk.
 *
 * Coverage deliberately consults nothing but `{floor, runtimeFormat, registry}`.
 * `NON_PROMOTING_FORMAT_VERSIONS`, `FORMAT_FEATURES` and
 * `SELF_HEALING_FORMAT_VERSIONS` answer different questions, and reading any of
 * them here would let a new format be declared self-healing or promoting and
 * ship with no upgrader at all.
 */

/**
 * The increment a record at `from` owes, or `null` when it owes none. Always
 * adjacent -- `to` is `from + 1` and nothing else, so no registered increment
 * can be walked past. A missing row is reported (`row: null`), never skipped:
 * the caller fails closed on it.
 */
export const nextIncrement = (registry, from, runtimeFormat, floor) => {
  if (!Number.isInteger(from) || from < floor || from >= runtimeFormat) {
    return null;
  }
  return {
    from,
    to: from + 1,
    row: registry.find((entry) => entry.from === from) ?? null,
  };
};

/**
 * The activation boundary. An increment is *owed* from the moment the record is
 * behind the runtime format, but it only becomes *exclusive* once the
 * old-format authority its upgrader consumes actually exists: a newborn record
 * whose historical lifecycle has not yet produced that authority would
 * otherwise deadlock, frozen behind an upgrade that cannot classify the
 * scaffold it is pointed at.
 *
 * Pure: persisted state only, no file reads, no writes. Fail-closed in both
 * directions -- a missing row, and a row whose `activation` the release gate
 * would have refused, are treated as active, because an increment that cannot
 * be described must never become the excuse for running lifecycle at the old
 * format.
 */
export const upgradeIsActive = (row, state) =>
  typeof row?.activation?.predicate !== "function" ||
  Boolean(row.activation.predicate(state));

/** A declarative prerequisite descriptor: three non-empty strings, no more. */
const validPrerequisite = (prerequisite) =>
  typeof prerequisite === "object" &&
  prerequisite !== null &&
  ["kind", "path", "description"].every(
    (field) =>
      typeof prerequisite[field] === "string" && prerequisite[field] !== "",
  );

/**
 * The four terminal results of one increment, and the only place they are
 * decided. `COMPLETED` is not one of them: a committed increment moves the
 * cursor, so it is no longer pending at all.
 *
 * A `NO_OP` needs no input and cannot be blocked by one -- the row's domain
 * classifier has already said this record needs none of the row's domain work,
 * and the increment still commits.
 */
export const classifyUpgrade = ({ domain, inputPresent, plan }) => {
  if (domain === "NO_OP") return { state: "READY", blockers: [] };
  if (!inputPresent) return { state: "NEEDS_INPUT", blockers: [] };
  const blockers = plan?.blockers ?? [];
  return blockers.length > 0
    ? { state: "BLOCKED", blockers }
    : { state: "READY", blockers: [] };
};

/**
 * The release gate. Bumping a runtime format without registering its adjacent
 * upgrader fails here, and no declaration anywhere else can buy it a pass.
 */
export const assertRegistryCoverage = ({ floor, runtimeFormat, registry }) => {
  const refuse = (message) => {
    throw new Error(`Format upgrade registry: ${message}`);
  };
  if (!Number.isInteger(floor) || !Number.isInteger(runtimeFormat)) {
    refuse("the floor and the runtime format must both be declared integers.");
  }
  if (floor > runtimeFormat) {
    refuse(
      `the floor ${floor} is above the runtime format ${runtimeFormat}; a record can never be below the floor and behind the runtime at once.`,
    );
  }
  const seen = new Set();
  for (const row of registry) {
    const at = `row ${JSON.stringify(row.from)} -> ${JSON.stringify(row.to)}`;
    if (!Number.isInteger(row.from) || !Number.isInteger(row.to)) {
      refuse(`${at} must declare integer from/to.`);
    }
    if (row.to !== row.from + 1) {
      refuse(`${at} is not adjacent; every upgrader moves exactly one format.`);
    }
    if (row.from < floor) {
      refuse(`${at} is below the upgrade floor ${floor}.`);
    }
    if (row.to > runtimeFormat) {
      refuse(`${at} is above the runtime format ${runtimeFormat}.`);
    }
    if (seen.has(row.from)) {
      refuse(`two rows upgrade from format ${row.from}.`);
    }
    seen.add(row.from);
    if (typeof row.id !== "string" || row.id === "") {
      refuse(`${at} must declare a non-empty id.`);
    }
    if (!Number.isInteger(row.version)) {
      refuse(`${at} must declare an integer version.`);
    }
    for (const field of ["domain", "plan", "commit"]) {
      if (typeof row[field] !== "function") {
        refuse(`${at} must declare a callable ${field}.`);
      }
    }
    if (row.requiredInput === undefined) {
      refuse(`${at} must declare requiredInput, explicitly null when it needs none.`);
    }
    // `activation` and `requiredInput` are different axes and neither implies
    // the other: the prerequisite is old-format authority the historical
    // lifecycle must already have produced before this upgrader becomes
    // exclusive, and `requiredInput` is new material asked for once it is.
    if (row.activation === undefined) {
      refuse(
        `${at} must declare activation, explicitly null when the increment is active as soon as it is owed.`,
      );
    }
    if (row.activation !== null) {
      if (
        typeof row.activation !== "object" ||
        typeof row.activation.predicate !== "function"
      ) {
        refuse(
          `${at} must declare activation as null or as an object with a callable predicate.`,
        );
      }
      if (!validPrerequisite(row.activation.prerequisite)) {
        refuse(
          `${at} must declare activation.prerequisite with a non-empty kind, path and description.`,
        );
      }
    }
  }
  for (let format = floor; format < runtimeFormat; format += 1) {
    if (!seen.has(format)) {
      refuse(
        `no registered upgrader for ${format} -> ${format + 1}. Every increment from the floor ${floor} to the runtime format ${runtimeFormat} needs exactly one.`,
      );
    }
  }
};

/**
 * The read-only projection: the pending increment with no internals attached.
 *
 * `recordFormat`/`runtimeFormat` are carried beside `from`/`to` because they
 * answer a different question -- how far behind the record is, not what the
 * next step is -- and a status reader must not have to know that at or above
 * the floor the cursor makes `recordFormat === from`.
 */
export const upgradeProjection = (pending) =>
  pending === null || pending === undefined
    ? null
    : Object.freeze({
        recordFormat: pending.recordFormat ?? pending.from,
        runtimeFormat: pending.runtimeFormat ?? pending.to,
        from: pending.from,
        to: pending.to,
        upgrader: pending.upgrader,
        state: pending.state,
        // Owed and exclusive, or owed and merely informational. A reader that
        // stops on an increment must consult this and not the mere presence of
        // a projection: an INACTIVE one describes what will be owed, not what
        // is frozen now.
        active: pending.active ?? true,
        domain: pending.domain,
        requiredInput: pending.requiredInput ?? null,
        prerequisite: pending.prerequisite ?? null,
        blockers: pending.blockers ?? [],
        nextAction: pending.nextAction,
        confirmationDigest: pending.confirmationDigest ?? null,
      });

const upgradesRoot = (targetRoot) =>
  path.join(targetRoot, ".agents/knowledge/migrations/upgrades");

export const moduleUpgradeRoot = (targetRoot, moduleName) =>
  path.join(upgradesRoot(targetRoot), moduleName);

export const transactionRoot = (targetRoot, moduleName, confirmationId) =>
  path.join(moduleUpgradeRoot(targetRoot, moduleName), confirmationId);

export const confirmationIdFor = (preview) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        sourceManifest: preview.sourceManifest,
        sourceVersions: preview.sourceVersions,
        targetVersions: preview.targetVersions,
        contractDigest: preview.contractDigest,
        openSpecDigest: preview.openSpecDigest,
        legacyCommit: preview.legacyCommit,
        decisions: preview.supportedDecisions,
        rendered: renderUpgradePreview(preview),
      }),
    )
    .digest("hex")
    .slice(0, 16);

export const renderUpgradePreview = (preview) =>
  `Upgrade pre-execution summary\n` +
  `Migration: ${preview.migration}\n` +
  `Target: ${preview.target}\n` +
  `Source: contract ${preview.sourceVersions?.contractVersion ?? "none"} format ${preview.sourceVersions?.formatVersion ?? "none"} workflow ${preview.sourceVersions?.workflowVersion ?? "none"}\n` +
  `Target: contract ${preview.targetVersions.contractVersion} format ${preview.targetVersions.formatVersion} workflow ${preview.targetVersions.workflowVersion}\n` +
  `Affected files: ${preview.affectedFiles.length > 0 ? preview.affectedFiles.join(", ") : "none"}\n` +
  `Step changes: ${preview.stepChanges.length > 0 ? preview.stepChanges.join(", ") : "none"}\n` +
  `Earliest reopened step: ${preview.reopenedStep ?? "none"}\n` +
  `Preserved completion: ${preview.preservedCompletedSteps.length > 0 ? preview.preservedCompletedSteps.join(", ") : "none"}\n` +
  `Invalidated trust: ${preview.invalidatedArtifacts.length > 0 ? preview.invalidatedArtifacts.join(", ") : "none"}\n` +
  `Superseded files: ${preview.supersededFiles.length > 0 ? preview.supersededFiles.join(", ") : "none"}\n` +
  `Missing v5 content: ${preview.missingV5Content.length > 0 ? preview.missingV5Content.join("; ") : "none"}\n` +
  `Supported decisions: none. Ambiguity refuses the upgrade instead of guessing.\n` +
  `Blockers: ${preview.blockers.length > 0 ? preview.blockers.join("; ") : "none"}\n`;

export const renderRollbackPreview = (preview) =>
  `Rollback pre-execution summary\n` +
  `Migration: ${preview.migration}\n` +
  `Restores upgrade: ${preview.restores ?? "none"}\n` +
  `Snapshot: ${preview.snapshotPath ?? "none"}\n` +
  `Current: contract ${preview.sourceVersions?.contractVersion ?? "none"} format ${preview.sourceVersions?.formatVersion ?? "none"}\n` +
  `Restored: contract ${preview.targetVersions?.contractVersion ?? "none"} format ${preview.targetVersions?.formatVersion ?? "none"}\n` +
  `Restored files: ${preview.affectedFiles.length}\n` +
  `Note: this is an operational restore, not a contract-5 to contract-4 migrator. Contract 5 refuses the restored tree until it is upgraded again.\n` +
  `Blockers: ${preview.blockers.length > 0 ? preview.blockers.join("; ") : "none"}\n`;
