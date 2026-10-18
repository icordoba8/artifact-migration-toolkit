/**
 * Lifecycle: format 21's legacy API response contract at VERIFY_SLICES and
 * FINALIZE -- always the contract DISCOVERY_COMPLETENESS pinned, never a newly
 * authored claim.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { discoveryDigest, unplannedResponses, unprovenResponses } from "../census/index.mjs";
import { DISCOVERY_SCAN_FILE, requirementsSourceFor, usesApiContract } from "../formats/index.mjs";
import { evidencePathClaim, readJson, resolveEvidencePath } from "../store/index.mjs";

/**
 * The contract DISCOVERY_COMPLETENESS pinned, never a newly authored claim.
 * The scan file is regenerated machine output, so it is trusted only while its
 * own fields still hash to the digest it records -- the digest
 * `validateCompletedHashes` holds to the pin. The running advance has already
 * checked the OpenSpec bytes against the record's digest.
 */
const pinnedApiContext = async (root, state, roots) => {
  const scan = await readJson(path.join(root, DISCOVERY_SCAN_FILE), "Discovery scan");
  if (!scan?.apiContract || discoveryDigest(scan) !== scan.discoveryDigest) {
    throw new Error(`${DISCOVERY_SCAN_FILE} no longer hashes to its recorded discovery digest, so its API response contract cannot be trusted. Reopen discovery with --reopen-discovery.`);
  }
  const content = await readFile(path.join(roots.targetRoot, requirementsSourceFor(state.targetModule)), "utf8");
  return { contract: scan.apiContract, content };
};

/**
 * A slice tracing a scenario that cites a legacy response proves that exact
 * response in its own hash-verified command output: a passing test named
 * `Response: <identity>`, and no failing one. The output is the agent's run,
 * not an engine re-execution; what it can no longer do is leave a response out.
 */
export const assertApiResponseEvidence = async ({ root, state, roots, sliceId, scenarioIds, commands }) => {
  if (!usesApiContract(state)) return;
  const { contract, content } = await pinnedApiContext(root, state, roots);
  const outputs = [];
  for (const command of commands ?? []) {
    const claim = evidencePathClaim(command?.outputPath);
    const resolved = claim && (await resolveEvidencePath(claim, roots));
    if (resolved) outputs.push(await readFile(resolved, "utf8"));
  }
  const missing = unprovenResponses(contract, content, scenarioIds, outputs);
  if (missing.length > 0) {
    throw Object.assign(new Error(`API_RESPONSE_UNVERIFIED: ${sliceId} traces scenarios citing legacy responses its executed evidence does not prove: ${missing.map((o) => `'${o.id}'`).join(", ")}. Add a passing test named 'Response: <identity>' for each to a recorded evidence command, rerun it, and record its output.`),
      { validationCode: "API_RESPONSE_UNVERIFIED" });
  }
};

/** FINALIZE: every pinned response is owed by at least one planned slice. */
export const assertApiContractPlanned = async ({ root, state, roots, slices }) => {
  if (!usesApiContract(state)) return;
  const { contract, content } = await pinnedApiContext(root, state, roots);
  const unplanned = unplannedResponses(contract, content, slices);
  if (unplanned.length > 0) {
    throw Object.assign(new Error(`API_RESPONSE_UNPLANNED: no slice traces a scenario citing ${unplanned.map((o) => `'${o.id}'`).join(", ")}. Every legacy response must be verified by a slice before FINALIZE.`),
      { validationCode: "API_RESPONSE_UNPLANNED" });
  }
};
