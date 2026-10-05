/**
 * The decision recorder's whole job is being un-usable by an agent.
 *
 * The tests that matter here are the refusals: no TTY, wrong challenge, broken
 * chain. Everything else is bookkeeping.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  auditDecisionLedger,
  buildDecision,
  challengeFor,
  parseDecisionArguments,
  rationaleDigestOf,
  renderDecisionReview,
  reviewFor,
  runRecordDecisionCli,
} from "../../src/record-decision.mjs";
import {
  candidateDigestOf,
  createDecisionCandidate,
  createNewFormatDecisionCandidate,
  createNewFormatDecisionGroup,
  DECISION_GROUP_KIND,
  DEFAULT_DECISION_POLICY_DIGEST,
  DEFAULT_DECISION_POLICY_ID,
  decisionAppliesToCandidate,
  decisionLineDigest,
  decisionPrincipalOf,
  readAutoDecisions,
  readOperatorDecisions,
  principalSatisfiesRequirement,
  projectModuleDecision,
  readRecordedDecisions,
  resolveGroupDecision,
  validateProtectedDecisionPolicy,
} from "../../src/resumable-migration.mjs";

const execFileAsync = promisify(execFile);
const here = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src",
);
const frozenLedger = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/compatibility-record/.agents/knowledge/migrations/modules/catalog-sync/decisions/operator-decisions.ndjson",
);

const chain = (statements) => {
  const decisions = [];
  for (const [index, statement] of statements.entries()) {
    decisions.push(
      buildDecision({
        previous: decisions.at(-1) ?? null,
        kind: "EXCLUSION",
        subjectType: "FILE",
        subject: `src/f${index}.tsx`,
        statement,
        rationale: `Rationale ${index}`,
        boundTo: { module: "auth", legacyRevision: "abc", discoveryDigest: "sha256:d", algorithmVersion: 1 },
        at: `2026-08-1${index}T00:00:00.000Z`,
        operator: "tester@host",
      }),
    );
  }
  return decisions;
};

const withDecisions = async (lines) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sm-decisions-"));
  await mkdir(path.join(root, "decisions"), { recursive: true });
  await writeFile(
    path.join(root, "decisions/operator-decisions.ndjson"),
    lines.length === 0 ? "" : `${lines.join("\n")}\n`,
  );
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
};

test("a non-interactive approval refuses before registry or state work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sm-decisions-"));
  try {
    const written = [];
    const result = await runRecordDecisionCli(
      ["auth", "--approve", "APP-stale"],
      {
        stdin: { isTTY: false },
        stdout: { isTTY: false, write: (chunk) => written.push(chunk) },
      },
    );
    assert.equal(result.blocked, true);
    assert.match(written.join(""), /nothing was read or written/);
    // The cwd has no registry or state. Reaching either would have thrown.
    assert.deepEqual(
      (await execFileAsync("git", ["--version"])).stdout.length > 0,
      true,
    );
  } finally {
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
  }
});

test("running the recorder as a child process (no TTY) refuses with exit code 2", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sm-decisions-"));
  try {
    const child = await execFileAsync(
      process.execPath,
      [
        path.join(here, "record-decision.mjs"),
        "auth",
        "--approve",
        "APP-stale",
      ],
      { cwd: root, encoding: "utf8" },
    ).catch((error) => error);
    assert.equal(child.code, 2);
    assert.match(child.stdout, /nothing was read or written/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the challenge phrase is derived from the subject, so it approves one thing", () => {
  const candidate = (id, kind, subject) => ({
    id,
    kind,
    subject: { type: "FILE", path: subject },
  });
  assert.equal(
    challengeFor(
      candidate(
        "APP-123",
        "EXCLUSION",
        "src/features/auth/components/login/background.tsx",
      ),
    ),
    "APPROVE APP-123 EXCLUSION src/features/auth/components/login/background.tsx",
  );
  assert.notEqual(
    challengeFor(candidate("APP-a", "EXCLUSION", "src/a.tsx")),
    challengeFor(candidate("APP-b", "EXCLUSION", "src/b.tsx")),
  );
  assert.notEqual(
    challengeFor(candidate("APP-a", "EXCLUSION", "src/a.tsx")),
    challengeFor(candidate("APP-c", "DEAD_CONFIRMATION", "src/a.tsx")),
  );
});

test("a decision applies only to the exact current candidate", () => {
  const candidate = createDecisionCandidate({
    kind: "EXCLUSION",
    subjectType: "FILE",
    subjectPath: "src/auth/background.tsx",
    rationale: "Decorative only.",
    targets: ["src/auth/background.tsx"],
    boundTo: {
      module: "auth",
      legacyRevision: "abc",
      legacyDirtyDigest: "sha256:dirty",
      discoveryDigest: "sha256:discovery",
      algorithmVersion: 2,
    },
  });
  const exact = {
    candidateId: candidate.id,
    kind: candidate.kind,
    subject: candidate.subject,
    targets: candidate.targets,
    rationaleDigest: candidate.rationaleDigest,
    boundTo: candidate.boundTo,
  };
  assert.equal(decisionAppliesToCandidate(exact, candidate), true);
  for (const mismatch of [
    { candidateId: "APP-stale" },
    { kind: "DEAD_CONFIRMATION" },
    { subject: { ...exact.subject, type: "MODULE_EDGE" } },
    { subject: { ...exact.subject, path: "src/auth/other.tsx" } },
    { targets: [] },
    { rationaleDigest: "sha256:stale" },
    { boundTo: { ...exact.boundTo, module: "users" } },
    { boundTo: { ...exact.boundTo, legacyRevision: "old" } },
    { boundTo: { ...exact.boundTo, legacyDirtyDigest: "sha256:old" } },
    { boundTo: { ...exact.boundTo, discoveryDigest: "sha256:old" } },
    { boundTo: { ...exact.boundTo, algorithmVersion: 1 } },
  ]) {
    assert.equal(
      decisionAppliesToCandidate({ ...exact, ...mismatch }, candidate),
      false,
    );
  }
});

test("a valid chain reads back; a truncated, reordered, or edited line does not", async () => {
  const decisions = chain(["first", "second", "third"]);
  const lines = decisions.map((decision) => JSON.stringify(decision));

  const good = await withDecisions(lines);
  try {
    const { decisions: read } = await readOperatorDecisions(good.root);
    assert.equal(read.length, 3);
    assert.equal(read[0].prevDigest, "genesis");
    assert.equal(read[1].prevDigest, decisionLineDigest(read[0]));
  } finally {
    await good.cleanup();
  }

  const truncated = await withDecisions([lines[0], lines[2]]);
  try {
    await assert.rejects(readOperatorDecisions(truncated.root), /chains to|records seq/);
  } finally {
    await truncated.cleanup();
  }

  const reordered = await withDecisions([lines[0], lines[2], lines[1]]);
  try {
    await assert.rejects(readOperatorDecisions(reordered.root), /chains to|records seq/);
  } finally {
    await reordered.cleanup();
  }

  const edited = await withDecisions([
    lines[0],
    JSON.stringify({ ...decisions[1], statement: "rewritten" }),
    lines[2],
  ]);
  try {
    await assert.rejects(readOperatorDecisions(edited.root), /chains to/);
  } finally {
    await edited.cleanup();
  }
});

const rechain = (decisions) =>
  decisions.map((decision, index, chained) => {
    const next = {
      ...decision,
      id: `DEC-${String(index + 1).padStart(3, "0")}`,
      seq: index + 1,
      prevDigest: index === 0 ? "genesis" : decisionLineDigest(chained[index - 1]),
    };
    chained[index] = next;
    return next;
  });

test("the synthetic 16-member decision group audits exactly", async () => {
  const lines = (await readFile(frozenLedger, "utf8")).trim().split("\n");
  const report = auditDecisionLedger(lines);
  assert.equal(report.outcome, "CONSISTENT");
  assert.equal(report.lines, 37);
  const grouped = lines.map(JSON.parse).filter((line) => line.authorizedBy);
  assert.equal(grouped.length, 16);
  assert.deepEqual(
    grouped.map((line) => line.authorizedBy.index),
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
});

test("group audit rejects tampering, reordering, and an incomplete append", async () => {
  const original = (await readFile(frozenLedger, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  const assertGroupFailure = (decisions, code) => {
    const report = auditDecisionLedger(
      rechain(decisions).map((decision) => JSON.stringify(decision)),
    );
    assert.equal(report.outcome, "INCONSISTENT");
    assert.ok(report.findings.some((finding) => finding.code === code));
  };

  const tampered = structuredClone(original);
  tampered[20].subject.path += ".tampered";
  assertGroupFailure(tampered, "GROUP_BINDING_MISMATCH");

  const reordered = structuredClone(original);
  [reordered[20], reordered[21]] = [reordered[21], reordered[20]];
  assertGroupFailure(reordered, "GROUP_INCOMPLETE");

  assertGroupFailure(original.filter((_, index) => index !== 25), "GROUP_INCOMPLETE");
});

test("an absent decision file is legal and reads as empty", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sm-decisions-"));
  try {
    const { decisions, byId } = await readOperatorDecisions(root);
    assert.deepEqual(decisions, []);
    assert.equal(byId.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("O_APPEND keeps concurrent writers from losing a line", async () => {
  const f = await withDecisions([]);
  try {
    const file = path.join(f.root, "decisions/operator-decisions.ndjson");
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        appendFile(file, `${JSON.stringify({ n: index })}\n`, { flag: "a" }),
      ),
    );
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    assert.equal(lines.length, 20);
  } finally {
    await f.cleanup();
  }
});

test("the rationale digest ignores line endings and surrounding whitespace only", () => {
  assert.equal(rationaleDigestOf("a\r\nb\n"), rationaleDigestOf("  a\nb  "));
  assert.notEqual(rationaleDigestOf("a\nb"), rationaleDigestOf("a\nc"));
});

test("argument parsing requires exactly one deterministic mode", () => {
  assert.throws(
    () => parseDecisionArguments(["auth"]),
    /exactly one/,
  );
  assert.throws(
    () => parseDecisionArguments(["auth", "--pending", "--approve", "APP-a"]),
    /exactly one/,
  );
  assert.deepEqual(parseDecisionArguments(["auth", "--list"]), {
    moduleName: "auth",
    approve: undefined,
    list: true,
    pending: false,
    verify: false,
    registryOption: undefined,
  });
  assert.deepEqual(parseDecisionArguments(["auth", "--pending"]), {
    moduleName: "auth",
    approve: undefined,
    list: false,
    pending: true,
    verify: false,
    registryOption: undefined,
  });
});

test("an artifact approval parses with no argv-reachable approval channel", () => {
  const parsed = parseDecisionArguments([
    "--artifact",
    "widget",
    "--type",
    "component",
    "--source-root",
    "/legacy",
    "--target-root",
    "/target",
    "--approve",
    "APP-x",
  ]);
  assert.equal("ask" in parsed, false);
  assert.equal(parsed.moduleName, undefined);
  assert.equal(parsed.artifact.source, "widget");
  assert.equal(parsed.artifact.type, "component");
  assert.equal(parsed.approve, "APP-x");
});

test("an artifact and a module positional cannot be combined", () => {
  assert.throws(
    () => parseDecisionArguments(["auth", "--artifact", "widget", "--pending"]),
    /Usage: record-decision.mjs --artifact/,
  );
});

/* ---------------- Decision-line schema v2 (principal/result/digest) ---------------- */

