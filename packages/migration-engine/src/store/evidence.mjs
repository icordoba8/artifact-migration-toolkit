import path from "node:path";
import {
  assertArray,
  assertIsoTimestamp,
  assertNonEmpty,
  assertPlainObject,
  commonAncestor,
  isLexicallyWithin as isWithin,
} from "../shared/index.mjs";
import { fileExists, fileIdentity, fileIdentityMatches } from "./files.mjs";

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
  for (const [index, entry] of list.entries()) {
    const at = `${label}[${index}]`;
    assertPlainObject(entry, at);
    assertNonEmpty(entry.command, `${at}.command`);
    if (entry.exitCode !== 0) {
      throw new Error(
        `${at} ('${entry.command}') recorded exitCode ${entry.exitCode}; a verification command must exit 0.`,
      );
    }
    assertIsoTimestamp(entry.executedAt, `${at}.executedAt`);
    assertNonEmpty(entry.runner, `${at}.runner`);
    const claim = evidencePathClaim(entry.outputPath);
    const resolved = claim && (await resolveEvidencePath(claim, roots));
    if (!resolved) {
      throw new Error(
        `${at}.outputPath '${entry.outputPath}' does not exist under the legacy or target repository. Record the captured output as a real file.`,
      );
    }
    if (!(await fileIdentityMatches(entry.outputDigest, resolved))) {
      throw new Error(
        `${at}.outputDigest does not match '${entry.outputPath}': recorded ${entry.outputDigest}, actual ${await fileIdentity(resolved)}.`,
      );
    }
  }
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
    throw new Error(
      `${label}.reference '${entry.reference}' is not a persisted artifact path. Record the captured runtime evidence as a real file under the legacy or target repository.`,
    );
  }
  const resolved = await resolveEvidencePath(claim, roots);
  if (!resolved) {
    throw new Error(
      `${label}.reference names '${claim}', which does not exist under the legacy or target repository.`,
    );
  }
  if (!(await fileIdentityMatches(entry.hash, resolved))) {
    throw new Error(
      `${label}.hash does not match the current bytes of '${claim}'. Recorded ${entry.hash}, actual ${await fileIdentity(resolved)}. Regenerate the evidence against the current tree.`,
    );
  }
  return resolved;
};
