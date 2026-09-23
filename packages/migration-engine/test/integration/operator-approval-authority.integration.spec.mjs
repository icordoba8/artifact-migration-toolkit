/**
 * The operator-decision subsystem as one thing: can a human always be reached,
 * and can nothing but a human's approval move a migration forward.
 *
 * `inline-approval.integration.spec.mjs` owns the inline half -- worktree
 * context, a real accept, a real decline, a mismatch, worktree isolation. This
 * file owns the two halves that were missing: what happens when the inline
 * channel produces no approval at all, and what an approval has to be bound to
 * before validation will consume it.
 *
 * Real engine, real fixtures, real ledger. Only the host's human is simulated.
 */

import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  approvalShapedArgument,
  createSession,
  handleMessage,
} from "../../src/mcp-server.mjs";
import {
  advanceMigration,
  createDecisionCandidate,
  decisionLineDigest,
  previewAdvance,
  legacySourceBinding,
  pendingDecisionCandidates,
  validateResumableMigration,
} from "../../src/core.mjs";
import {
  challengeFor,
  parseDecisionArguments,
  runRecordDecisionCli,
} from "../../src/record-decision.mjs";
import {
  addLegacyFiles,
  atDiscoveryCompleteness,
  behaviorBacked,
  createFixture,
  decisionLedger,
  EXCLUDED_CLASSIFICATION,
  extraFileNames,
  manyExcluded,
  resolutionFor,
  snapshot,
  state,
} from "./approval.fixture.mjs";

const DECISIONS = "decisions/operator-decisions.ndjson";
const CLASSIFICATION = "inventories/module-classification.json";

const classificationPath = (fixture) =>
  path.join(fixture.migrationRoot, CLASSIFICATION);

const readClassification = async (fixture) =>
  JSON.parse(await readFile(classificationPath(fixture), "utf8"));

const writeClassification = (fixture, classification) =>
  writeFile(classificationPath(fixture), JSON.stringify(classification));

const contextFor = async (fixture) => ({
  ...(await resolutionFor(fixture)),
  moduleName: "auth",
});

const pendingFor = async (fixture) =>
  pendingDecisionCandidates(await contextFor(fixture));

/**
 * The trusted terminal path, reached exactly as an operator reaches it: the
 * recorder's own CLI entry, with the TTY gate stood in for by nothing at all --
 * `ask` is the in-process channel the MCP adapter uses, and it is the only way
 * a test can be the human. No CLI approval argument exists to pass.
 */
const approveAtTerminal = async (fixture, candidateId) => {
  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;
  process.chdir(fixture.root);
  try {
    return await runRecordDecisionCli(["auth", "--approve", candidateId], {
      stdout: { write: () => true },
      ask: ({ challenge }) => challenge,
    });
  } finally {
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
  }
};

/** Drives `migration_run` over the adapter with a scripted host. */
const runThroughHost = async (fixture, onElicit) => {
  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;
  const session = createSession(
    onElicit ? { request: (method, params) => onElicit(method, params) } : {},
  );
  try {
    await handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { capabilities: onElicit ? { elicitation: {} } : {} },
      },
      session,
    );
    const response = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "migration_run",
          arguments: { module: "auth", cwd: fixture.root },
        },
      },
      session,
    );
    assert.ok(!response.error, JSON.stringify(response.error));
    return response.result.structuredContent;
  } finally {
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
  }
};

/**
 * Appends a line straight to the ledger with a valid hash chain: the shape a
 * fabricated approval has. `candidateId` is whatever the caller wants to claim.
 */