const v2Candidate = createDecisionCandidate({
  kind: "EXCLUSION",
  subjectType: "FILE",
  subjectPath: "src/auth/background.tsx",
  rationale: "Decorative only.",
  targets: ["src/auth/background.tsx"],
  boundTo: {
    module: "auth",
    legacyRevision: "abc",
    legacyDirtyDigest: "sha256:dirty",
    discoveryDigest: "sha256:discovery",
    algorithmVersion: 2,
  },
});

const v2Line = (previous, overrides = {}) =>
  buildDecision({
    previous,
    kind: v2Candidate.kind,
    subjectType: v2Candidate.subject.type,
    subject: v2Candidate.subject.path,
    statement: "Relayed decision.",
    rationale: v2Candidate.rationale,
    candidateId: v2Candidate.id,
    targets: v2Candidate.targets,
    boundTo: v2Candidate.boundTo,
    at: "2026-10-02T00:00:00.000Z",
    operator: "tester@host",
    principal: "AGENT_RELAYED",
    result: "APPROVED",
    candidateDigest: candidateDigestOf(v2Candidate),
    ...overrides,
  });

const frozenLines = async () =>
  (await readFile(frozenLedger, "utf8")).trim().split("\n");

const withLedger = async (file, lines) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sm-decisions-"));
  await mkdir(path.join(root, "decisions"), { recursive: true });
  await writeFile(path.join(root, file), `${lines.join("\n")}\n`);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
};

