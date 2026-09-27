/**
 * Plan 06 §11. The adapter is a transport, so every test here asks one of two
 * questions: did the message shape survive, and did the server add something it
 * was not allowed to add -- a rule, a mapping, a write path, or an approval.
 *
 * The server is driven in-process over a pair of `PassThrough` streams. No
 * child process, no real stdio, and nothing here touches the real repository
 * except §11.10, which is read-only against the live `auth` record and asserts
 * it stayed byte-identical.
 */

import assert from "node:assert/strict";

import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  exitCodeFor,
  getMigrationStatus,
  MIGRATION_MODES,
  pendingDecisionCandidates,
  PONYTAIL_TARGETS,
  renderProgress,
} from "../../src/core.mjs";
import { challengeFor } from "../../src/record-decision.mjs";
import { parseRunArguments, runMigration } from "../../src/cli/run-migration.mjs";
import { serve } from "../../src/mcp-server.mjs";

import {
  execFileAsync,
  repositoryRoot,
  readJson,
  snapshot,
  createFixture,
  resolutionFor,
  initialize,
  MODULE_CLASSIFICATION,
  EXCLUDED_CLASSIFICATION,
  NON_APPROVABLE_CLASSIFICATION,
  authorDiscoverLegacy,
  atDiscoveryCompleteness,
  state,
  historyEvents,
  decisionLedger,
} from "../integration/approval.fixture.mjs";

/**
 * Drives the server over a pair of streams, from the fixture's working
 * directory, and returns every frame it wrote. `process.stdout` is left alone
 * on purpose: §11.7's whole claim is that the server never touches it, so any
 * byte that escapes there is a failure the test must be able to see.
 */
const converse = async (fixture, messages) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = [];
  output.setEncoding("utf8");
  let buffered = "";
  output.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop();
    for (const line of lines) frames.push(line);
  });
  const cwd = process.cwd();
  const previousExitCode = process.exitCode;
  process.chdir(fixture ? fixture.root : repositoryRoot);
  try {
    const served = serve({ input, output });
    for (const message of messages) {
      input.write(
        `${typeof message === "string" ? message : JSON.stringify(message)}\n`,
      );
    }
    input.end();
    await served;
    return { frames, raw: frames.map((line) => JSON.parse(line)) };
  } finally {
    process.chdir(cwd);
    process.exitCode = previousExitCode;
  }
};

const call = (id, name, arguments_ = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: arguments_ },
});

const only = async (fixture, message) => {
  const { raw } = await converse(fixture, [message]);
  assert.equal(raw.length, 1, JSON.stringify(raw));
  return raw[0];
};

const structured = (response) => {
  assert.ok(!response.error, JSON.stringify(response.error));
  return response.result.structuredContent;
};

// --- §11.1 handshake ---------------------------------------------------------

test("initialize declares tools and neither elicitation nor resources", async () => {
  const { raw } = await converse(null, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {},
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ]);

  // The notification produced no reply, so exactly one frame came back.
  assert.equal(raw.length, 1);
  assert.equal(raw[0].id, 1);
  assert.equal(raw[0].result.protocolVersion, "2025-06-18");
  assert.deepEqual(Object.keys(raw[0].result.capabilities), ["tools"]);
  assert.equal(raw[0].result.capabilities.elicitation, undefined);
  assert.equal(raw[0].result.capabilities.resources, undefined);
  assert.equal(raw[0].result.capabilities.prompts, undefined);
  assert.equal(raw[0].result.serverInfo.name, "start-migration");
});

test("an unknown protocol version falls back instead of failing", async () => {
  const response = await only(null, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "1999-01-01" },
  });
  assert.equal(response.result.protocolVersion, "2025-06-18");
});

// --- §11.2 the tool set ------------------------------------------------------

