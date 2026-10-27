/**
 * Slices: verification freshness at FINALIZE (M14.1).
 *
 * VERIFY_SLICES records, on its own engine-written history event, the content
 * identity of every file the verified slice claims. FINALIZE takes each
 * completed slice's newest snapshot (a reworked or reopened slice verifies
 * again) and judges each file by the latest of them that covered it -- a later
 * slice may rewrite an earlier slice's file and verify it again. A file that
 * changed after that verification is source no slice evidence was produced
 * against. Such a change passes only with FINAL_VERIFY evidence written after it.
 *
 * The snapshot rides on the history event, which replay ignores field by
 * field, so no record format moves. A slice verified before this rule existed
 * has no snapshot and is not judged by it.
 * Ceiling: "written after" is the evidence file's modification time, the same
 * fact the gate prefill already trusts; the engine does not re-run the agent's
 * commands. Upgrade path: engine-executed receipts, as the artifact engine has.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { initialArtifacts } from "../formats/index.mjs";
import { isLexicallyWithin, isPlainObject } from "../shared/index.mjs";
import {
  evidencePathClaim,
  fileIdentity,
  readHistoryEvents,
  readJson,
  resolveEvidencePath,
} from "../store/index.mjs";
import { canonicalClaim } from "./claims.mjs";

/** The VERIFY_SLICES event's `verifiedFiles`: target-relative path -> content identity, sorted. */
export const verifiedFileIdentities = async (root, sliceId, roots) => {
  const record = await readJson(path.join(root, `slices/${sliceId}.json`), `Slice ${sliceId}`);
  const rows = [];
  for (const changed of Array.isArray(record?.changedFiles) ? record.changedFiles : []) {
    if (typeof changed !== "string") continue;
    const relative = await canonicalClaim(changed, roots);
    const absolute = relative && path.join(roots.targetRoot, relative);
    // Only a file inside the target has bytes this verification ran against.
    const identity = absolute && isLexicallyWithin(roots.targetRoot, absolute) ? await fileIdentity(absolute).catch(() => null) : null;
    if (identity) rows.push([relative, identity]);
  }
  return Object.fromEntries(rows.sort(([left], [right]) => left.localeCompare(right)));
};

export const assertVerificationFresh = async ({ root, state, roots }) => {
  if (!roots?.targetRoot) return;
  const completed = new Set(state?.completedSlices ?? []);
  // Slice -> its newest snapshot, in the order those verifications ran.
  const snapshots = new Map();
  for (const event of await readHistoryEvents(root)) {
    if (event.event !== "STEP_COMPLETED" || event.step !== "VERIFY_SLICES" || !completed.has(event.slice) ||
      !isPlainObject(event.verifiedFiles)) continue;
    snapshots.delete(event.slice);
    snapshots.set(event.slice, event.verifiedFiles);
  }
  const verified = new Map();
  for (const [slice, files] of snapshots) {
    for (const [file, identity] of Object.entries(files)) verified.set(file, { identity, slice });
  }
  const changed = [];
  for (const [file, { identity, slice }] of verified) {
    const absolute = path.join(roots.targetRoot, file);
    // A deleted claimed file is refused by the slice's own claim validation.
    const current = await fileIdentity(absolute).catch(() => null);
    if (current !== null && current !== identity) changed.push({ file, slice, at: (await stat(absolute)).mtimeMs });
  }
  if (changed.length === 0) return;
  const newest = Math.max(...changed.map((entry) => entry.at));
  const gates = await readJson(path.join(root, initialArtifacts.gates), "Final gates");
  const finalVerify = (Array.isArray(gates?.gates) ? gates.gates : []).find((gate) => gate?.gate === "FINAL_VERIFY");
  for (const entry of Array.isArray(finalVerify?.evidence) ? finalVerify.evidence : []) {
    const claim = evidencePathClaim(entry?.reference);
    const resolved = claim && (await resolveEvidencePath(claim, roots));
    // The changed source itself is never evidence about the change.
    if (!resolved || verified.has(path.relative(roots.targetRoot, resolved).replaceAll(path.sep, "/"))) continue;
    if ((await stat(resolved)).mtimeMs >= newest) return;
  }
  throw Object.assign(new Error(
    `STALE_VERIFICATION_EVIDENCE: ${changed.map(({ file, slice }) => `'${file}' (verified by ${slice})`).join(", ")} changed after VERIFY_SLICES verified ${changed.length === 1 ? "it" : "them"}, and no FINAL_VERIFY evidence file was written after the change. Slice evidence was produced against the earlier bytes. Re-run the verification against the current files, record its output as FINAL_VERIFY evidence (rebind gates.json), or restore the verified bytes.`,
  ), { validationCode: "STALE_VERIFICATION_EVIDENCE" });
};