test("legacy lines, candidate ids and digests are byte-identical to the pre-v2 engine", async () => {
  // Golden values produced by the engine before schema v2 existed.
  const legacy = buildDecision({
    previous: null,
    kind: "EXCLUSION",
    subjectType: "FILE",
    subject: "src/a.tsx",
    statement: "Approved stable candidate APP-x by operator at a terminal.",
    rationale: "Decorative.",
    candidateId: "APP-x",
    targets: ["src/a.tsx"],
    boundTo: { module: "auth", legacyRevision: "abc", legacyDirtyDigest: "sha256:dirty", discoveryDigest: "sha256:d", algorithmVersion: 2 },
    at: "2026-08-10T00:00:00.000Z",
    operator: "tester@host",
  });
  assert.equal(
    decisionLineDigest(legacy),
    "sha256:bca03745c383fa9f508ebf2efa708e7ba4c2faaa5ea05f121d585042ebcb94d2",
  );
  for (const field of ["v", "principal", "result", "candidateDigest"]) {
    assert.equal(field in legacy, false);
  }
  assert.equal(v2Candidate.id, "APP-a631ea8835093dccaf8f");
  assert.equal(candidateDigestOf(v2Candidate).slice(7, 27), v2Candidate.id.slice(4));

  // The frozen record: every line re-serializes to its own bytes, stays
  // legacy, and is historical LEGACY_HUMAN -- never HUMAN_ATTESTED.
  const lines = await frozenLines();
  for (const line of lines) {
    const decision = JSON.parse(line);
    assert.equal(JSON.stringify(decision), line);
    assert.equal(decisionPrincipalOf(decision), "LEGACY_HUMAN");
  }
});

test("v2 APPROVED and REJECTED lines continue the legacy DEC chain without moving its anchor", async () => {
  const lines = await frozenLines();
  const legacy = lines.map(JSON.parse);
  const approved = v2Line(legacy.at(-1));
  const rejected = v2Line(approved, { result: "REJECTED" });
  assert.equal(approved.id, `DEC-${String(legacy.length + 1).padStart(3, "0")}`);
  assert.equal(rejected.id, `DEC-${String(legacy.length + 2).padStart(3, "0")}`);
  assert.equal(approved.prevDigest, decisionLineDigest(legacy.at(-1)));
  assert.equal(rejected.prevDigest, decisionLineDigest(approved));

  const all = [...lines, JSON.stringify(approved), JSON.stringify(rejected)];
  assert.equal(auditDecisionLedger(all).outcome, "CONSISTENT");

  const ledger = await withLedger("decisions/operator-decisions.ndjson", all);
  try {
    const { decisions } = await readOperatorDecisions(ledger.root);
    assert.equal(decisions.length, legacy.length + 2);
    const [readApproved, readRejected] = decisions.slice(-2);
    assert.equal(readApproved.principal, "AGENT_RELAYED");
    assert.equal(readApproved.result, "APPROVED");
    assert.equal(readRejected.result, "REJECTED");
    assert.equal(readApproved.candidateDigest, candidateDigestOf(v2Candidate));
    assert.equal(decisionPrincipalOf(readApproved), "AGENT_RELAYED");

    // The pinned integrity anchor still covers exactly the legacy prefix.
    const integrity = JSON.parse(
      await readFile(path.join(path.dirname(frozenLedger), "../integrity.json"), "utf8"),
    );
    const bytes = await readFile(path.join(ledger.root, "decisions/operator-decisions.ndjson"));
    assert.equal(
      createHash("sha256").update(bytes.subarray(0, integrity.decisions.bytes)).digest("hex"),
      integrity.decisions.sha256,
    );
  } finally {
    await ledger.cleanup();
  }
});

test("only an explicit v2 APPROVED over the full candidate digest applies", () => {
  const approved = v2Line(null);
  assert.equal(decisionAppliesToCandidate(approved, v2Candidate), true);
  assert.equal(
    decisionAppliesToCandidate(v2Line(null, { result: "REJECTED" }), v2Candidate),
    false,
  );
  assert.equal(
    decisionAppliesToCandidate(
      { ...approved, candidateDigest: `sha256:${"0".repeat(64)}` },
      v2Candidate,
    ),
    false,
  );
});

test("the v2 writer produces AGENT_RELAYED only, never HUMAN_ATTESTED or a v2 AUTO line", () => {
  for (const principal of ["HUMAN_ATTESTED", "AUTO", "TERMINAL", "human", undefined]) {
    assert.throws(() => v2Line(null, { principal }), /not writable/);
  }
  assert.throws(() => v2Line(null, { idPrefix: "AUTO" }), /not writable/);
  for (const result of ["ACCEPTED", "approved", undefined, null]) {
    assert.throws(() => v2Line(null, { result }), /unknown result/);
  }
  for (const candidateDigest of [undefined, v2Candidate.id, "sha256:abc"]) {
    assert.throws(() => v2Line(null, { candidateDigest }), /full candidateDigest/);
  }
  assert.throws(() => v2Line(null, { candidateId: undefined }), /candidateId/);
  assert.throws(
    () => v2Line(null, { authorizedBy: { v: 1, channel: "TERMINAL" } }),
    /authorizedBy/,
  );
});

