import path from "node:path";
import {
  assertArray,
  assertIsoTimestamp,
  assertNonEmpty,
  assertPlainObject,
  commonAncestor,
  isLexicallyWithin as isWithin,
  issueCollector,
  throwIssues,
} from "../shared/index.mjs";
import { fileExists, fileIdentity, fileIdentityMatches, readJson } from "./files.mjs";

// Evidence was validated as "a nonempty string", so arbitrary prose and paths
// that never existed reached BUILD_BASELINE and were then hash-pinned as
// authoritative. Hash pinning protects fabricated claims from later change; it
// does not make them true. A reference that *claims* to be a file -- it names a
// path with a file extension -- must resolve to bytes that exist.
//
// ponytail: only path-shaped claims are resolved. Prose evidence stays legal
// (the contract allows it) and line ranges are ignored, so the rule adds no new
// authoring burden and cannot pass a path that is simply not there. Ceiling:
// prose is still unverifiable. Upgrade path: a machine-readable evidence
// checklist with typed locations, which is the full P1-7 repair.
export const PATH_CLAIM = /^[^\s]*\/[^\s/]+\.[A-Za-z0-9]+$/;

export const evidencePathClaim = (value) => {
  if (typeof value !== "string") return null;
  const [head] = value.trim().split(/\s+/);
  // Strip a trailing `:12`, `:12-40`, or `:12,18-40` locator.
  const candidate = head.replace(/:[0-9][0-9,\-:]*$/, "");
  return PATH_CLAIM.test(candidate) ? candidate : null;
};

export const resolveEvidencePath = async (claim, roots) => {
  if (!roots?.legacyRoot || !roots?.targetRoot) return null;
  const bases = [
    roots.legacyRoot,
    roots.targetRoot,
    commonAncestor(roots.legacyRoot, roots.targetRoot),
  ];
  for (const base of bases) {
    const absolute = path.resolve(base, claim);
    if (isWithin(base, absolute) && (await fileExists(absolute))) {
      return absolute;
    }
  }
  return null;
};

export const assertEvidenceResolves = async (values, label, roots) => {
  for (const value of values) {
    const claim = evidencePathClaim(value);
    if (!claim) continue;
    if (!(await resolveEvidencePath(claim, roots))) {
      throw new Error(
        `${label} references '${claim}', which does not exist under the legacy or target repository. Evidence must point at real observations.`,
      );
    }
  }
};

// P1-7: VERIFY_SLICES accepted bare, unverifiable command strings. Each
// command result must now be a structured record whose captured output is a
// real, hash-verified file -- the same tamper-evidence pattern as
// `assertEvidenceReference` below for FINALIZE gates.
// ponytail: this proves the *recorded* output wasn't fabricated after the
// fact; it does not re-execute the command itself (no sandboxed trusted
// runner here). Live re-execution belongs with P1-10's FINALIZE evidence
// producers, not this finding -- not implemented, not this finding's scope.
export const assertCommandResults = async (commands, label, roots) => {
  const list = assertArray(commands, label);
  if (list.length === 0) {
    throw new Error(`${label} requires at least one executed command result.`);
  }
  // QW3: every entry, and every field of an entry, is independent of the
  // others; only the digest depends on its own output file resolving.
  const { issues, add, check } = issueCollector();
  for (const [index, entry] of list.entries()) {
    const at = `${label}[${index}]`;
    if (!(await check(at, () => assertPlainObject(entry, at)))) continue;
    await check(`${at}.command`, () => assertNonEmpty(entry.command, `${at}.command`));
    if (entry.exitCode !== 0) {
      add(`${at}.exitCode`, `${at} ('${entry.command}') recorded exitCode ${entry.exitCode}; a verification command must exit 0.`, { code: "COMMAND_FAILED" });
    }
    await check(`${at}.executedAt`, () => assertIsoTimestamp(entry.executedAt, `${at}.executedAt`));
    await check(`${at}.runner`, () => assertNonEmpty(entry.runner, `${at}.runner`));
    const claim = evidencePathClaim(entry.outputPath);
    const resolved = claim && (await resolveEvidencePath(claim, roots));
    if (!resolved) {
      add(`${at}.outputPath`, `${at}.outputPath '${entry.outputPath}' does not exist under the legacy or target repository. Record the captured output as a real file.`, { code: "EVIDENCE_REFERENCE_MISSING" });
      continue;
    }
    if (!(await fileIdentityMatches(entry.outputDigest, resolved))) {
      add(`${at}.outputDigest`, `${at}.outputDigest does not match '${entry.outputPath}': recorded ${entry.outputDigest}, actual ${await fileIdentity(resolved)}.`, { code: "EVIDENCE_HASH_MISMATCH" });
    }
  }
  throwIssues(label, issues);
};