test("tools/list is exactly the four tools of D6-2", async () => {
  const response = await only(null, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  const tools = response.result.tools;

  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "migration_pending_decisions",
    "migration_run",
    "migration_scan",
    "migration_status",
  ]);
  const run = tools.find((tool) => tool.name === "migration_run");
  const readOnlyTools = tools.filter((tool) => tool !== run);
  for (const tool of readOnlyTools) {
    assert.equal(typeof tool.description, "string");
    assert.deepEqual(tool.inputSchema.required, ["module"]);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), [
      "cwd",
      "module",
      "registry",
      "slice",
      "target",
    ]);
    assert.equal(tool.inputSchema.properties.mode, undefined);
    assert.equal(tool.inputSchema.properties.ponytail, undefined);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.deepEqual(Object.keys(run.inputSchema.properties).sort(), [
    "adoptTarget",
    "cwd",
    "designSource",
    "figma",
    "legacy",
    "mode",
    "module",
    "ponytail",
    "registry",
    "slice",
    "target",
  ]);
  assert.deepEqual(run.inputSchema.properties.mode.enum, MIGRATION_MODES);
  assert.deepEqual(
    run.inputSchema.properties.ponytail.enum,
    Object.keys(PONYTAIL_TARGETS),
  );
  assert.deepEqual(run.inputSchema.properties.designSource.enum, [
    "target-system",
    "figma-mcp",
  ]);
  assert.equal(run.inputSchema.properties.figma.type, "array");
  assert.equal(run.inputSchema.properties.figma.items.type, "string");
  assert.equal(run.inputSchema.properties.legacy.type, "array");
  assert.equal(run.inputSchema.properties.legacy.items.type, "string");
  assert.equal(run.inputSchema.properties.adoptTarget.type, "boolean");
  assert.equal(run.inputSchema.properties.mode.default, undefined);
  assert.equal(run.inputSchema.properties.ponytail.default, undefined);
  for (const mode of run.inputSchema.properties.mode.enum) {
    assert.equal(parseRunArguments(["auth", "--mode", mode]).mode, mode);
  }
  for (const ponytail of run.inputSchema.properties.ponytail.enum) {
    assert.doesNotThrow(() =>
      parseRunArguments(["auth", "--ponytail", ponytail]),
    );
  }
});

test("a call missing the required module is refused before any core call", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const before = await snapshot(fixture.migrationRoot);
    const response = await only(fixture, call(3, "migration_status", {}));
    assert.ok(response.error);
    assert.match(response.error.message, /'module' is required/);
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
  } finally {
    await fixture.cleanup();
  }
});

// --- §11.3 read-only tools write nothing -------------------------------------

test("the three read-only tools leave the record byte-identical and take no lock", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const before = await snapshot(fixture.migrationRoot);

    const { raw } = await converse(fixture, [
      call(1, "migration_status", { module: "auth" }),
      call(2, "migration_scan", { module: "auth" }),
      call(3, "migration_pending_decisions", { module: "auth" }),
    ]);

    assert.equal(raw.length, 3);
    for (const response of raw) structured(response);
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
    // No lock survived the calls, and none was left behind either.
    await assert.rejects(
      stat(path.join(fixture.migrationRoot, "module.lock")),
      {
        code: "ENOENT",
      },
    );
  } finally {
    await fixture.cleanup();
  }
});

// --- §11.4 verbatim return ---------------------------------------------------

test("migration_pending_decisions deep-equals the core reader, blockers included", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, NON_APPROVABLE_CLASSIFICATION);
    const resolution = await resolutionFor(fixture);
    const expected = await pendingDecisionCandidates({
      ...resolution,
      moduleName: "auth",
    });

    const returned = structured(
      await only(
        fixture,
        call(1, "migration_pending_decisions", { module: "auth" }),
      ),
    );

    assert.deepEqual(returned, expected);
    // D6-8: the non-approvable candidate is present. Its blockers are the
    // client's authoring work, and pruning them would be policy.
    assert.ok(returned.candidates.length > 0);
    assert.ok(returned.candidates.some((candidate) => !candidate.approvable));
    for (const candidate of returned.candidates) {
      assert.equal(typeof candidate.command, "string");
      assert.ok(Array.isArray(candidate.blockers));
    }
  } finally {
    await fixture.cleanup();
  }
});

test("migration_status exposes the same UI-evidence state as CLI/core", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, MODULE_CLASSIFICATION);
    const resolution = await resolutionFor(fixture);

    const status = structured(
      await only(fixture, call(1, "migration_status", { module: "auth" })),
    );
    const scan = structured(
      await only(fixture, call(2, "migration_scan", { module: "auth" })),
    );

    assert.deepEqual(
      status,
      JSON.parse(
        JSON.stringify(
          await getMigrationStatus({ ...resolution, moduleName: "auth" }),
        ),
      ),
    );
    // §1.4: the rendered checklist and the CLI command string cross as-is.
    assert.equal(typeof status.progressChecklist, "string");
    // Regression 19/21: CLI, core, and MCP agree on the *same* object,
    // including the explicit runtime-availability state, and no provider adds
    // a semantic of its own.
    assert.deepEqual(status.uiEvidence, {
      applicable: true,
      state: "MISSING",
      runtime: "REQUIRED",
      records: 0,
      limitations: 0,
      freshness: "CURRENT",
    });
    assert.equal(typeof scan.discoveryDigest, "string");
    assert.equal(typeof scan.algorithmVersion, "number");
  } finally {
    await fixture.cleanup();
  }
});