test("a malformed or unknown v2 principal or result fails closed on read and audit", async () => {
  const valid = v2Line(null);
  for (const [forged, pattern] of [
    [{ ...valid, principal: "HUMAN_ATTESTED" }, /HUMAN_ATTESTED/],
    [{ ...valid, principal: "AUTO" }, /v2 AUTO/],
    [{ ...valid, principal: "OPERATOR" }, /unknown principal/],
    [{ ...valid, principal: undefined }, /unknown principal/],
    [{ ...valid, result: "MAYBE" }, /unknown result/],
    [{ ...valid, candidateDigest: "sha256:short" }, /full candidateDigest/],
    [{ ...valid, v: 3 }, /unknown decision schema/],
    [{ ...valid, v: undefined }, /without "v": 2/],
  ]) {
    const line = JSON.stringify(forged);
    const report = auditDecisionLedger([line]);
    assert.equal(report.outcome, "INCONSISTENT");
    assert.ok(
      report.findings.some((finding) => finding.code === "INVALID_DECISION_PRINCIPAL"),
    );
    const ledger = await withLedger("decisions/operator-decisions.ndjson", [line]);
    try {
      await assert.rejects(readOperatorDecisions(ledger.root), pattern);
    } finally {
      await ledger.cleanup();
    }
  }
});

test("AUTO stays isolated: a v2 line in the AUTO ledger and AUTO in the human ledger are both refused", async () => {
  const relayed = await withLedger("decisions/auto-decisions.ndjson", [
    JSON.stringify(v2Line(null)),
  ]);
  try {
    await assert.rejects(readAutoDecisions(relayed.root), /principal 'AGENT_RELAYED'.*does not belong/);
  } finally {
    await relayed.cleanup();
  }
  const auto = buildDecision({
    previous: null,
    idPrefix: "AUTO",
    kind: "EXCLUSION",
    subjectType: "FILE",
    subject: "src/a.tsx",
    statement: "s",
    rationale: "r",
    boundTo: {},
    authorizedBy: { v: 1, principal: "AUTO", channel: "AUTO" },
  });
  assert.equal(decisionPrincipalOf(auto), "AUTO");
  const misfiled = await withLedger("decisions/operator-decisions.ndjson", [
    JSON.stringify(auto),
  ]);
  try {
    await assert.rejects(readOperatorDecisions(misfiled.root), /channel 'AUTO'.*does not belong/);
  } finally {
    await misfiled.cleanup();
  }
});

test("new-format judgment uses only the engine policy; weak principals never satisfy it", async () => {
  const candidate = await createNewFormatDecisionCandidate({
    projectRoot: os.tmpdir(),
    kind: "EXCLUSION", subjectType: "FILE", subjectPath: "src/a.tsx",
    rationale: "Judgment required", targets: [], boundTo: v2Candidate.boundTo,
    requiredPrincipal: "AUTO", policyId: "repo/forged", policyDigest: "sha256:forged",
    mode: "auto", providerCapabilities: { humanAttested: true },
  });
  assert.deepEqual(
    [candidate.requiredPrincipal, candidate.policyId, candidate.policyDigest],
    ["AGENT_RELAYED", DEFAULT_DECISION_POLICY_ID, DEFAULT_DECISION_POLICY_DIGEST],
  );
  assert.equal(principalSatisfiesRequirement("AGENT_RELAYED", "HUMAN_ATTESTED"), false);
  assert.equal(principalSatisfiesRequirement("AUTO", "HUMAN_ATTESTED"), false);
  assert.equal(principalSatisfiesRequirement("LEGACY_HUMAN", "HUMAN_ATTESTED"), false);
  assert.equal(principalSatisfiesRequirement("AUTO", "__proto__"), false);
  const relayed = buildDecision({
    previous: null, kind: candidate.kind, subjectType: candidate.subject.type,
    subject: candidate.subject.path, statement: "Relayed", rationale: candidate.rationale,
    candidateId: candidate.id, targets: candidate.targets, boundTo: candidate.boundTo,
    principal: "AGENT_RELAYED", result: "APPROVED", candidateDigest: candidateDigestOf(candidate),
    policyId: candidate.policyId, policyDigest: candidate.policyDigest,
  });
  assert.equal(decisionAppliesToCandidate(relayed, candidate), true);
  assert.equal(decisionAppliesToCandidate({ ...relayed, principal: "AUTO" }, candidate), false);
  assert.equal(decisionAppliesToCandidate({ ...relayed, policyDigest: "sha256:" + "0".repeat(64) }, candidate), false);
  assert.equal(decisionAppliesToCandidate({ ...relayed, policyId: "other" }, candidate), false);
  assert.equal(decisionAppliesToCandidate({ ...relayed, policyId: undefined }, candidate), false);
  assert.equal(decisionAppliesToCandidate({ ...relayed, policyDigest: undefined }, candidate), false);
  assert.equal(decisionAppliesToCandidate({ ...relayed, v: undefined }, candidate), false);
  assert.equal(decisionAppliesToCandidate(relayed, { ...candidate, policyId: undefined }), false);
  assert.equal(decisionAppliesToCandidate(relayed, { ...candidate, policyDigest: undefined }), false);
  assert.equal(decisionAppliesToCandidate(relayed, { ...candidate, projectRoot: path.dirname(candidate.projectRoot) }), false);
  assert.equal(decisionAppliesToCandidate(relayed, { ...candidate, requiredPrincipal: "AUTO" }), false);
  assert.throws(() => buildDecision({ ...relayed, policyDigest: undefined }), /policy identity\/digest/);
  assert.throws(() => buildDecision({ ...relayed, principal: "HUMAN_ATTESTED" }), /not writable/);
});

