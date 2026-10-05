/**
 * Protected signer service entry. Started by the OS service manager (or a
 * trusted admin) as the dedicated signer-service user from the installed
 * release; not a package bin, not reachable from the migration CLI or MCP.
 * Reads only the fixed root-owned service configuration; no env or path input.
 *
 *   serve
 *   enroll <operator> <actor> <reason> [allow-counterless]
 *   retire|revoke <credentialId> <actor> <reason>
 *   reconcile <nonce> <actor> <reason>
 */
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readFile } from "node:fs/promises";

import { isMainModule } from "./engine-paths.mjs";
import {
  createOperatorSigner,
  openSignerStore,
  readRootOwnedJson,
  readSignerActivation,
  startReviewCompanion,
} from "./operator-signer.mjs";
import {
  beginAttestedDecision,
  completeAttestedDecision,
  renderDecisionReview,
  reviewAttestedCandidate,
} from "./record-decision.mjs";
import { activeToolkitIdentity } from "./toolkit-identity.mjs";

export const SERVICE_CONFIG_FILE = "/etc/artifact-migration-tools/operator-signer/service.json";

const writeOperatorOnly = async (file, text) => {
  const handle = await open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
};

export const runSignerService = async ([command, ...rest], { stdout = process.stdout } = {}) => {
  const config = await readRootOwnedJson(SERVICE_CONFIG_FILE);
  if (!config) throw new Error(`SIGNER_UNAVAILABLE: no protected service configuration at ${SERVICE_CONFIG_FILE}.`);
  if (!Number.isSafeInteger(config.serviceUid) || process.getuid() !== config.serviceUid || process.getuid() === 0) {
    throw new Error("SIGNER_UNAVAILABLE: the signer runs only as its configured dedicated non-root service user.");
  }
  const store = await openSignerStore({ directory: config.storeDirectory, origin: config.origin, rpID: config.rpID });
  const signer = createOperatorSigner(store);
  const tls = { key: await readFile(config.tlsKeyFile), cert: await readFile(config.tlsCertFile) };
  const [subject, actor, reason, flag] = rest;
  if (command === "retire" || command === "revoke") {
    signer.setCredentialStatus({ credentialId: subject, status: command === "retire" ? "RETIRED" : "REVOKED", actor, reason });
    return stdout.write(`${command} ${subject}\n`);
  }
  if (command === "reconcile") return stdout.write(`${await signer.reconcile({ nonce: subject, actor, reason })}\n`);
  if (command !== "serve" && command !== "enroll") throw new Error("Usage: operator-signer-service.mjs serve | enroll | retire | revoke | reconcile");
  const enrollment = command === "enroll" ? { operator: subject, actor, reason, allowCounterless: flag === "allow-counterless" } : null;
  if (!enrollment) {
    // Gate 3: no decision is served unless the protected manifest checks out
    // AND this build permits writes. In this build it never does.
    const activation = await readSignerActivation({ build: activeToolkitIdentity(), registryId: signer.registryId });
    if (!activation.writesEnabled) {
      throw new Error(`SIGNER_UNAVAILABLE: HUMAN_ATTESTED writes are not activated (${activation.state}: ${activation.problems.join("; ") || "writes disabled in this build"}).`);
    }
  }
  const loginToken = randomBytes(32).toString("base64url");
  const companion = await startReviewCompanion({
    signer, tls, port: config.port, targets: config.targets ?? {}, loginToken, enrollment,
    engine: { review: reviewAttestedCandidate, begin: beginAttestedDecision, complete: completeAttestedDecision, renderReview: renderDecisionReview },
  });
  await writeOperatorOnly(config.loginTokenFile, `${config.origin}/login?token=${loginToken}\n`);
  return companion;
};

if (isMainModule(import.meta.url)) {
  runSignerService(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 3;
  });
}