// --- §11.5 refused tools -----------------------------------------------------

test("every refused tool returns a method error naming the operator command", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const before = await snapshot(fixture.migrationRoot);
    const refused = [
      ["migration_approve", /record-decision\.mjs auth --approve/],
      ["migration_bootstrap", /discover-module\.mjs auth --registry/],
      ["migration_refresh", /discover-module\.mjs auth --refresh/],
      ["migration_register", /update-migration-registry\.mjs auth/],
      ["migration_upgrade", /upgrades\/upgrade-migration\.mjs auth/],
      ["migration_advance", /run-migration\.mjs auth/],
      ["migration_validate", /run-migration\.mjs auth/],
    ];

    const { raw } = await converse(
      fixture,
      refused.map(([name], index) => call(index + 1, name, { module: "auth" })),
    );

    assert.equal(raw.length, refused.length);
    raw.forEach((response, index) => {
      const [name, command] = refused[index];
      assert.ok(response.error, name);
      assert.equal(response.error.code, -32601, name);
      assert.match(response.error.message, command, name);
      assert.equal(response.result, undefined, name);
    });
    // No core call was made by any of them.
    assert.deepEqual(await snapshot(fixture.migrationRoot), before);
  } finally {
    await fixture.cleanup();
  }
});

test("an unknown tool is a method error, not a silent success", async () => {
  const response = await only(
    null,
    call(1, "migration_anything", { module: "auth" }),
  );
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /Unknown tool/);
});

test("a malformed frame is a parse error and the connection survives", async () => {
  const { raw } = await converse(null, [
    "{not json",
    { jsonrpc: "2.0", id: 7, method: "tools/list" },
  ]);
  assert.equal(raw.length, 2);
  assert.equal(raw[0].error.code, -32700);
  assert.equal(raw[0].id, null);
  assert.equal(raw[1].result.tools.length, 4);
});

// --- §11.6 no approval path --------------------------------------------------

test("no sequence of tool calls appends to the operator decisions ledger", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const before = await decisionLedger(fixture);

    const names = [
      "migration_status",
      "migration_scan",
      "migration_pending_decisions",
      "migration_run",
      "migration_approve",
    ];
    // Every argument shape an LLM caller could reach for, including fields no
    // schema declares: none of them is an approval channel.
    const { raw } = await converse(
      fixture,
      names.flatMap((name, index) => [
        call(index * 2 + 1, name, { module: "auth", mode: "step" }),
        call(index * 2 + 2, name, {
          module: "auth",
          mode: "step",
          approve: "any",
          decisionId: "OD-1",
          confirm: true,
        }),
      ]),
    );

    assert.equal(raw.length, names.length * 2);
    assert.equal(await decisionLedger(fixture), before);
    const pending = await pendingDecisionCandidates({
      ...(await resolutionFor(fixture)),
      moduleName: "auth",
    });
    // The candidate is still pending: nothing approved it.
    assert.ok(pending.candidates.length > 0);

    // And the invariant that matters most, under the mode where something
    // *does* get decided: `auto` resolves as the AUTO principal, and the human
    // operator ledger is still byte-identical afterwards. No tool call, in any
    // mode, with any argument shape, appends a human approval.
    await converse(
      fixture,
      names.flatMap((name, index) => [
        call(index * 2 + 1, name, { module: "auth" }),
        call(index * 2 + 2, name, {
          module: "auth",
          approve: "any",
          decisionId: "OD-1",
          confirm: true,
        }),
      ]),
    );
    assert.equal(await decisionLedger(fixture), before);
  } finally {
    await fixture.cleanup();
  }
});

// Posture change, recorded deliberately. The old invariant was "a transport
// with no human channel can never resolve a decision". The invariant now is
// narrower and stronger: it can never resolve one *as a human*. Under `auto`
// the AUTO principal resolves it as itself, into its own ledger; the human
// operator record stays absent, and no approval tool exists in either mode.
test("a run against a pending decision resolves as AUTO and never writes the human ledger", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);

    const result = structured(
      await only(fixture, call(1, "migration_run", { module: "auth" })),
    );

    assert.equal(result.outcome, "CONTINUE");
    assert.equal(result.exitCode, exitCodeFor("CONTINUE"));
    // The human record does not exist: AUTO wrote to its own ledger.
    assert.equal(await decisionLedger(fixture), null);
    // No terminal was read and no second command was handed to anyone.
    assert.doesNotMatch(result.log, /Challenge: APPROVE/);
    assert.doesNotMatch(result.log, /Operator approval required/);
  } finally {
    await fixture.cleanup();
  }
});