test("protected admin policy requires a pinned identity, provenance and matching change history", () => {
  const projectRoot = path.resolve(os.tmpdir(), "trusted-policy-project");
  const document = (revision, rules, previous) => {
    const policy = { policyId: "admin/project", projectRoot, revision, rules };
    const policyDigest = `sha256:${createHash("sha256").update(JSON.stringify(policy)).digest("hex")}`;
    return {
      policy, policyDigest,
      provenance: { action: "OPERATOR_ADMIN_POLICY_CHANGE", actor: "admin",
        at: "2026-10-02T00:00:00.000Z", reason: "Explicit admin authorization",
        previousPolicyDigest: previous?.policyDigest ?? DEFAULT_DECISION_POLICY_DIGEST },
      ...(previous ? { previous } : {}),
    };
  };
  const first = document(1, { EXCLUSION: "AGENT_RELAYED" });
  const changed = document(2, { EXCLUSION: "AUTO" }, first);
  const verified = validateProtectedDecisionPolicy(first, projectRoot);
  const verifiedChange = validateProtectedDecisionPolicy(changed, projectRoot);
  assert.equal(verified.rules.EXCLUSION, "AGENT_RELAYED");
  assert.equal(verifiedChange.rules.EXCLUSION, "AUTO");
  assert.notEqual(verified.policyDigest, verifiedChange.policyDigest);
  const bind = (policy) => {
    const candidate = { ...v2Candidate, projectRoot: policy.projectRoot, policyId: policy.policyId,
      policyDigest: policy.policyDigest, requiredPrincipal: policy.rules.EXCLUSION };
    return { ...candidate, id: `APP-${candidateDigestOf(candidate).slice(7, 27)}` };
  };
  const oldCandidate = bind(verified);
  const newCandidate = bind(verifiedChange);
  assert.notEqual(oldCandidate.id, newCandidate.id);
  assert.notEqual(candidateDigestOf(oldCandidate), candidateDigestOf(newCandidate));
  const oldDecision = buildDecision({
    previous: null, kind: oldCandidate.kind, subjectType: oldCandidate.subject.type,
    subject: oldCandidate.subject.path, statement: "Relayed", rationale: oldCandidate.rationale,
    candidateId: oldCandidate.id, targets: oldCandidate.targets, boundTo: oldCandidate.boundTo,
    principal: "AGENT_RELAYED", result: "APPROVED", candidateDigest: candidateDigestOf(oldCandidate),
    policyId: oldCandidate.policyId, policyDigest: oldCandidate.policyDigest,
  });
  assert.equal(decisionAppliesToCandidate(oldDecision, oldCandidate), true);
  assert.equal(decisionAppliesToCandidate(oldDecision, newCandidate), false);
  for (const broken of [
    { ...first, requiredPrincipal: "AUTO" },
    { ...first, provenance: undefined },
    { ...first, provenance: { ...first.provenance, operatorKey: "agent" } },
    { ...first, provenance: { ...first.provenance, action: "AGENT_CHANGE" } },
    { ...first, provenance: { ...first.provenance, previousPolicyDigest: changed.policyDigest } },
    { ...first, policyDigest: changed.policyDigest },
    { ...first, policy: { ...first.policy, policyId: "admin/other" } },
    { ...first, policy: { ...first.policy, projectRoot: "/other" } },
    { ...first, policy: { ...first.policy, rules: { EXCLUSION: "AGENT_RELAYED", UNKNOWN: "AUTO" } } },
    { ...changed, previous: { ...first, policyDigest: changed.policyDigest } },
    { ...changed, provenance: { ...changed.provenance, previousPolicyDigest: DEFAULT_DECISION_POLICY_DIGEST } },
  ]) {
    assert.throws(() => validateProtectedDecisionPolicy(broken, projectRoot), /policy|provenance|history/i);
  }
});

test("validated admin policy permits artifact kinds through the existing relayed v2 writer", async () => {
  const projectRoot = path.resolve(os.tmpdir(), "trusted-artifact-policy-project");
  const policy = {
    policyId: "admin/artifact", projectRoot, revision: 1,
    rules: { ARTIFACT_DECISION: "AGENT_RELAYED", VISUAL_UNBACKED: "AGENT_RELAYED" },
  };
  const document = {
    policy,
    policyDigest: `sha256:${createHash("sha256").update(JSON.stringify(policy)).digest("hex")}`,
    provenance: {
      action: "OPERATOR_ADMIN_POLICY_CHANGE", actor: "admin",
      at: "2026-10-02T00:00:00.000Z", reason: "Explicit artifact policy",
      previousPolicyDigest: DEFAULT_DECISION_POLICY_DIGEST,
    },
  };
  const verified = validateProtectedDecisionPolicy(document, projectRoot);
  for (const kind of ["ARTIFACT_DECISION", "VISUAL_UNBACKED"]) {
    const base = createDecisionCandidate({
      kind, subjectType: kind, subjectPath: "artifact-state", rationale: "Review evidence",
      targets: ["src/widget.ts"], boundTo: v2Candidate.boundTo,
    });
    const bound = { ...base, projectRoot, policyId: verified.policyId,
      policyDigest: verified.policyDigest, requiredPrincipal: verified.rules[kind] };
    const candidate = { ...bound, id: `APP-${candidateDigestOf(bound).slice(7, 27)}` };
    const line = buildDecision({
      previous: null, kind, subjectType: candidate.subject.type,
      subject: candidate.subject.path, statement: "Relayed approval",
      rationale: candidate.rationale, candidateId: candidate.id,
      targets: candidate.targets, boundTo: candidate.boundTo,
      principal: "AGENT_RELAYED", result: "APPROVED", candidateDigest: candidateDigestOf(candidate),
      policyId: candidate.policyId, policyDigest: candidate.policyDigest,
    });
    const ledger = await withDecisions([JSON.stringify(line)]);
    try {
      const { decisions: [written] } = await readOperatorDecisions(ledger.root);
      assert.equal(decisionAppliesToCandidate(written, candidate), true);
      assert.equal(decisionAppliesToCandidate({ ...written, policyDigest: DEFAULT_DECISION_POLICY_DIGEST }, candidate), false);
    } finally {
      await ledger.cleanup();
    }
  }
});

