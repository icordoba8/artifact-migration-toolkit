/**
 * Lifecycle: the artifact FINALIZE gate evidence -- the scope and binding every
 * gate evidence entry carries, and the typed Ponytail evidence layered on top.
 * Moved out of `artifact-checkpoints.mjs`, which may not grow.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertArray as arrayOf,
  assertSecurePath,
  exactObject,
  normalizeRelative,
  sameMembers,
  sha256Hex as sha256,
} from "../shared/index.mjs";
import { secureHash, STATE_ROOT } from "../store/index.mjs";

// Gate evidence is a claim about *this* migration. A bare hash of any file that
// happens to exist proved nothing: the cited path must be one this migration
// changed or declared as a target file, or the seven canonical gates are
// satisfiable by an unrelated pre-existing file.
export const validateGateEvidence = async (state, item, label, scope, extra = []) => {
  exactObject(item, label, ["path", "sha256", "boundTo", ...extra]);
  const relative = normalizeRelative(item.path, `${label}.path`);
  if (scope && !scope.has(relative)) {
    throw new Error(
      `${label} cites '${relative}', which is not one of this migration's changed or declared target files.`,
    );
  }
  if ((await secureHash(state.target.root, relative, `${label}.path`)) !== item.sha256) throw new Error(`${label}.sha256 does not match ${relative}.`);
  exactObject(item.boundTo, `${label}.boundTo`, ["sourceDigest", "targetDigest"]);
  if (item.boundTo.sourceDigest !== state.bindings.source.digest || item.boundTo.targetDigest !== state.bindings.target.digest) {
    throw new Error(`${label} is stale.`);
  }
};

export const ponytailTime = (value, label) => {
  const time = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return time;
};

const REVIEW_BINDING = /^<!-- ponytail-review (\{.*\}) -->\r?\n/;

/**
 * M9-R1 D1. A file hash proves the review file is unchanged, never what it
 * reviewed: a one-line note satisfied the gate. The review now opens with a
 * binding line naming this record and the exact bytes it reviewed -- every
 * file this migration changed (the bound target when nothing changed) at its
 * current hash -- followed by the review output itself.
 *
 * ponytail: a content binding, not provenance. Any writer of the target tree
 * can author a well-formed binding line; nothing here proves the Ponytail
 * Review skill ran. Upgrade path: a review receipt from an authority the agent
 * cannot write (the operator signer is the only one this toolkit has).
 */
const validateReviewBinding = async (state, bytes, label, reviewedFiles) => {
  const text = bytes.toString("utf8");
  const match = REVIEW_BINDING.exec(text);
  if (!match) {
    throw new Error(`${label} must open with its '<!-- ponytail-review {...} -->' binding line (references/artifact-contract.md#finalize).`);
  }
  let binding;
  try {
    binding = JSON.parse(match[1]);
  } catch {
    throw new Error(`${label} binding line is not JSON.`);
  }
  exactObject(binding, `${label} binding`, ["artifactId", "createdAt", "files"]);
  if (binding.artifactId !== state.artifactId || binding.createdAt !== state.createdAt) {
    throw new Error(`${label} belongs to another migration record (artifactId/createdAt).`);
  }
  const paths = [];
  for (const [index, file] of arrayOf(binding.files, `${label} binding.files`).entries()) {
    exactObject(file, `${label} binding.files[${index}]`, ["path", "sha256"]);
    const relative = normalizeRelative(file.path, `${label} binding.files[${index}].path`);
    if ((await secureHash(state.target.root, relative, `${label} binding.files[${index}].path`)) !== file.sha256) {
      throw new Error(`${label} reviewed an outdated version of ${relative}.`);
    }
    paths.push(relative);
  }
  sameMembers(paths, [...reviewedFiles], `${label} reviewed files`);
  if (text.slice(match[0].length).trim() === "") throw new Error(`${label} carries no review output.`);
};

export const validatePonytailEvidence = async (state, gate, kind, reviewedFiles) => {
  const label = `final gate '${gate.name}' ponytailEvidence`;
  const item = gate.ponytailEvidence;
  if (!item) throw new Error(`Ponytail target '${state.ponytail}' requires ${gate.name} ${kind} evidence.`);
  const expectedPath = `${STATE_ROOT}/${state.artifactId}/evidence/ponytail-${kind}.md`;
  if (item.path !== expectedPath) throw new Error(`${label}.path must be '${expectedPath}'.`);
  await validateGateEvidence(state, item, label, null, ["kind", "producedAt"]);
  if (item.kind !== kind) throw new Error(`${label}.kind must be '${kind}'.`);
  // A record completed before the binding existed keeps its supported
  // re-validation: its review bytes are pinned through gates.json, and a
  // record completed since passed this check at FINALIZE.
  if (kind === "review" && state.status !== "COMPLETE") {
    const file = path.join(state.target.root, expectedPath);
    await assertSecurePath(state.target.root, file);
    const bytes = await readFile(file);
    if (sha256(bytes) !== item.sha256) throw new Error(`${label}.sha256 does not match ${expectedPath}.`);
    await validateReviewBinding(state, bytes, label, reviewedFiles);
  }
  return ponytailTime(item.producedAt, `${label}.producedAt`);
};