// --- §11.7 the protocol stream stays clean -----------------------------------

test("a migration_run writes exactly one JSON-RPC response and nothing else", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    await authorDiscoverLegacy(fixture);

    const { frames, raw } = await converse(fixture, [
      call(1, "migration_run", { module: "auth" }),
    ]);

    assert.equal(frames.length, 1, frames.join("\n"));
    assert.equal(raw[0].id, 1);
    const result = structured(raw[0]);
    // The preview text the wrappers printed is real, and all of it is in `log`.
    assert.ok(result.log.length > 200, `captured ${result.log.length} bytes`);
    assert.match(result.log, /^Pre-execution summary$/m);
    // D6-5: the loop directive is stdout contract and never crosses MCP.
    // D6-5: the outcome crosses as a typed field and the `loop:` line does not.
    // It is diagnostic text inside the captured log, exactly like the preview;
    // no typed field carries it, and the server neither builds nor reads one.
    const { log, ...typed } = result;
    assert.ok(!JSON.stringify(typed).includes("loop:"), JSON.stringify(typed));
    assert.equal(typed.outcome, "CONTINUE");
    assert.ok(log.includes("loop: CONTINUE"), log);
  } finally {
    await fixture.cleanup();
  }
});

// --- §11.8 outcome parity ----------------------------------------------------

/** The same driver the CLI entry point runs, on its own copy of the record. */
const cliOutcome = async (fixture, arguments_ = ["auth"]) => {
  const cwd = process.cwd();
  const previousExitCode = process.exitCode;
  const captured = [];
  process.chdir(fixture.root);
  try {
    const result = await runMigration(arguments_, {
      stdout: { write: (chunk) => (captured.push(String(chunk)), true) },
    });
    return { ...result, log: captured.join("") };
  } finally {
    process.chdir(cwd);
    process.exitCode = previousExitCode;
  }
};

test("CLI and MCP default omitted mode to auto", async () => {
  const viaMcp = await createFixture();
  const viaCli = await createFixture();
  try {
    await initialize(viaMcp);
    await initialize(viaCli);

    const mcp = structured(
      await only(viaMcp, call(1, "migration_run", { module: "auth" })),
    );
    const cli = await cliOutcome(viaCli);

    assert.match(mcp.log, /mode=auto/);
    assert.match(cli.log, /mode=auto/);
  } finally {
    await viaMcp.cleanup();
    await viaCli.cleanup();
  }
});

test("migration_run forwards full-audit unchanged to runMigration", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture, { ponytail: "full" });

    const result = structured(
      await only(
        fixture,
        call(1, "migration_run", {
          module: "auth",
          ponytail: "full-audit",
        }),
      ),
    );

    assert.equal(result.outcome, "FAILED");
    assert.equal(
      result.reason,
      "Ponytail target 'full-audit' conflicts with recorded target 'full'.",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("CLI and MCP reject invalid mode and Ponytail values consistently", async () => {
  await assert.rejects(
    runMigration(["auth", "--mode", "turbo"]),
    /--mode accepts 'auto' or 'step'\./,
  );
  const invalidMode = await only(
    null,
    call(1, "migration_run", { module: "auth", mode: "turbo" }),
  );
  assert.match(invalidMode.error.message, /--mode accepts 'auto' or 'step'\./);

  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const cli = await cliOutcome(fixture, ["auth", "--ponytail", "turbo"]);
    const mcp = structured(
      await only(
        fixture,
        call(2, "migration_run", { module: "auth", ponytail: "turbo" }),
      ),
    );
    assert.equal(cli.outcome, "FAILED");
    assert.equal(mcp.outcome, cli.outcome);
    assert.equal(mcp.reason, cli.reason);
    assert.match(mcp.reason, /Invalid Ponytail target 'turbo'/);
  } finally {
    await fixture.cleanup();
  }
});

test("session Ponytail never implicitly enables migration Ponytail", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    assert.equal((await state(fixture)).ponytail, null);

    await only(fixture, call(1, "migration_run", { module: "auth" }));

    assert.equal((await state(fixture)).ponytail, null);
  } finally {
    await fixture.cleanup();
  }
});