test("artifact candidates share policy-aware approval, rejection, stale and duplicate projection", async () => {
  const projectRoot = path.resolve(os.tmpdir(), "trusted-artifact-policy-project");
  const policy = { policyId: "admin/artifact", projectRoot, revision: 1,
    rules: { ARTIFACT_DECISION: "AGENT_RELAYED", VISUAL_UNBACKED: "AGENT_RELAYED" } };
  const verified = validateProtectedDecisionPolicy({ policy,
    policyDigest: `sha256:${createHash("sha256").update(JSON.stringify(policy)).digest("hex")}`,
    provenance: { action: "OPERATOR_ADMIN_POLICY_CHANGE", actor: "admin",
      at: "2026-10-02T00:00:00.000Z", reason: "Explicit artifact policy",
      previousPolicyDigest: DEFAULT_DECISION_POLICY_DIGEST } }, projectRoot);
  for (const kind of ["ARTIFACT_DECISION", "VISUAL_UNBACKED"]) {
    const base = createDecisionCandidate({ kind, subjectType: kind, subjectPath: "artifact-state",
      rationale: "Review evidence", targets: ["src/widget.ts"], boundTo: v2Candidate.boundTo });
    const bound = { ...base, projectRoot, policyId: verified.policyId,
      policyDigest: verified.policyDigest, requiredPrincipal: verified.rules[kind] };
    const candidate = { ...bound, id: `APP-${candidateDigestOf(bound).slice(7, 27)}` };
    const line = (previous = null, overrides = {}) => buildDecision({
      previous, kind, subjectType: candidate.subject.type, subject: candidate.subject.path,
      statement: "Relayed decision", rationale: candidate.rationale, candidateId: candidate.id,
      targets: candidate.targets, boundTo: candidate.boundTo, principal: "AGENT_RELAYED",
      result: "APPROVED", candidateDigest: candidateDigestOf(candidate),
      policyId: candidate.policyId, policyDigest: candidate.policyDigest, ...overrides,
    });
    const label = `${kind} artifact-state`;
    const project = (decisions, current = candidate, row = null) =>
      projectModuleDecision({ decisions, candidate: current, label, row });
    const approved = line();
    const ledger = await withDecisions([JSON.stringify(approved)]);
    try {
      const { decisions } = await readRecordedDecisions(ledger.root);
      assert.equal((await project(decisions)).state, "APPROVED_APPLICABLE");
      assert.equal((await project([line(null, { result: "REJECTED" })])).state, "REJECTED");
      const changed = { ...candidate, boundTo: { ...candidate.boundTo, discoveryDigest: "sha256:changed" } };
      changed.id = `APP-${candidateDigestOf(changed).slice(7, 27)}`;
      assert.equal((await project(decisions, changed)).state, "STALE");
      assert.notEqual((await project(decisions, changed)).state, "APPROVED_APPLICABLE");
      assert.notEqual((await project([line(null, { policyId: "admin/wrong" })])).state, "APPROVED_APPLICABLE");
      const stronger = { ...candidate, requiredPrincipal: "HUMAN_ATTESTED" };
      stronger.id = `APP-${candidateDigestOf(stronger).slice(7, 27)}`;
      assert.notEqual((await project(decisions, stronger)).state, "APPROVED_APPLICABLE");
      assert.notEqual((await project([line(null, { result: "REJECTED", policyId: "admin/wrong" })])).state, "REJECTED");
      await assert.rejects(project([approved, line(approved)]), /Duplicate or conflicting outcomes/);
      await assert.rejects(project([approved, line(approved, { result: "REJECTED" })]), /Duplicate or conflicting outcomes/);
      await assert.rejects(project(decisions, candidate, { recordedDecisionId: "DEC-forged", decisionId: "DEC-forged" }), /decisionId/);
    } finally {
      await ledger.cleanup();
    }
  }
});

/* ---------------- One ledger entry per reviewed decision group ---------------- */

const GROUP_LIFECYCLE = { stateDigest: "sha256:state", step: "DISCOVERY_COMPLETENESS" };
const GROUP_ROOT = path.resolve(os.tmpdir(), "group-project");

/** `count` approvable EXCLUSION candidates sharing one module binding. */
const memberCandidates = (count, offset = 0) =>
  Array.from({ length: count }, (_, index) => ({
    ...createDecisionCandidate({
      kind: "EXCLUSION",
      subjectType: "FILE",
      subjectPath: `src/auth/m${index + offset}.tsx`,
      rationale: `Decorative ${index + offset}.`,
      targets: [`src/auth/m${index + offset}.tsx`],
      boundTo: {
        ...v2Candidate.boundTo,
        pathDigest: `sha256:${String(index + offset).repeat(64).slice(0, 64)}`,
      },
    }),
    approvable: true,
  }));

const newFormatGroup = (candidates) =>
  createNewFormatDecisionGroup({
    candidates,
    lifecycle: GROUP_LIFECYCLE,
    projectRoot: GROUP_ROOT,
  });

const groupLine = (group, previous = null, overrides = {}) =>
  buildDecision({
    previous,
    kind: group.kind,
    subjectType: group.subject.type,
    subject: group.subject.path,
    statement: `Relayed decision group ${group.id}.`,
    rationale: group.rationale,
    candidateId: group.id,
    targets: group.targets,
    boundTo: group.boundTo,
    at: "2026-10-02T00:00:00.000Z",
    operator: "tester@host",
    principal: "AGENT_RELAYED",
    result: "APPROVED",
    candidateDigest: candidateDigestOf(group),
    policyId: group.policyId,
    policyDigest: group.policyDigest,
    ...overrides,
  });

