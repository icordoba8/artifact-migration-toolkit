// Track A3: the decisions/ module boundary, and adversarial cases for the
// authority rules decisions/ now owns over facts its callers supply. The
// single-entry and import-direction checks shared with store/, shared/ and
// formats/ are A1-ARCH-1/2 in `store-shared.test.mjs`.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as decisions from "../../src/decisions/index.mjs";

const {
  autoApprovalChannel,
  autoAuthorization,
  assertRelayDecision,
  buildDecision,
  candidateDigestOf,
  createNewFormatDecisionCandidate,
  deriveModuleDecisions,
  lockedApprovalCandidate,
  operatorAnswer,
  projectModuleDecision,
  relayAnswer,
  relayedReview,
  reviewFor,
  reviewReference,
} = decisions;

const src = fileURLToPath(new URL("../../src/", import.meta.url));
const ts = createRequire(import.meta.url)("ts-discovery-compiler");

const engineFiles = async () =>
  (await readdir(src, { recursive: true })).filter((file) => file.endsWith(".mjs")).map((file) => file.split(path.sep).join("/"));
const parse = async (file) =>
  ts.createSourceFile(file, await readFile(path.join(src, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declared = (sf) => sf.statements.flatMap((statement) =>
  ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ? [statement.name.text]
    : ts.isVariableStatement(statement) ? statement.declarationList.declarations.map((d) => d.name.getText(sf)) : []);

// -- architecture --------------------------------------------------------------

test("A3-ARCH-1: every decisions declaration has exactly one live definition, inside decisions/", async () => {
  const files = await engineFiles();
  const owned = new Set();
  for (const file of files.filter((file) => file.startsWith("decisions/"))) {
    for (const name of declared(await parse(file))) {
      assert.ok(!owned.has(name), `${name} is declared twice inside decisions/`);
      owned.add(name);
    }
  }
  for (const file of files.filter((file) => !file.startsWith("decisions/"))) {
    assert.deepEqual(declared(await parse(file)).filter((name) => owned.has(name)), [], file);
  }
});

test("A3-ARCH-2: engine code imports decisions-owned names from decisions/index.mjs, never through a compatibility re-export", async () => {
  const offenders = [];
  for (const file of (await engineFiles()).filter((file) => !file.startsWith("decisions/"))) {
    for (const statement of (await parse(file)).statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
      const spec = statement.moduleSpecifier.text;
      if (!spec.startsWith(".")) continue;
      const target = path.resolve(src, path.dirname(file), spec);
      if (target === path.join(src, "decisions/index.mjs")) continue;
      const module = await import(pathToFileURL(target).href);
      for (const element of statement.importClause.namedBindings.elements) {
        const name = (element.propertyName ?? element.name).text;
        if (Object.hasOwn(decisions, name) && module[name] === decisions[name]) offenders.push(`${file}: ${name} from ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

// Nothing below decisions/ may import it (A1-ARCH-2), so with an acyclic
// inside it cannot sit on any engine import cycle.
test("A3-ARCH-3: decisions/ adds no import cycle: its files import each other acyclically", async () => {
  const files = (await engineFiles()).filter((file) => file.startsWith("decisions/"));
  const edges = new Map();
  for (const file of files) {
    edges.set(file, (await parse(file)).statements
      .filter((statement) => (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier)
      .map((statement) => path.posix.join(path.posix.dirname(file), statement.moduleSpecifier.text))
      .filter((target) => target.startsWith("decisions/")));
  }
  const state = new Map();
  const visit = (file, trail) => {
    assert.notEqual(state.get(file), "open", `import cycle: ${[...trail, file].join(" -> ")}`);
    if (state.get(file) === "done") return;
    state.set(file, "open");
    for (const next of edges.get(file) ?? []) visit(next, [...trail, file]);
    state.set(file, "done");
  };
  for (const file of files) visit(file, []);
});

// Every module that exported a decisions-owned name at BASE still does, and
// re-exports the decisions binding itself rather than a copy.
const COMPAT = {
  "core.mjs": ["AMEND_SLICE", "OPERATION_SEQUENCE_KIND", "challengeForOperationSequence", "renderOperationSequence", "LATE_DECISION_KINDS", "createDecisionCandidate", "decisionAppliesToCandidate", "decisionChannelOf", "decisionGroupFor", "decisionLineDigest", "decisionRationaleDigest", "edgeDecisionSubject", "lifecycleBinding", "projectModuleDecision", "rawDecisionLedgerDigest", "readAutoDecisions", "readOperatorDecisions", "readRecordedDecisions", "sequenceAuthorizationEvidence"],
  "resumable-migration.mjs": ["DECISION_GROUP_KIND", "DECISION_PRINCIPALS", "DECISION_RESULTS", "DEFAULT_DECISION_POLICY_DIGEST", "DEFAULT_DECISION_POLICY_ID", "LATE_DECISION_KINDS", "attestationVerifierScope", "attestedLineProblem", "brandSequenceAuthorization", "candidateDigestOf", "createDecisionCandidate", "createNewFormatDecisionCandidate", "createNewFormatDecisionGroup", "decisionAppliesToCandidate", "decisionChannelOf", "decisionGroupFor", "decisionKindAllowed", "decisionLineDigest", "decisionLineProblem", "decisionPrincipalOf", "decisionRationaleDigest", "edgeDecisionSubject", "lifecycleBinding", "principalSatisfiesRequirement", "projectModuleDecision", "rawDecisionLedgerBytes", "rawDecisionLedgerDigest", "readAutoDecisions", "readOperatorDecisions", "readRecordedDecisions", "resolveApplicableDecision", "resolveGroupDecision", "resolveHistoricalRequiredPrincipal", "resolveRequiredPrincipal", "sequenceAuthorizationEvidence", "validateProtectedDecisionPolicy"],
  "record-decision.mjs": ["APPROVAL_CHANNELS", "APPROVAL_EVIDENCE_PHRASES", "DECISION_KINDS", "SIGNER_UNAVAILABLE", "approvedByPhrase", "assertReviewedCandidateCurrent", "auditDecisionLedger", "autoApprovalChannel", "autoMayDecide", "buildDecision", "challengeFor", "channelOf", "groupFactsDigest", "ledgerFileForChannel", "rationaleDigestOf", "renderDecisionReview", "reviewFor", "reviewReference"],
  "operator-approval.mjs": ["renderCandidateBlock", "renderGroupBlock"],
  "artifact/artifact-migration.mjs": ["artifactDecisionBoundTo", "artifactDecisionCandidate"],
  "operation-sequence.mjs": ["AMEND_SLICE", "OPERATION_SEQUENCE_KIND", "challengeForOperationSequence", "renderOperationSequence"],
};

test("A3-ARCH-4: historical compatibility exports remain, as the decisions binding itself", async () => {
  for (const [file, names] of Object.entries(COMPAT)) {
    const module = await import(pathToFileURL(path.join(src, file)).href);
    for (const name of names) assert.equal(module[name], decisions[name], `${file} ${name}`);
  }
});

// -- authority over supplied facts --------------------------------------------

const silent = () => ({ text: "", write(chunk) { this.text += chunk; return true; } });
const neverAsked = () => { throw new Error("this principal must not be asked"); };
const boundTo = {
  module: "orders",
  legacyRevision: "rev-1",
  legacyDirtyDigest: "sha256:dirty",
  discoveryDigest: "sha256:discovery",
  algorithmVersion: 2,
};
const relayed = (overrides = {}) =>
  createNewFormatDecisionCandidate({
    projectRoot: path.resolve(os.tmpdir(), "a3-project"),
    kind: "TARGET_DRIFT_ACCEPTED",
    subjectType: "TARGET_FILE",
    subjectPath: "src/app.ts",
    rationale: "formatter run",
    targets: [],
    boundTo,
    ...overrides,
  }).then((candidate) => ({ ...candidate, approvable: true, blockers: [], review: reviewFor(candidate) }));

test("A3: AUTO and a host channel never answer a format-19 review, and a signer requirement is never met locally", async () => {
  const candidate = await relayed();
  assert.equal(candidate.requiredPrincipal, "AGENT_RELAYED");
  const auto = await operatorAnswer({ selected: candidate, stdout: silent(), ask: Object.assign(neverAsked, { channel: "AUTO" }) });
  assert.equal(auto.refused.blocked.state, "NON_SIGNER_AUTHORITY_REFUSED");
  const attested = { ...candidate, requiredPrincipal: "HUMAN_ATTESTED", review: undefined, blocked: undefined };
  const host = await operatorAnswer({ selected: attested, stdout: silent(), ask: neverAsked });
  assert.equal(host.refused.blocked.state, "SIGNER_UNAVAILABLE");
});

test("A3: only an exact APPROVE or REJECT is a format-19 answer; anything else records nothing", async () => {
  const candidate = await relayed();
  for (const answer of ["accept", "approve", "APPROVE ", "", true, null, challengeless()]) {
    const outcome = await operatorAnswer({ selected: candidate, stdout: silent(), ask: async () => answer });
    assert.equal(outcome.refused?.blocked.state, "CANCELLED", JSON.stringify(answer));
  }
  assert.deepEqual(await operatorAnswer({ selected: candidate, stdout: silent(), ask: async () => "REJECT" }), { result: "REJECTED" });
  assert.deepEqual(await operatorAnswer({ selected: candidate, stdout: silent(), ask: async () => "APPROVE" }), { result: "APPROVED" });
});
function challengeless() { return { decision: "APPROVE" }; }

test("A3: a legacy challenge accepts only its exact phrase, and AUTO is never asked about an underivable candidate", async () => {
  const legacy = { id: "APP-1", kind: "EXCLUSION", subject: { type: "FILE", path: "a.ts" }, approvable: true, blockers: [], boundTo };
  const renderSummary = () => "summary\n";
  const wrong = await operatorAnswer({ selected: legacy, renderSummary, stdout: silent(), ask: async ({ challenge }) => `${challenge} please` });
  assert.equal(wrong.refused.blocked, true);
  const right = await operatorAnswer({ selected: legacy, renderSummary, stdout: silent(), ask: async ({ challenge }) => challenge });
  assert.deepEqual(right, { result: undefined });
  const auto = Object.assign(neverAsked, { channel: "AUTO" });
  for (const selected of [
    { ...legacy, autoResolvable: false },
    { ...legacy, groupMembers: [{ autoResolvable: true }, { autoResolvable: false }] },
  ]) {
    const refused = await operatorAnswer({ selected, renderSummary, stdout: silent(), ask: auto });
    assert.equal(refused.refused.blocked, true);
  }
});

test("A3: under the lock only the deep-equal reviewed candidate is writable, at the same principal", async () => {
  const candidate = await relayed();
  assert.equal(lockedApprovalCandidate(candidate, [structuredClone(candidate)]).id, candidate.id);
  assert.throws(() => lockedApprovalCandidate(candidate, [{ ...candidate, rationale: "edited" }]), /changed while its review was open/);
  assert.throws(() => lockedApprovalCandidate(candidate, [{ ...candidate, requiredPrincipal: "HUMAN_ATTESTED" }]), /changed while its review was open/);
  assert.throws(() => lockedApprovalCandidate(candidate, []), /changed while its review was open/);
  const legacy = { id: "APP-1", kind: "EXCLUSION", approvable: true, boundTo };
  assert.throws(() => lockedApprovalCandidate(legacy, [{ ...legacy, approvable: false }]), /ceased to be pending/);
});

test("A3: a rejection blocks until the facts change, and then the candidate is stale, never approved", async () => {
  const candidate = await relayed();
  const rejected = buildDecision({
    previous: null, kind: candidate.kind, subjectType: candidate.subject.type, subject: candidate.subject.path,
    statement: "AGENT_RELAYED REJECTED.", rationale: candidate.rationale, candidateId: candidate.id,
    targets: candidate.targets, boundTo: candidate.boundTo, principal: "AGENT_RELAYED", result: "REJECTED",
    candidateDigest: candidateDigestOf(candidate), policyId: candidate.policyId, policyDigest: candidate.policyDigest,
    at: "2026-01-01T00:00:00.000Z", operator: "op@host",
  });
  const view = await projectModuleDecision({ decisions: [rejected], candidate, label: "c" });
  assert.equal(view.state, "REJECTED");
  const moved = await relayed({ rationale: "formatter run, then an edit" });
  assert.equal((await projectModuleDecision({ decisions: [rejected], candidate: moved, label: "c" })).state, "STALE");
});

test("A3: a relay answers only the review its reference names, and only with the explicit decision", async () => {
  const candidate = await relayed();
  const other = await relayed({ subjectPath: "src/other.ts" });
  const reference = reviewReference(candidate.review);
  assert.equal(await relayAnswer(reference, "APPROVE")({ review: candidate.review }), "APPROVE");
  assert.equal(await relayAnswer(reference, "APPROVE")({ review: other.review }), "");
  assert.throws(() => assertRelayDecision("approve"), /APPROVE or REJECT/);
  const pending = { decisions: { directLedger: true }, group: null, candidates: [other, candidate] };
  assert.equal(relayedReview(pending, reference, "orders"), candidate);
  assert.equal(relayedReview(pending, "review-stale", "orders"), undefined);
  assert.throws(() => relayedReview({ ...pending, decisions: { directLedger: false } }, reference, "orders"), /does not use direct-ledger/);
});

test("A3: AUTO provenance names exactly the identity its seam supplied; a human line carries none", () => {
  const toolkit = { name: "t", version: "1.0.0" };
  const candidate = { kind: "EXCLUSION", subject: { type: "FILE", path: "a" }, boundTo };
  assert.equal(autoAuthorization(autoApprovalChannel("evidence"), candidate, toolkit).toolkit, toolkit);
  assert.equal(autoAuthorization(null, candidate, toolkit), undefined);
});

// Offer == accept, derived from supplied facts: after DISCOVERY_COMPLETENESS
// only late kinds are offered, and a format-19 group (GROUP_APPROVAL, not a
// late kind) is not offered because its writer would refuse it.
test("A3: post-census facts offer only what the writer accepts, at each format", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "a3-decisions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "state.json"), "{}\n");
  const facts = (formatVersion) => ({
    module: "orders",
    projectRoot: root,
    root,
    state: { formatVersion, completedSteps: ["DISCOVERY_COMPLETENESS"] },
    classification: {
      moduleRoots: [{ path: "extra", reason: "declared" }],
      files: [{ path: "dead.ts", disposition: "DEAD", rationale: "unused" }],
      findings: [],
    },
    scan: { discoveryDigest: "sha256:discovery", algorithmVersion: 2, moduleRoots: [], findings: [] },
    legacySource: { legacyRevision: "rev-1", legacyDirtyDigest: "sha256:dirty" },
    legacySources: ["orders"],
    ledger: { decisions: [], byId: new Map() },
    targetDrift: ["a.txt", "b.txt"].map((subjectPath) => ({ subjectPath, rationale: "drift", autoResolvable: true, pathDigest: `sha256:${subjectPath}` })),
    visualUnbacked: [],
    approveCommand: (id) => `approve ${id}`,
  });
  const direct = await deriveModuleDecisions(facts(19));
  assert.deepEqual(direct.candidates.map((candidate) => candidate.kind), ["TARGET_DRIFT_ACCEPTED", "TARGET_DRIFT_ACCEPTED"]);
  assert.equal(direct.group, null);
  assert.ok(direct.candidates.every((candidate) => candidate.requiredPrincipal === "AGENT_RELAYED" && candidate.command === undefined));
  const legacy = await deriveModuleDecisions(facts(18));
  assert.deepEqual(legacy.candidates.map((candidate) => candidate.command), legacy.candidates.map((candidate) => `approve ${candidate.id}`));
  assert.deepEqual(legacy.group.groupMembers.map((member) => member.kind), ["TARGET_DRIFT_ACCEPTED", "TARGET_DRIFT_ACCEPTED"]);
  assert.equal(legacy.decisions.state, "AWAITING_HUMAN_DECISION");
});
