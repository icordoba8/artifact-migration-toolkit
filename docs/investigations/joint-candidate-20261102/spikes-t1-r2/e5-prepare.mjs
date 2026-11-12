// S-E5 step 1 (outside any sandbox): a format-19 module at OPERATOR_DECISION, and the
// reference the agent under test receives from migration_run (one of its 9 granted tools).
// Run with TMPDIR set so the fixture lands outside /tmp. Prints {root, reference}.
const engine = process.argv[2];
const { createSession, handleMessage } = await import(`${engine}/src/mcp-server.mjs`);
const { createFixture, atDirectLedgerCompleteness, EXCLUDED_CLASSIFICATION } =
  await import(`${engine}/test/integration/approval.fixture.mjs`);
const fixture = await createFixture();
await atDirectLedgerCompleteness(fixture, EXCLUDED_CLASSIFICATION);
const reply = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call",
  params: { name: "migration_run", arguments: { module: "auth", cwd: fixture.root, mode: "auto" } } }, createSession());
const run = JSON.parse(reply.result.content.at(-1).text);
console.log(JSON.stringify({ root: fixture.root, outcome: run.outcome,
  requiredPrincipal: run.operatorApproval?.review?.policy?.requiredPrincipal, reference: run.operatorApproval?.reference }));