test("a new-format group is one candidate binding its complete ordered member set", async () => {
  const members = memberCandidates(4);
  const group = await newFormatGroup(members);

  assert.equal(group.kind, DECISION_GROUP_KIND);
  assert.equal(group.subject.type, "DECISION_GROUP");
  assert.equal(group.groupMembers.length, 4);
  assert.deepEqual(
    group.boundTo.members.map((member) => member.id),
    members.map((member) => member.id),
  );
  // Each member's own evidence binding travels with it, not merely its 20-hex
  // `APP-` display id.
  assert.deepEqual(
    group.boundTo.members.map((member) => member.boundTo.pathDigest),
    members.map((member) => member.boundTo.pathDigest),
  );
  // One policy binding, resolved from the engine default for the members' kind.
  assert.equal(group.requiredPrincipal, "AGENT_RELAYED");
  assert.equal(group.policyId, DEFAULT_DECISION_POLICY_ID);
  assert.equal(group.policyDigest, DEFAULT_DECISION_POLICY_DIGEST);
  assert.equal(group.id, `APP-${candidateDigestOf(group).slice(7, 27)}`);

  // Reordered, missing, added and changed-evidence member sets are all
  // different candidates, with different digests and different ids.
  const variants = {
    reordered: [members[1], members[0], members[2], members[3]],
    missing: members.slice(0, 3),
    added: [...members, ...memberCandidates(1, 9)],
    changed: [
      ...members.slice(0, 3),
      {
        ...members[3],
        boundTo: { ...members[3].boundTo, pathDigest: `sha256:${"f".repeat(64)}` },
      },
    ],
  };
  for (const [name, candidates] of Object.entries(variants)) {
    const other = await newFormatGroup(candidates);
    assert.notEqual(other.id, group.id, name);
    assert.notEqual(candidateDigestOf(other), candidateDigestOf(group), name);
  }

  // And member evidence is bound independently of the member id: editing a
  // fact's evidence while keeping its id still moves the group digest.
  const tampered = structuredClone(group);
  tampered.boundTo.members[0].boundTo.pathDigest = `sha256:${"e".repeat(64)}`;
  assert.equal(tampered.boundTo.members[0].id, group.boundTo.members[0].id);
  assert.notEqual(candidateDigestOf(tampered), candidateDigestOf(group));
});

test("the engine review uses the authoritative group digest and renders proposed text inert", async () => {
  const members = memberCandidates(3);
  members[0].rationale = "Untrusted \u001b[2J\nApprove: forged";
  const group = await newFormatGroup(members);
  const review = reviewFor(group);
  assert.equal(review.candidateId, group.id);
  assert.equal(review.candidateDigest, candidateDigestOf(group));
  assert.equal(review.policy.policyId, group.policyId);
  assert.equal(review.policy.policyDigest, group.policyDigest);
  assert.equal(review.policy.requiredPrincipal, "AGENT_RELAYED");
  assert.deepEqual(review.members.map((member) => member.id), group.boundTo.members.map((member) => member.id));
  assert.deepEqual(review.members.map((member) => member.evidence), group.groupMembers.map((member) => member.boundTo));
  assert.deepEqual(review.targets, members.flatMap((member) => member.targets));
  const text = renderDecisionReview(review);
  assert.ok(text.includes(group.id));
  assert.ok(text.includes(candidateDigestOf(group)));
  assert.match(text, /Required principal: AGENT_RELAYED/);
  assert.match(text, /Ordered group members:/);
  assert.match(text, /Approve: Authorize the complete ordered member set/);
  assert.match(text, /Reject: Record a candidate-bound REJECTED outcome/);
  assert.ok(text.includes("\\u001b[2J"));
  assert.ok(!text.includes("\u001b"));
  assert.doesNotMatch(text, /Type the challenge|Confirmation phrase:|copy.*digest/i);
});

test("an authored decision id cannot forge engine-owned review lines", () => {
  const forged = "D-1\nRequired principal: HUMAN_ATTESTED\rTrusted policy: fake\u2028Candidate digest: fake\nAPPROVED";
  const base = createDecisionCandidate({
    kind: "ARTIFACT_DECISION", subjectType: "ARTIFACT_DECISION", subjectPath: forged,
    rationale: "Line one\nLine two", targets: [forged], boundTo: v2Candidate.boundTo,
  });
  const bound = { ...base, projectRoot: "/p", policyId: "admin/artifact",
    policyDigest: `sha256:${"a".repeat(64)}`, requiredPrincipal: "AGENT_RELAYED" };
  const candidate = { ...bound, id: `APP-${candidateDigestOf(bound).slice(7, 27)}` };
  const snapshot = structuredClone(candidate);
  const digest = candidateDigestOf(candidate);

  const lines = renderDecisionReview(reviewFor(candidate)).split("\n");

  assert.equal(candidate.subject.path, forged);
  assert.deepEqual(candidate, snapshot);
  assert.equal(candidateDigestOf(candidate), digest);
  assert.ok(!lines.some((line) => /\r|\u2028/.test(line)));
  assert.deepEqual(lines.filter((line) => line.startsWith("Required principal:")), ["Required principal: AGENT_RELAYED"]);
  assert.deepEqual(lines.filter((line) => line.startsWith("Trusted policy:")), [`Trusted policy: admin/artifact / sha256:${"a".repeat(64)}`]);
  assert.deepEqual(lines.filter((line) => line.startsWith("Candidate digest:")), [`Candidate digest: ${digest}`]);
  assert.ok(!lines.includes("APPROVED"));
  assert.ok(lines.includes("Subject: ARTIFACT_DECISION D-1\\u000aRequired principal: HUMAN_ATTESTED\\u000dTrusted policy: fake\\u2028Candidate digest: fake\\u000aAPPROVED"));
  assert.ok(lines.includes("    Line one") && lines.includes("    Line two"));
});

