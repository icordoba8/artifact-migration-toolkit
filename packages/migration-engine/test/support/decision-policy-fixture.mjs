import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { DEFAULT_DECISION_POLICY_DIGEST } from "../../src/resumable-migration.mjs";

export const protectedPolicyDocument = (projectRoot, rules = {}, previous) => {
  const policy = { policyId: "admin/high-assurance", projectRoot,
    revision: (previous?.policy.revision ?? 0) + 1,
    rules: Object.fromEntries(Object.entries(rules).sort(([a], [b]) => a < b ? -1 : 1)) };
  return { policy,
    policyDigest: `sha256:${createHash("sha256").update(JSON.stringify(policy)).digest("hex")}`,
    provenance: { action: "OPERATOR_ADMIN_POLICY_CHANGE", actor: "fixture-admin",
      at: "2026-10-05T00:00:00.000Z", reason: "Explicit protected test policy",
      previousPolicyDigest: previous?.policyDigest ?? DEFAULT_DECISION_POLICY_DIGEST },
    ...(previous ? { previous } : {}) };
};

// The real resolver reads a simulated protected filesystem. No production
// policy injection seam, root permissions, /etc writes or service is needed.
export const withDecisionPolicy = async (document, run) => {
  const fs = createRequire(import.meta.url)("node:fs/promises");
  const { lstat, open } = fs;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const directory = "/etc/artifact-migration-tools";
  const absent = () => { throw Object.assign(new Error("No protected policy"), { code: "ENOENT" }); };
  fs.lstat = async (file, ...args) => file === directory && !document ? absent() : ["/", "/etc", directory].includes(file)
    ? { isDirectory: () => true, uid: 0, mode: 0o755 } : lstat(file, ...args);
  fs.open = async (file, ...args) => file === `${directory}/decision-policy.json`
    ? document ? { stat: async () => ({ isFile: () => true, uid: 0, mode: 0o644 }),
      readFile: async () => JSON.stringify(typeof document === "function" ? document() : document), close: async () => {} } : absent()
    : open(file, ...args);
  Object.defineProperty(process, "platform", { value: "linux" });
  syncBuiltinESMExports();
  try { return await run(); }
  finally {
    fs.lstat = lstat;
    fs.open = open;
    Object.defineProperty(process, "platform", platform);
    syncBuiltinESMExports();
  }
};