for (const [label, prepare, expected] of [
  [
    "CONTINUE",
    async (fixture) => {
      await initialize(fixture);
      await authorDiscoverLegacy(fixture);
    },
    "CONTINUE",
  ],
  [
    // A pending decision: AUTO resolves it under the default mode, and the two
    // transports must reach the same outcome by the same path. Parity is the
    // subject here, not which outcome it is.
    "a pending decision",
    (fixture) => atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION),
    "CONTINUE",
  ],
  [
    // A committed legacy change moves the pinned revision. AUTO blocks on that
    // drift until an operator explicitly confirms the mismatch; both transports
    // must report the same refusal without refreshing the record.
    "legacy revision drift",
    async (fixture) => {
      await initialize(fixture);
      await writeFile(
        path.join(fixture.legacyRoot, "auth/drift.txt"),
        "drift\n",
      );
      await execFileAsync("git", ["add", "-A"], { cwd: fixture.root });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=Mcp Test",
          "-c",
          "user.email=mcp@example.test",
          "commit",
          "-q",
          "-m",
          "legacy drift",
        ],
        { cwd: fixture.root },
      );
    },
    "BLOCKED",
  ],
]) {
  test(`migration_run and the CLI agree on ${label}`, async () => {
    const viaMcp = await createFixture();
    const viaCli = await createFixture();
    try {
      await prepare(viaMcp);
      await prepare(viaCli);
      const before = label === "legacy revision drift"
        ? [await snapshot(viaMcp.migrationRoot), await snapshot(viaCli.migrationRoot)]
        : null;

      const mcp = structured(
        await only(viaMcp, call(1, "migration_run", { module: "auth" })),
      );
      const cli = await cliOutcome(viaCli);

      assert.equal(mcp.outcome, expected, mcp.log);
      assert.equal(cli.outcome, mcp.outcome);
      assert.equal(mcp.exitCode, exitCodeFor(cli.outcome));
      assert.equal(
        (await state(viaMcp)).currentStep,
        (await state(viaCli)).currentStep,
      );
      assert.equal(
        (await state(viaMcp)).revision,
        (await state(viaCli)).revision,
      );
      if (before) {
        assert.match(mcp.log, /--refresh --confirm-mismatch/);
        assert.match(cli.log, /--refresh --confirm-mismatch/);
        assert.deepEqual(await snapshot(viaMcp.migrationRoot), before[0]);
        assert.deepEqual(await snapshot(viaCli.migrationRoot), before[1]);
      }
    } finally {
      await viaMcp.cleanup();
      await viaCli.cleanup();
    }
  });
}

// --- §11.9 one advance per call ----------------------------------------------

test("one migration_run moves the revision by one and appends one history event", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    await authorDiscoverLegacy(fixture);
    const before = await state(fixture);
    const events = await historyEvents(fixture);

    const result = structured(
      await only(fixture, call(1, "migration_run", { module: "auth" })),
    );

    assert.equal(result.outcome, "CONTINUE");
    assert.equal(result.exitCode, 0);
    const after = await state(fixture);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.currentStep, "DISCOVERY_COMPLETENESS");
    assert.equal(await historyEvents(fixture), events + 1);
    // D6-5: `state` is the same reader `migration_status` uses, so the client
    // sees where the record now stands without a second round trip.
    assert.equal(result.state.currentStep, after.currentStep);
  } finally {
    await fixture.cleanup();
  }
});