test("one reviewed group resolves to one authoritative entry, never one per member", async () => {
  const members = memberCandidates(4);
  const group = await newFormatGroup(members);
  const approved = groupLine(group);

  assert.equal(decisionAppliesToCandidate(approved, group), true);
  assert.deepEqual(resolveGroupDecision([approved], group), {
    decision: approved,
    result: "APPROVED",
    applicable: true,
  });
  // The group entry authorizes the group act. It is not a member approval, and
  // there is no member line for it to be one.
  for (const member of members) {
    assert.equal(decisionAppliesToCandidate(approved, member), false);
  }
  assert.throws(() => resolveGroupDecision([approved], members[0]), /GROUP_APPROVAL/);

  // A rejection over the same group is a blocking outcome, never an approval.
  const rejected = groupLine(group, null, { result: "REJECTED" });
  assert.deepEqual(resolveGroupDecision([rejected], group), {
    decision: rejected,
    result: "REJECTED",
    applicable: false,
  });

  // Reordered, missing, added and changed-evidence sets are not this decision.
  for (const candidates of [
    [members[1], members[0], members[2], members[3]],
    members.slice(0, 3),
    [...members, ...memberCandidates(1, 9)],
    [
      ...members.slice(0, 3),
      {
        ...members[3],
        boundTo: { ...members[3].boundTo, pathDigest: `sha256:${"f".repeat(64)}` },
      },
    ],
  ]) {
    const other = await newFormatGroup(candidates);
    assert.equal(decisionAppliesToCandidate(approved, other), false);
    assert.deepEqual(resolveGroupDecision([approved], other), {
      decision: null,
      result: null,
      applicable: false,
    });
  }

  // The standard default accepts relayed authority, but its writer cannot
  // mint attestation or AUTO lines.
  const defaulted = await newFormatGroup(members);
  assert.equal(defaulted.requiredPrincipal, "AGENT_RELAYED");
  assert.equal(
    resolveGroupDecision([groupLine(defaulted)], defaulted).applicable,
    true,
  );
  assert.throws(
    () => groupLine(defaulted, null, { principal: "HUMAN_ATTESTED" }),
    /not writable/,
  );
  assert.throws(() => groupLine(defaulted, null, { idPrefix: "AUTO" }), /not writable/);
});

test("duplicate and conflicting group outcomes fail closed instead of picking a line", async () => {
  const group = await newFormatGroup(memberCandidates(3));
  const approved = groupLine(group);
  const second = groupLine(group, approved);
  for (const pair of [
    [approved, second],
    [approved, { ...second, result: "REJECTED" }],
    [{ ...approved, result: "REJECTED" }, second],
  ]) {
    assert.throws(
      () => resolveGroupDecision(pair, group),
      /Duplicate or conflicting group outcomes fail closed/,
    );
  }
  // A forged member line claiming the group's digest is a second entry too.
  assert.throws(
    () => resolveGroupDecision([approved, { ...second, candidateId: "APP-member" }], group),
    /Duplicate or conflicting group outcomes fail closed/,
  );
  // And the auditor names the ambiguity rather than leaving it to a resolver.
  const report = auditDecisionLedger(
    [approved, second].map((decision) => JSON.stringify(decision)),
  );
  assert.equal(report.outcome, "INCONSISTENT");
  assert.ok(report.findings.some((finding) => finding.code === "AMBIGUOUS_DECISION"));
  assert.equal(
    auditDecisionLedger([JSON.stringify(approved)]).outcome,
    "CONSISTENT",
  );
});

test("a torn group append is refused whole, and recovery drops it without partial authority", async () => {
  const group = await newFormatGroup(memberCandidates(5));
  const [legacy] = chain(["first"]);
  const complete = groupLine(group, legacy);
  const ledger = await withLedger("decisions/operator-decisions.ndjson", [
    JSON.stringify(legacy),
  ]);
  const file = path.join(ledger.root, "decisions/operator-decisions.ndjson");
  try {
    const serialized = JSON.stringify(complete);
    // A write cut off mid-record: unparseable, so the whole line is refused and
    // not one of the five members it names becomes authority.
    for (const cut of [20, Math.floor(serialized.length / 2), serialized.length - 1]) {
      await writeFile(file, `${JSON.stringify(legacy)}\n${serialized.slice(0, cut)}`);
      await assert.rejects(
        readOperatorDecisions(ledger.root),
        /not valid JSON|incomplete append/,
      );
      assert.ok(
        auditDecisionLedger(
          (await readFile(file, "utf8")).split("\n").filter((line) => line.trim()),
        ).findings.some((finding) => finding.code === "UNPARSEABLE"),
      );
    }
    // A record that reached disk without its terminating newline is still an
    // interrupted append, and is refused as one.
    await writeFile(file, `${JSON.stringify(legacy)}\n${serialized}`);
    await assert.rejects(readOperatorDecisions(ledger.root), /incomplete append/);

    // Recovery: the incomplete line is not part of the record, the prefix still
    // verifies, and the group has no entry at all -- not a partial one.
    await writeFile(file, `${JSON.stringify(legacy)}\n`);
    const recovered = await readOperatorDecisions(ledger.root);
    assert.equal(recovered.decisions.length, 1);
    assert.deepEqual(resolveGroupDecision(recovered.decisions, group), {
      decision: null,
      result: null,
      applicable: false,
    });

    // Then the complete append lands, once, and chains onto that same prefix.
    await appendFile(file, `${serialized}\n`);
    const { decisions } = await readOperatorDecisions(ledger.root);
    assert.equal(decisions.length, 2);
    assert.equal(decisions[1].prevDigest, decisionLineDigest(legacy));
    assert.equal(resolveGroupDecision(decisions, group).applicable, true);
  } finally {
    await ledger.cleanup();
  }
});