/**
 * A gate hash was only checked for shape (64 hex characters), so a fabricated
 * digest against a nonexistent file satisfied a PASS gate. When the reference
 * names a real file, the recorded hash must be that file's current digest.
 */
export const assertEvidenceReference = async (entry, label, roots, options = {}) => {
  const claim = evidencePathClaim(entry.reference);
  // ponytail: `require` is opt-in so prose references stay legal for the
  // evidence kinds whose contract allows them. UI runtime evidence opts in:
  // its whole purpose is proving a browser ran, so "observed in chromium" is
  // not evidence -- same bar as `assertCommandResults`.
  if (!claim) {
    if (!options.require) return;
    throw Object.assign(new Error(
      `${label}.reference '${entry.reference}' is not a persisted artifact path. Record the captured runtime evidence as a real file under the legacy or target repository.`,
    ), { validationCode: "EVIDENCE_REFERENCE_MISSING" });
  }
  const resolved = await resolveEvidencePath(claim, roots);
  if (!resolved) {
    throw Object.assign(new Error(
      `${label}.reference names '${claim}', which does not exist under the legacy or target repository.`,
    ), { validationCode: "EVIDENCE_REFERENCE_MISSING" });
  }
  if (!(await fileIdentityMatches(entry.hash, resolved))) {
    throw Object.assign(new Error(
      `${label}.hash does not match the current bytes of '${claim}'. Recorded ${entry.hash}, actual ${await fileIdentity(resolved)}. Regenerate the evidence against the current tree.`,
    ), { validationCode: "EVIDENCE_HASH_MISMATCH" });
  }
  return resolved;
};

/**
 * A completed slice's result.json is hash-pinned, but the outputs it cites live
 * in the repositories, where a later slice can overwrite them -- one shared
 * output file re-run for the next slice. Every recorded digest of every
 * completed slice is rechecked at every slice-phase advance, so that
 * overwrite is refused at once, naming the slice it belongs to, instead of
 * surfacing at FINALIZE (which revalidates every slice in full) after more
 * evidence was built on it.
 * ponytail: a `{reference, hash}` file that no longer resolves is left to the
 * slice's own FINALIZE revalidation; only command outputs must still exist.
 */
export const assertCompletedEvidenceIntact = async (root, completedSlices, roots) => {
  const changed = [];
  const walk = async (node, sliceId) => {
    if (Array.isArray(node)) {
      for (const item of node) await walk(item, sliceId);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [pathKey, digestKey] of [["outputPath", "outputDigest"], ["reference", "hash"]]) {
      const claim = typeof node[digestKey] === "string" ? evidencePathClaim(node[pathKey]) : null;
      if (!claim) continue;
      const resolved = (await resolveEvidencePath(claim, roots)) ??
        ((await fileExists(path.resolve(root, claim))) ? path.resolve(root, claim) : null);
      if (resolved ? !(await fileIdentityMatches(node[digestKey], resolved)) : pathKey === "outputPath") {
        changed.push(`${sliceId} ${claim}`);
      }
    }
    for (const value of Object.values(node)) await walk(value, sliceId);
  };
  for (const sliceId of completedSlices) {
    await walk(await readJson(path.join(root, "evidence", sliceId, "result.json"), `Evidence for ${sliceId}`), sliceId);
  }
  if (changed.length > 0) {
    throw Object.assign(new Error(
      `COMPLETED_EVIDENCE_CHANGED: evidence recorded by completed slices no longer matches its digest: ${changed.join(", ")}. A completed slice's evidence is immutable: restore those bytes, and record the active slice's output in its own new file. Nothing was written.`,
    ), { validationCode: "COMPLETED_EVIDENCE_CHANGED" });
  }
};
