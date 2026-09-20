/**
 * The decision recorder's whole job is being un-usable by an agent.
 *
 * The tests that matter here are the refusals: no TTY, wrong challenge, broken
 * chain. Everything else is bookkeeping.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  runRecordDecisionCli,
} from "../../src/record-decision.mjs";
import {
  createDecisionCandidate,
  decisionAppliesToCandidate,
  decisionLineDigest,
  readOperatorDecisions,
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