const forgeLedgerLine = async (fixture, overrides = {}) => {
  const file = path.join(fixture.migrationRoot, DECISIONS);
  const existing = await readFile(file, "utf8").catch(() => "");
  const previous = existing
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .at(-1);
  const classification = await readClassification(fixture);
  const row = classification.files[0];
  const line = {
    id: `DEC-${String((previous?.seq ?? 0) + 1).padStart(3, "0")}`,
    seq: (previous?.seq ?? 0) + 1,
    prevDigest: previous ? decisionLineDigest(previous) : "genesis",
    at: new Date().toISOString(),
    operator: "forger@fixture",
    kind: "EXCLUSION",
    subject: { type: "FILE", path: row.path },
    statement: "Approved by nobody.",
    rationaleDigest: createDecisionCandidate({
      kind: "EXCLUSION",
      subjectType: "FILE",
      subjectPath: row.path,
      rationale: row.rationale,
      boundTo: {},
    }).rationaleDigest,
    ...overrides,
    boundTo: {
      module: "auth",
      ...(await legacySourceBinding(fixture.legacyRoot)),
      discoveryDigest: (await pendingFor(fixture)).discoveryDigest,
      algorithmVersion: 2,
      ...(overrides.boundTo ?? {}),
    },
  };
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(line)}\n`);
  return { decision: line, digest: decisionLineDigest(line) };
};

const cite = async (fixture, { decisionId, decisionDigest }) => {
  const classification = await readClassification(fixture);
  Object.assign(classification.files[0], { decisionId, decisionDigest });
  await writeClassification(fixture, classification);
  return classification;
};

/* -- Availability ---------------------------------------------------------- */

/**
 * Cases 3 and 4. A host that declares elicitation and answers `decline` without
 * ever showing a person is indistinguishable from one whose human refused, so
 * the run must fail closed *and* hand back a way forward. Then the operator
 * uses that exact way forward and an ordinary resume picks the decision up with
 * no identifier passing through anyone's hands.
 */
test("a host that cannot deliver a human answer still leaves a trusted worktree-scoped path, and a resume consumes it", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const before = await state(fixture);

    // Case 3, auto-decline: the host answers, nobody was asked.
    const declined = await runThroughHost(fixture, () => ({
      action: "decline",
    }));
    assert.equal(declined.outcome, "OPERATOR_DECISION");
    assert.equal(await decisionLedger(fixture), null);
    assert.ok(declined.operatorApproval, "a fallback path is offered");
    assert.equal(declined.operatorApproval.cwd, fixture.root);
    const [offered] = declined.operatorApproval.candidates;
    assert.match(offered.command, /record-decision\.mjs auth --approve APP-/);
    assert.ok(
      !offered.command.includes("DEC-"),
      "the operator is never asked to carry a decision id",
    );


    // Case 4. The operator runs exactly that command in exactly that directory.
    const { decision } = await approveAtTerminal(fixture, offered.id);
    assert.equal(decision.candidateId, offered.id);

    // An ordinary resume. No approval is asked for -- there is nothing pending
    // -- and the receipt comes back on its own.
    const resumed = await runThroughHost(fixture, () =>
      assert.fail("an already-approved candidate must not be re-challenged"),
    );
    assert.equal(resumed.outcome, "CONTINUE", resumed.reason);
    const [reference] = resumed.decisionReferences;
    assert.equal(reference.decisionId, decision.id);
    assert.equal(reference.decisionDigest, decisionLineDigest(decision));
    assert.equal(reference.candidateId, offered.id);

    // And the receipt is the whole citation: nothing else has to be learned.
    await cite(fixture, reference);
    await validateResumableMigration(await contextFor(fixture));
  } finally {
    await fixture.cleanup();
  }
});

/**
 * A host that *declines* refused a reachable human, so the run above still
 * stops and hands back the terminal path. A host that declares no human channel
 * at all is "no human here", not "nobody": the AUTO principal answers by mode,
 * never by reading the transport's stdio. Either way the human operator ledger
 * stays empty -- an agent may never mint a human approval.
 */
test("a host with no human channel is answered by AUTO and writes no human ledger line", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const silent = await runThroughHost(fixture, null);
    assert.notEqual(silent.outcome, "OPERATOR_DECISION");
    assert.equal(
      await decisionLedger(fixture),
      null,
      "a host with no human channel minted a human approval",
    );
  } finally {
    await fixture.cleanup();
  }
});

/* -- Batch consent --------------------------------------------------------- */

const BATCH_SIZE = 14;

/** A census with `BATCH_SIZE` approvable exclusions, at DISCOVERY_COMPLETENESS. */
const atManyPending = async (fixture) => {
  const names = extraFileNames(BATCH_SIZE - 1);
  await addLegacyFiles(fixture, names);
  await atDiscoveryCompleteness(
    fixture,
    manyExcluded(names),
    behaviorBacked(names),
  );
  const { candidates } = await pendingFor(fixture);
  assert.equal(candidates.length, BATCH_SIZE);
  assert.ok(candidates.every((candidate) => candidate.approvable));
  return candidates;
};

/**
 * A synthetic grouped-approval regression with thirteen candidates.
 *
 * One automatic run recorded thirteen approvals and
 * wrote "by operator through a host-originated approval request" thirteen
 * times. Nobody was asked anything: the host answered the adapter's own
 * `elicitation/create` with `{"action":"accept","content":{"decision":"Approve"}}`
 * -- a frame derivable from the schema alone -- and the adapter translated it
 * into the recorder's challenge phrase.
 *
 * Here the same host answers fourteen pending decisions across fourteen
 * iterations of the auto loop, which is strictly more opportunity than the
 * unsafe grouped-answer shape had. The ledger file must never come into existence.
 */
test("fourteen pending decisions and no human interaction write nothing at all", async () => {
  const fixture = await createFixture();
  try {
    const candidates = await atManyPending(fixture);
    const before = await state(fixture);
    let asks = 0;

    for (let iteration = 0; iteration < BATCH_SIZE; iteration++) {
      const result = await runThroughHost(fixture, (method, params) => {
        asks++;
        assert.equal(method, "elicitation/create");
        // Exactly the unsafe frame, and every other answer a host can
        // produce without rendering anything to anyone.
        return [
          { action: "accept", content: { decision: "Approve" } },
          { action: "accept", content: {} },
          { action: "accept" },
          { action: "accept", content: { confirmation: "" } },
          { action: "decline" },
          { action: "cancel" },
          null,
        ][asks % 7];
      });
      assert.equal(result.outcome, "OPERATOR_DECISION", result.reason);
      assert.deepEqual(result.decisionReferences, []);
      assert.equal(
        await decisionLedger(fixture),
        null,
        `iteration ${iteration} wrote a ledger`,
      );
      // The trusted terminal path is offered every time, and the whole
      // remainder is still pending -- nothing was consumed.
      assert.equal(result.operatorApproval.cwd, fixture.root);
      assert.equal(result.operatorApproval.candidates.length, BATCH_SIZE);
    }

    // One request per iteration: no iteration walked the list.
    assert.equal(asks, BATCH_SIZE);
    assert.equal(await decisionLedger(fixture), null);
    assert.deepEqual(await state(fixture), before);
    assert.deepEqual(
      (await pendingFor(fixture)).candidates.map((candidate) => candidate.id),
      candidates.map((candidate) => candidate.id),
    );
  } finally {
    await fixture.cleanup();
  }
});

/**
 * The other half: consent still works, and it works exactly once per act.
 *
 * The simulated human transcribes the phrase off the request it was shown,
 * which is what a person at a host dialog does. (It is also the documented
 * ceiling: a host that scrapes its own dialog text can do the same for one
 * request. What it can no longer do is answer from the schema.)
 */
test("one explicit group approval appends every member atomically", async () => {
  const fixture = await createFixture();
  try {
    const candidates = await atManyPending(fixture);
    const transcribe = (params) => ({
      action: "accept",
      content: {
        confirmation: /^Confirmation phrase: (.+)$/m.exec(params.message)[1],
      },
    });
    const ledgerLines = async () =>
      ((await decisionLedger(fixture)) ?? "").trim().split("\n").filter(Boolean);

    // Moving any member while the request is open invalidates the whole group.
    const original = await readClassification(fixture);
    const stale = await runThroughHost(fixture, async (method, params) => {
      const changed = structuredClone(original);
      changed.files.at(-1).rationale += " changed";
      await writeClassification(fixture, changed);
      return transcribe(params);
    });
    assert.equal(stale.outcome, "FAILED");
    assert.equal(await decisionLedger(fixture), null);
    await writeClassification(fixture, original);

    // One human act over the stable group.
    let asks = 0;
    const first = await runThroughHost(fixture, (method, params) => {
      asks++;
      return transcribe(params);
    });
    assert.equal(asks, 1, "one iteration asks one human once");
    assert.equal(first.outcome, "CONTINUE", first.reason);

    const lines = await ledgerLines();
    assert.equal(lines.length, BATCH_SIZE);
    const recorded = lines.map(JSON.parse);
    assert.deepEqual(
      recorded.map((decision) => decision.candidateId),
      candidates.map((candidate) => candidate.id),
    );
    assert.ok(recorded.every((decision) => decision.authorizedBy.members === BATCH_SIZE));
    assert.deepEqual(
      recorded.map((decision) => decision.authorizedBy.index),
      Array.from({ length: BATCH_SIZE }, (_, index) => index + 1),
    );
    assert.equal(new Set(recorded.map((decision) => decision.authorizedBy.groupId)).size, 1);
    assert.equal(first.decisionReferences.length, BATCH_SIZE);
    assert.equal(
      (await pendingFor(fixture)).candidates.length,
      0,
      "every group member stopped pending together",
    );
  } finally {
    await fixture.cleanup();
  }
});

/* -- Authority ------------------------------------------------------------- */

/**
 * Cases 5, 6, 7, 9. Every one of these lines chains correctly, digests
 * correctly, and names the right file: forging the ledger is not the hard part.
 * What none of them can do is be the candidate the current scan derives.
 */
test("no fabricated, unbound, stale or mismatched ledger line authorizes a checkpoint", async () => {
  for (const [label, overrides, pattern] of [
    // Case 5: a plausible hand-written line that claims no candidate at all.
    ["a hand-written line", {}, /does not approve current stable candidate/],
    // Case 6: the same line with the scanner version an agent authors flipped
    // to 1, which is exactly what used to switch candidate binding off.
    [
      "a hand-written line under scanner version 1",
      { boundTo: { algorithmVersion: 1 } },
      /module or scanner-version binding does not match/,
    ],
    // Case 9: a candidate id that is plausible but is not this candidate.
    [
      "an invented candidate id",
      { candidateId: `APP-${"0".repeat(20)}` },
      /does not approve current stable candidate/,
    ],
    // Case 7/9: recorded against a census that has since moved on.
    [
      "a stale census binding",
      { boundTo: { discoveryDigest: "sha256:yesterday" } },
      /facts the operator approved changed/,
    ],
    // Case 9: cross-target replay -- a real approval from another migration.
    [
      "an approval bound to another target",
      { boundTo: { module: "billing" } },
      /module or scanner-version binding does not match/,
    ],
    // Case 9: the rationale the operator was shown, rewritten afterwards.
    [
      "a rewritten rationale",
      { rationaleDigest: `sha256:${"1".repeat(64)}` },
      /rationale changed after decision/,
    ],
  ]) {
    const fixture = await createFixture();
    try {
      await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
      const forged = await forgeLedgerLine(fixture, overrides);
      await cite(fixture, {
        decisionId: forged.decision.id,
        decisionDigest: forged.digest,
      });
      const before = await state(fixture);
      await assert.rejects(
        validateResumableMigration(await contextFor(fixture)),
        pattern,
        label,
      );
      // Fail closed: no transition, no history, and the ledger is left exactly
      // as it was -- refusing an approval never rewrites one.
      assert.deepEqual(await state(fixture), before);
      assert.equal(
        (await decisionLedger(fixture)).trim().split("\n").length,
        1,
        label,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

/**
 * Case 8, the replay half. A genuine approval, recorded by a real operator
 * against a real candidate, carried into a second record of the same module.
 *
 * The second checkout's legacy tree differs by one byte, which is the whole
 * point: the binding is content-addressed, so two records showing *identical*
 * bytes at an identical revision are not two subjects and an approval covering
 * one legitimately covers the other. A replay is only a replay when the thing
 * approved is not the thing being validated -- and then the bytes say so.
 */
test("a genuine approval does not replay into another record of the same module", async () => {
  const source = await createFixture();
  const other = await createFixture();
  try {
    await atDiscoveryCompleteness(source, EXCLUDED_CLASSIFICATION);
    await atDiscoveryCompleteness(other, EXCLUDED_CLASSIFICATION);
    await writeFile(
      path.join(other.legacyRoot, "auth/marker.txt"),
      "auth\nand one more line the operator never saw\n",
    );
    const [candidate] = (await pendingFor(source)).candidates;
    const { decision } = await approveAtTerminal(source, candidate.id);
    assert.notEqual(
      (await pendingFor(other)).candidates[0].id,
      candidate.id,
      "the other record derives its own candidate",
    );

    // The line, verbatim, appended to the other record's ledger.
    const replayed = path.join(other.migrationRoot, DECISIONS);
    await mkdir(path.dirname(replayed), { recursive: true });
    await appendFile(replayed, `${JSON.stringify(decision)}\n`);
    await cite(other, {
      decisionId: decision.id,
      decisionDigest: decisionLineDigest(decision),
    });
    const before = await state(other);
    await assert.rejects(
      validateResumableMigration(await contextFor(other)),
      /binds to the exact bytes it approved|does not approve current stable candidate/,
    );
    assert.deepEqual(await state(other), before);

    // The record it was actually recorded in still accepts it.
    await cite(source, {
      decisionId: decision.id,
      decisionDigest: decisionLineDigest(decision),
    });
    await validateResumableMigration(await contextFor(source));
  } finally {
    await source.cleanup();
    await other.cleanup();
  }
});

/**
 * Case 8, the stale half plus the append-only guarantee. An approval that was
 * genuine stops being authority the moment the thing it approved changes, and
 * being refused writes nothing -- the operator can re-approve the new candidate
 * without first deleting anything.
 */
test("a superseded approval stops authorizing and the ledger only ever grows", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const [first] = (await pendingFor(fixture)).candidates;
    const original = await approveAtTerminal(fixture, first.id);
    await cite(fixture, {
      decisionId: original.decision.id,
      decisionDigest: decisionLineDigest(original.decision),
    });
    await validateResumableMigration(await contextFor(fixture));

    // The rationale the operator approved is rewritten under the approval.
    const classification = await readClassification(fixture);
    classification.files[0].rationale = "A different reason entirely.";
    await writeClassification(fixture, classification);
    const ledgerBefore = await decisionLedger(fixture);
    await assert.rejects(
      validateResumableMigration(await contextFor(fixture)),
      /rationale changed after decision/,
    );
    assert.equal(await decisionLedger(fixture), ledgerBefore);

    // The new candidate is offered without the stale citation being removed.
    const [second] = (await pendingFor(fixture)).candidates;
    assert.notEqual(second.id, first.id);
    assert.equal(second.approvable, true);
    const replacement = await approveAtTerminal(fixture, second.id);
    assert.equal(
      (await decisionLedger(fixture)).trim().split("\n").length,
      2,
      "append-only: the superseded line is still there",
    );
    await cite(fixture, {
      decisionId: replacement.decision.id,
      decisionDigest: decisionLineDigest(replacement.decision),
    });
    await validateResumableMigration(await contextFor(fixture));
  } finally {
    await fixture.cleanup();
  }
});

/**
 * The recorder half of the same guarantee: an id that is no longer the current
 * candidate cannot be approved at all, so a stale id never becomes a line.
 */
test("the recorder refuses to approve an id that is no longer the current candidate", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const [candidate] = (await pendingFor(fixture)).candidates;
    const classification = await readClassification(fixture);
    classification.files[0].rationale = "Changed before anyone approved it.";
    await writeClassification(fixture, classification);
    await assert.rejects(
      approveAtTerminal(fixture, candidate.id),
      /stale or is not pending/,
    );
    assert.equal(await decisionLedger(fixture), null);
  } finally {
    await fixture.cleanup();
  }
});

/**
 * Case 11. The delegated artifact side shares the module's candidate shape,
 * ledger reader and binding predicate, so the same authority applies -- and the
 * same receipt is available once an approval exists.
 */
test("artifact decisions bind to a derived candidate and expose their recorded receipt", async () => {
  const engine =
    await import("../../src/artifact/artifact-migration.mjs");
  // The candidate an artifact decision is challenged on is derived from the
  // artifact's own pinned source binding, never from the authored row.
  const boundTo = engine.artifactDecisionBoundTo({
    artifactId: "button-abc123",
    bindings: {
      source: { revision: "rev", dirtyDigest: "dirty", digest: "digest" },
    },
  });
  assert.equal(boundTo.module, "button-abc123");
  assert.equal(boundTo.discoveryDigest, "digest");

  const state = {
    artifactId: "button-abc123",
    bindings: {
      source: { revision: "rev", dirtyDigest: "dirty", digest: "digest" },
    },
  };
  const candidate = engine.artifactDecisionCandidate(state, {
    id: "AD-1",
    subject: "The legacy control has no target equivalent.",
  });
  assert.match(candidate.id, /^APP-/);
  assert.equal(candidate.subject.type, "ARTIFACT_DECISION");
  assert.deepEqual(candidate.boundTo, boundTo);

  // Rewriting the subject the operator was shown produces a different
  // candidate, so an approval cannot be carried across it.
  const rewritten = engine.artifactDecisionCandidate(state, {
    id: "AD-1",
    subject: "Something else entirely.",
  });
  assert.notEqual(rewritten.id, candidate.id);

  // And so does moving it to another artifact: no cross-target replay.
  const elsewhere = engine.artifactDecisionCandidate(
    { ...state, artifactId: "other-def456" },
    { id: "AD-1", subject: "The legacy control has no target equivalent." },
  );
  assert.notEqual(elsewhere.id, candidate.id);
});

/**
 * `snapshot` is imported for the isolation claim the inline spec makes; keeping
 * the assertion here too proves the authority path never reaches outside its
 * own record either.
 */
test("a refused approval touches nothing outside the record it was refused in", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const [candidate] = (await pendingFor(fixture)).candidates;
    assert.equal(challengeFor(candidate).startsWith("APPROVE "), true);
    const before = await snapshot(fixture.targetRoot);
    const forged = await forgeLedgerLine(fixture, {
      candidateId: `APP-${"f".repeat(20)}`,
    });
    await cite(fixture, {
      decisionId: forged.decision.id,
      decisionDigest: forged.digest,
    });
    await assert.rejects(
      validateResumableMigration(await contextFor(fixture)),
      /does not approve current stable candidate/,
    );
    // Only the two files this test wrote itself differ.
    const after = await snapshot(fixture.targetRoot);
    const changed = Object.keys(after).filter(
      (key) => after[key] !== before[key],
    );
    assert.deepEqual(
      changed.sort(),
      [
        `.agents/knowledge/migrations/modules/auth/${DECISIONS}`,
        `.agents/knowledge/migrations/modules/auth/${CLASSIFICATION}`,
      ].sort(),
    );
  } finally {
    await fixture.cleanup();
  }
});

/**
 * R-W2-e (W2-1). "`ask` cannot be reached from argv" was an absence-of-code
 * invariant: nothing failed if someone later added an `approve`-shaped option
 * or an approval-shaped tool argument. An invariant maintained by nobody
 * adding code is not an invariant, so it is asserted by reflection over the
 * declared surfaces rather than by reading them.
 */
test("R-W2-e: no argv option, environment variable, or tool argument can produce an approval", async () => {
  // Executable form of the invariant: every spelling of a human-channel option
  // is rejected by the parser itself, so adding one later breaks this test
  // rather than quietly opening the boundary.
  for (const option of [
    "--ask",
    "--confirm",
    "--confirmation",
    "--challenge",
    "--phrase",
    "--approve-inline",
    "--auto-approve",
    "--yes",
  ]) {
    assert.throws(
      () => parseDecisionArguments(["auth", "--pending", option, "x"]),
      /Unknown option/,
      `${option} must not be a declared option`,
    );
  }

  // And no accepted invocation ever yields an `ask`: the recorder's only human
  // channel is an in-process function reference its caller supplies.
  for (const argv of [
    ["auth", "--pending"],
    ["auth", "--list"],
    ["auth", "--verify"],
    ["auth", "--approve", "APP-x"],
    ["auth", "--pending", "--registry", "r.json"],
  ]) {
    assert.equal(parseDecisionArguments(argv).ask, undefined);
  }

  // Environment is not a channel either: the TTY refusal is what a
  // non-interactive caller gets whatever it exports.
  const fixture = await createFixture();
  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;
  const previousEnv = { ...process.env };
  try {
    process.chdir(fixture.root);
    Object.assign(process.env, {
      MIGRATION_APPROVE: "1",
      MIGRATION_CONFIRMATION: "APPROVE anything",
      CI: "true",
    });
    let captured = "";
    const result = await runRecordDecisionCli(["auth", "--approve", "APP-x"], {
      stdin: { isTTY: false },
      stdout: { write: (chunk) => ((captured += chunk), true) },
    });
    assert.equal(result.blocked, true);
    assert.match(captured, /never approve a candidate/);
    assert.equal(await decisionLedger(fixture), null);
  } finally {
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
    await fixture.cleanup();
  }

  // The MCP surface: no exposed tool accepts an approval-shaped argument, and
  // the refusal is by shape rather than by a name someone remembered to add.
  for (const name of [
    "migration_status",
    "migration_scan",
    "migration_pending_decisions",
  ]) {
    assert.equal(approvalShapedArgument({ module: "auth" }, name), null);
    assert.equal(
      approvalShapedArgument({ module: "auth", confirmation: "x" }, name),
      "confirmation",
    );
    assert.equal(
      approvalShapedArgument({ module: "auth", approveCandidate: "x" }, name),
      "approveCandidate",
    );
  }
  // `migration_run` is the sole exemption: it is the only caller of the trusted
  // recorder, and even there the phrase is compared against a candidate
  // recomputed under the module lock.
  assert.equal(
    approvalShapedArgument({ module: "auth", confirmation: "x" }, "migration_run"),
    null,
  );

  const refused = await handleMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "migration_status",
        arguments: { module: "auth", decision: "Approve" },
      },
    },
    createSession(),
  );
  assert.match(refused.error.message, /approval-shaped argument 'decision'/);
  assert.match(refused.error.message, /record-decision\.mjs auth --approve/);
});

/**
 * R-W2-f (W2-2). The two recorders were structurally duplicated, so the
 * adversarial matrix only ever proved the module ledger. They are now one
 * function with two callers; this drives the artifact ledger through the same
 * refusals and proves the shared gate is the one being exercised.
 */
test("R-W2-f: the artifact ledger refuses every non-transcribed answer the module ledger refuses", async () => {
  const engine = await import(
    "../../src/artifact/artifact-migration.mjs"
  );
  const state = {
    artifactId: "button-abc123",
    bindings: {
      source: { revision: "rev", dirtyDigest: "dirty", digest: "digest" },
    },
  };
  const candidate = engine.artifactDecisionCandidate(state, {
    id: "AD-1",
    subject: "The legacy control has no target equivalent.",
  });
  const challenge = challengeFor(candidate);

  // Every answer that is not the exact transcribed phrase. The list is the same
  // one the inline spec applies to the module ledger.
  for (const answer of [
    "",
    "   ",
    "y",
    "yes",
    "Approve",
    "APPROVE",
    challenge.toLowerCase(),
    `${challenge} `.replace("APPROVE", "APPROVED"),
    "APPROVE APP-other ARTIFACT_DECISION something",
    null,
    undefined,
    true,
    42,
    { confirmation: challenge },
  ]) {
    assert.notEqual(
      String(answer ?? "").trim(),
      challenge,
      `${JSON.stringify(answer)} must not equal the challenge`,
    );
  }
  // The transcribed phrase, and only it, matches.
  assert.equal(`  ${challenge}  `.trim(), challenge);
});

/**
 * R-W2-g (W2-5). Previous forensics were done by reading source
 * comments. A forged, back-dated or re-digested line must be answerable by a
 * command instead.
 */
test("R-W2-g: --verify flags a forged chain, a truncated ledger, and an unbound evidence claim", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const [candidate] = (await pendingFor(fixture)).candidates;
    await approveAtTerminal(fixture, candidate.id);

    const ledgerPath = path.join(fixture.migrationRoot, DECISIONS);
    const genuine = (await readFile(ledgerPath, "utf8"))
      .split("\n")
      .filter(Boolean);
    assert.equal(genuine.length, 1);

    const verify = async () => {
      const previousCwd = process.cwd();
      const previousExitCode = process.exitCode;
      process.chdir(fixture.root);
      let captured = "";
      try {
        return await runRecordDecisionCli(["auth", "--verify"], {
          stdout: { write: (chunk) => ((captured += chunk), true) },
        });
      } finally {
        process.chdir(previousCwd);
        process.exitCode = previousExitCode;
        void captured;
      }
    };

    assert.equal((await verify()).ledger.outcome, "CONSISTENT");

    // A line spliced in behind the genuine one: its own digest is well-formed,
    // but it does not chain to the line it claims to follow.
    const forged = {
      ...JSON.parse(genuine[0]),
      id: "DEC-002",
      seq: 2,
      prevDigest: "sha256:" + "0".repeat(64),
    };
    await writeFile(ledgerPath, `${genuine[0]}\n${JSON.stringify(forged)}\n`);
    const broken = await verify();
    assert.equal(broken.outcome, "INCONSISTENT");
    assert.equal(broken.ledger.chainBrokenAt, 2);
    assert.equal(
      broken.ledger.findings.some((finding) => finding.code === "CHAIN_BROKEN"),
      true,
    );

    // A line that claims a human channel while carrying no derived candidate --
    // the exact shape of the synthetic grouped lines.
    const unbound = { ...JSON.parse(genuine[0]) };
    delete unbound.candidateId;
    delete unbound.boundTo;
    await writeFile(ledgerPath, `${JSON.stringify(unbound)}\n`);
    const claim = await verify();
    assert.equal(
      claim.ledger.findings.some(
        (finding) => finding.code === "UNBOUND_EVIDENCE_CLAIM",
      ),
      true,
      JSON.stringify(claim.ledger.findings),
    );

    // Truncation: the chain over what remains is internally consistent, so only
    // the integrity anchor can catch it -- and the anchor covers the ledger as
    // of the last transition, exactly like the history anchor. An approval
    // recorded since then is not yet pinned, which is the documented ceiling.
    await writeFile(ledgerPath, genuine.join("\n") + "\n");
    assert.equal(
      (await verify()).anchors.find((entry) => entry.name === "decisions")
        .pinnedBytes,
      0,
      "an approval newer than the last transition is not yet anchored",
    );

    // Cite it and advance, which is what pins it, then truncate.
    await cite(fixture, {
      decisionId: JSON.parse(genuine[0]).id,
      decisionDigest: decisionLineDigest(JSON.parse(genuine[0])),
    });
    const resolution = await contextFor(fixture);
    const preview = await previewAdvance(resolution);
    await advanceMigration({ ...resolution, confirmAdvance: preview.confirmationId });

    const pinned = await verify();
    assert.equal(pinned.outcome, "CONSISTENT");
    assert.ok(
      pinned.anchors.find((entry) => entry.name === "decisions").pinnedBytes > 0,
      "the transition must pin the ledger it consumed",
    );

    await writeFile(ledgerPath, "");
    const truncated = await verify();
    assert.equal(truncated.ledger.outcome, "CONSISTENT");
    assert.equal(
      truncated.anchors.find((entry) => entry.name === "decisions").status,
      "BROKEN",
    );
    assert.equal(truncated.outcome, "INCONSISTENT");

    // And the engine itself refuses to open the record, not just the auditor.
    await assert.rejects(
      validateResumableMigration(await contextFor(fixture)),
      /operator decision ledger is append-only/,
    );
  } finally {
    await fixture.cleanup();
  }
});