for (const [label, prepare, outcome] of [
  [
    "CONTINUE",
    async (fixture) => {
      await initialize(fixture);
      await authorDiscoverLegacy(fixture);
    },
    "CONTINUE",
  ],
  [
    // A checklist is projected for every outcome; the decision-bearing
    // checkpoint reaches CONTINUE now that AUTO resolves it.
    "a resolved decision",
    (fixture) => atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION),
    "CONTINUE",
  ],
]) {
  test(`migration_run exposes canonical progressChecklist on ${label}`, async () => {
    const fixture = await createFixture();
    try {
      await prepare(fixture);
      const result = structured(
        await only(fixture, call(1, "migration_run", { module: "auth" })),
      );

      assert.equal(result.outcome, outcome);
      assert.ok(result.progress);
      assert.equal(result.progressChecklist, renderProgress(result.progress));
      assert.equal(result.progressChecklist.includes("%"), false);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("an unauthored checkpoint returns CONTINUE with an authoring request and no advance", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);
    const before = await state(fixture);
    const events = await historyEvents(fixture);

    const result = structured(
      await only(fixture, call(1, "migration_run", { module: "auth" })),
    );

    assert.equal(result.outcome, "CONTINUE");
    // D6-5: `request !== null` is the test the enum decision predicted.
    assert.ok(result.request);
    assert.equal(result.request.step, before.currentStep);
    assert.match(
      result.request.schemaRef,
      /^references\/migration-contract\.md#/,
    );
    assert.equal((await state(fixture)).revision, before.revision);
    assert.equal(await historyEvents(fixture), events);
  } finally {
    await fixture.cleanup();
  }
});

// --- §11.10 the pre-10 live record -------------------------------------------

test("the format-9 auth record is refused by scan and pending_decisions, unchanged", async (t) => {
  const record = path.join(
    repositoryRoot,
    "sample-target-app/.agents/knowledge/migrations/modules/auth",
  );
  const recorded = await readJson(path.join(record, "state.json")).catch(
    () => null,
  );
  if (!recorded) {
    t.skip("the live auth record is not present in this working tree");
    return;
  }
  assert.ok(
    recorded.formatVersion < 10,
    `this test needs a pre-10 record; auth is format ${recorded.formatVersion}`,
  );
  const before = await snapshot(record);

  const { raw } = await converse(null, [
    call(1, "migration_scan", { module: "auth" }),
    call(2, "migration_pending_decisions", { module: "auth" }),
  ]);

  for (const response of raw) {
    assert.ok(response.error, JSON.stringify(response));
    assert.match(response.error.message, /format-10 operation/);
    assert.match(response.error.message, /Nothing was read or written/);
  }
  assert.deepEqual(await snapshot(record), before);
});

// --- 08 §11 the MCP front end owns a host-native human loop ------------------

/**
 * Like `converse`, but reactive. A server-originated request (a frame carrying
 * a `method`) is handed to `onRequest`, whose return value is written back as
 * that request's reply. Input closes once every client request has an answer,
 * so nothing here can hang on a server that never asks.
 */
const converseWith = async (fixture, messages, onRequest = null) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = [];
  const originated = [];
  const awaiting = new Set(
    messages
      .filter(
        (message) => typeof message === "object" && message.id !== undefined,
      )
      .map((message) => message.id),
  );
  output.setEncoding("utf8");
  let buffered = "";
  output.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop();
    for (const line of lines) {
      frames.push(line);
      const frame = JSON.parse(line);
      if (frame.method !== undefined) {
        originated.push(frame);
        const reply = onRequest?.(frame);
        input.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...reply })}\n`,
        );
        continue;
      }
      awaiting.delete(frame.id);
      if (awaiting.size === 0) input.end();
    }
  });
  const cwd = process.cwd();
  const previousExitCode = process.exitCode;
  process.chdir(fixture ? fixture.root : repositoryRoot);
  try {
    const served = serve({ input, output });
    for (const message of messages) input.write(`${JSON.stringify(message)}\n`);
    await served;
    return { originated, raw: frames.map((line) => JSON.parse(line)) };
  } finally {
    process.chdir(cwd);
    process.exitCode = previousExitCode;
  }
};

const handshake = (id, elicitation) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: elicitation ? { elicitation: {} } : {},
    clientInfo: { name: "test-host", version: "0" },
  },
});

const challengeAt = async (fixture) => {
  const pending = await pendingDecisionCandidates({
    ...(await resolutionFor(fixture)),
    moduleName: "auth",
  });
  const [candidate] = pending.candidates;
  return { candidate, challenge: challengeFor(candidate) };
};

/**
 * `08` proof 3: the host has an MCP front end to prefer, and is told to.
 *
 * The registration half of this proof splits in two. That each provider's MCP
 * template names this server, and names it without a consumer-relative engine
 * path, is owned by `test/providers-sync.test.mjs`. That the named entry point is
 * *launchable* cannot be proven from a committed template: it carries the
 * `{{ENGINE_MCP_ENTRY}}` placeholder on purpose, and an installed adapter is what
 * renders it, so that half belongs to provider installation.
 *
 * The canonical half, that the skill documents MCP as the preferred front end, is
 * owned here.
 */
test("the canonical skill prefers the MCP front end", async () => {
  const skill = await readFile(
    path.join(repositoryRoot, "skills/start-migration/SKILL.md"),
    "utf8",
  );
  // The MCP tool is named, named first, and named as the preferred front end.
  assert.ok(skill.includes("migration_run"), "the skill names the MCP tool");
  assert.ok(
    skill.includes("preferred whenever the `start-migration` MCP server"),
  );
  assert.ok(
    skill.includes(
      '{ "module": "roles", "target": "role", "ponytail": "full-audit" }',
    ),
    "the skill preserves migration options through the preferred MCP front end",
  );
  assert.ok(
    skill.indexOf("migration_run") <
      skill.indexOf("artifact-migration-run <module> ["),
    "MCP is documented before the Bash fallback",
  );

  // Only the design input the agent cannot supply itself is gathered from the
  // user: a Figma link. The design source itself has an engine default, so
  // asking for it is friction, not authority. What is asked is hashed into the
  // bootstrap confirmation ID, so a question asked after the preview would only
  // invalidate it -- and the engine cannot ask, being pure. The obligation is
  // stated here or nowhere.
  //
  // Matched against whitespace-collapsed prose: a rule must survive being
  // rewrapped at a different column, which is an editing artifact, not a
  // change of contract.
  const prose = skill.replace(/\s+/g, " ");
  for (const [proof, rule] of [
    [
      "a fresh missing design source is always requested",
      "The design source is a bootstrap input, collected with the others.",
    ],
    [
      "an unnamed design source is defaulted, not asked",
      "a bootstrap that named no `--design-source` takes that default without asking",
    ],
    [
      "the default is the target project's own design system",
      "It defaults to `target-system` — the target project's own design system",
    ],
    [
      "links are requested only when figma is asked for and absent",
      "when the request asks for Figma but carries no link, ask in one exchange",
    ],
    [
      "target-system is never asked for a link",
      "`target-system` needs none and is never asked for one",
    ],
    [
      "both are settled before the preview",
      "Settle both before the first preview call",
    ],
    [
      "the agent never parses a Figma URL",
      "Never invent, guess, complete, shorten, or parse a Figma URL",
    ],
    [
      "pre-supplied inputs, resumes, and defaulted values never prompt",
      "Never ask for a value the invocation already carries, never on a resume, and never for a value that has a default",
    ],
  ]) {
    assert.ok(
      prose.includes(rule),
      `the bootstrap input protocol no longer proves ${proof}: ${rule}`,
    );
  }
  assert.ok(
    skill.indexOf("The design source is a bootstrap input") <
      skill.indexOf("## Design source (Figma MCP)"),
    "the inputs are collected before the section that consumes them",
  );
});

/**
 * `08` proof 4. The approval request comes *from the server*: it is a frame the
 * server wrote first, with an id the server issued, on a method no tool call
 * can produce. The model's turn is over by then -- it called one tool and is
 * waiting for that tool's result.
 */
test("with client elicitation the server originates the approval request", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const { candidate, challenge } = await challengeAt(fixture);

    const { originated, raw } = await converseWith(
      fixture,
      [handshake(1, true), call(2, "migration_run", { module: "auth" })],
      (request) => ({
        result: {
          action: "accept",
          content: {
            confirmation: /^Confirmation phrase: (.+)$/m.exec(
              request.params.message,
            )[1],
          },
        },
      }),
    );

    assert.equal(originated.length, 1, JSON.stringify(originated));
    const [request] = originated;
    assert.equal(request.method, "elicitation/create");
    assert.match(String(request.id), /^sm-\d+$/);
    // The human reviews the candidate and transcribes its phrase, which is the
    // one thing a host cannot derive from the schema.
    assert.ok(request.params.message.includes(candidate.subject.path));
    assert.ok(request.params.message.includes(candidate.id));
    assert.ok(request.params.message.includes(`Confirmation phrase: ${challenge}`));
    assert.deepEqual(request.params.requestedSchema.required, ["confirmation"]);

    const result = structured(raw.find((frame) => frame.id === 2));
    assert.equal(result.outcome, "CONTINUE");
    const ledger = (await decisionLedger(fixture)).trim().split("\n");
    assert.equal(ledger.length, 1);
    const decision = JSON.parse(ledger[0]);
    assert.equal(decision.candidateId, candidate.id);
    assert.match(
      decision.statement,
      /host-originated approval request answered with the candidate confirmation phrase/,
    );
  } finally {
    await fixture.cleanup();
  }
});

/**
 * `08` proof 5. The model supplies the exact correct challenge phrase as a tool
 * argument and the human declines. Nothing is written. The phrase the model
 * controls is not the phrase that is compared; the elicitation answer is.
 */
test("a model-supplied challenge approves nothing when the human declines", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const { challenge } = await challengeAt(fixture);
    const before = await state(fixture);

    const { originated, raw } = await converseWith(
      fixture,
      [
        handshake(1, true),
        // Every shape a model could reach for, the real phrase included.
        call(2, "migration_run", {
          module: "auth",
          challenge,
          approve: challenge,
          ask: false,
          decisionId: "DEC-001",
        }),
        call(3, "migration_approve", { module: "auth", challenge }),
      ],
      () => ({ result: { action: "decline" } }),
    );

    // The server still asked a human, and the human said no.
    assert.equal(originated.length, 1);
    assert.equal(originated[0].method, "elicitation/create");
    const run = structured(raw.find((frame) => frame.id === 2));
    assert.equal(run.outcome, "OPERATOR_DECISION");
    assert.equal(run.exitCode, exitCodeFor("OPERATOR_DECISION"));
    // D6-3 still holds: there is no approval tool to call at all.
    const refused = raw.find((frame) => frame.id === 3);
    assert.equal(refused.error.code, -32601);
    assert.equal(await decisionLedger(fixture), null);
    assert.equal((await state(fixture)).revision, before.revision);
  } finally {
    await fixture.cleanup();
  }
});

/**
 * `08` proof 6. A host that cannot ask a human is D6-4 unchanged: no request is
 * originated, the run stops, and the record is byte-identical.
 */
test("without client elicitation the server asks nothing and stops safely", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const before = await snapshot(fixture.migrationRoot);

    const { originated, raw } = await converseWith(
      fixture,
      [handshake(1, false), call(2, "migration_run", { module: "auth" })],
      () => assert.fail("a client without elicitation must never be asked"),
    );

    assert.deepEqual(originated, []);
    const result = structured(raw.find((frame) => frame.id === 2));
    // No human was asked, because there is none to ask. What answers instead is
    // the AUTO principal, by mode, in the core -- never a synthesized human.
    assert.equal(result.outcome, "CONTINUE");
    // The human record is still absent -- the AUTO ledger is a different file.
    assert.equal(await decisionLedger(fixture), null);
    assert.notDeepEqual(await snapshot(fixture.migrationRoot), before);
  } finally {
    await fixture.cleanup();
  }
});

/**
 * `08` D8-1's second half. A stdio server's TTY, if it had one, would belong to
 * the transport -- so the terminal approver must be unreachable from MCP even
 * when both process streams report one. Without the `approve !== undefined`
 * distinction this test writes a readline prompt into the JSON-RPC stream and
 * the frame count goes wrong.
 */
test("an MCP run never falls back to the transport's own TTY", async () => {
  const fixture = await createFixture();
  try {
    await atDiscoveryCompleteness(fixture, EXCLUDED_CLASSIFICATION);
    const before = await snapshot(fixture.migrationRoot);
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    const previousStdoutTty = process.stdout.isTTY;
    const terminal = new PassThrough();
    terminal.isTTY = true;
    terminal.setRawMode = () => terminal;
    Object.defineProperty(process, "stdin", {
      configurable: true,
      get: () => terminal,
    });
    process.stdout.isTTY = true;
    let result;
    try {
      const { originated, raw } = await converseWith(
        fixture,
        [handshake(1, false), call(2, "migration_run", { module: "auth" })],
        () => assert.fail("a client without elicitation must never be asked"),
      );
      assert.deepEqual(originated, []);
      // Two frames and only two: no readline prompt reached the transport.
      assert.equal(raw.length, 2, JSON.stringify(raw));
      result = structured(raw[1]);
    } finally {
      Object.defineProperty(process, "stdin", stdinDescriptor);
      if (previousStdoutTty === undefined) delete process.stdout.isTTY;
      else process.stdout.isTTY = previousStdoutTty;
      terminal.end();
    }
    // The preserved half: no readline prompt ever reached the transport, and
    // the human operator ledger was never written. The replaced half: the run
    // no longer stops, because AUTO is a principal and `auto` is the default.
    assert.equal(result.outcome, "CONTINUE");
    assert.doesNotMatch(result.log, /Challenge: APPROVE/);
    assert.equal(await decisionLedger(fixture), null);
  } finally {
    await fixture.cleanup();
  }
});

test("migration_run forwards repeated legacy sources and adoptTarget to the CLI", async () => {
  const fixture = await createFixture();
  try {
    await initialize(fixture);

    // The array reaches the CLI as repeated `--legacy` flags, so the record's
    // fixed source set is what refuses it -- not the MCP schema.
    const conflicting = structured(
      await only(
        fixture,
        call(1, "migration_run", {
          module: "auth",
          legacy: ["auth-ui", "auth-core"],
        }),
      ),
    );
    assert.equal(conflicting.outcome, "FAILED");
    assert.match(conflicting.reason, /conflict with the recorded sources/);
  } finally {
    await fixture.cleanup();
  }

  const fresh = await createFixture();
  try {
    const adopting = structured(
      await only(
        fresh,
        call(1, "migration_run", {
          module: "auth",
          adoptTarget: true,
          // First setup: nothing has persisted a binding for this fixture yet.
          registry: fresh.registryPath,
        }),
      ),
    );
    assert.equal(adopting.outcome, "BLOCKED");
    assert.match(adopting.reason, /'src\/features\/auth\/' does not exist/);
  } finally {
    await fresh.cleanup();
  }
});
