import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

const providers = {
  claude: {
    entry: "providers/claude/skills/start-migration/SKILL.md",
    skill: "providers/claude/skills/start-migration/SKILL.md",
    mcp: "providers/claude/.mcp.json",
  },
  codex: {
    entry: "providers/codex/prompts/start-migration.md",
    skill: "providers/codex/skills/start-migration/SKILL.md",
    mcp: "providers/codex/config.toml",
  },
  copilot: {
    entry: "providers/copilot/prompts/start-migration.prompt.md",
    skill: "providers/copilot/skills/start-migration/SKILL.md",
    mcp: "providers/copilot/mcp.json",
  },
  opencode: {
    entry: "providers/opencode/commands/start-migration.md",
    skill: "providers/opencode/skills/start-migration/SKILL.md",
    mcp: "providers/opencode/opencode.fragment.json",
  },
};

test("every provider routes start-migration through the canonical progress contract", async () => {
  const canonical = await read("skills/start-migration/SKILL.md");
  const body = canonical.slice(canonical.indexOf("# Start Migration"));

  for (const [provider, paths] of Object.entries(providers)) {
    const [adapter, entry, skill, mcp] = await Promise.all([
      read(`providers/${provider}/adapter.json`).then(JSON.parse),
      read(paths.entry),
      read(paths.skill),
      read(paths.mcp),
    ]);

    assert.ok(adapter.skills.includes("start-migration"), `${provider} omits skill`);
    assert.equal(adapter.engine.mcpEntry, "{{ENGINE_MCP_ENTRY}}");
    assert.ok(adapter.files.includes(adapter.mcpTemplate), `${provider} omits MCP`);
    assert.ok(mcp.includes("start-migration"), `${provider} omits MCP server`);
    assert.ok(mcp.includes("{{ENGINE_MCP_ENTRY}}"), `${provider} forks engine`);
    assert.ok(skill.trimEnd().endsWith(body.trimEnd()), `${provider} diverges from canonical skill`);

    if (provider === "claude") {
      assert.match(entry, /^user-invocable: true$/m);
    } else {
      assert.match(entry, /Load and follow the `start-migration` skill/);
    }

    const prose = skill.replace(/\s+/g, " ");
    for (const rule of [
      "migration_status` returns `progress`",
      "migration_run` returns both on every outcome",
      "-> migration_status -> render canonical progress",
      "-> migration_run -> render canonical progress",
      "`progressChecklist` verbatim inside a fenced code block",
      "Never reformat, re-order, translate, summarize, add emoji to, or add percentages",
      "### Never author a migration plan",
    ]) {
      assert.ok(prose.includes(rule), `${provider} lost progress rule: ${rule}`);
    }
  }
});

/**
 * The execution contract every provider must receive identically. The progress
 * rules above are part of it; these are the rest, asserted by clause so a
 * provider cannot quietly lose one while still "matching the canonical skill".
 */
const CONTRACT = {
  "runtime preflight first":
    "## Runtime preflight Before migration status or any other migration work",
  "status first":
    "START -> STATUS FIRST",
  "absolute commands from ensure":
    "use the absolute commands in its JSON result",
  "prefer MCP when connected":
    "MCP — preferred whenever the `start-migration` MCP server is connected",
  "CLI fallback when MCP is unavailable or repaired in this process":
    "prefer MCP only while the `start-migration` server is actually connected, and use those absolute CLI commands as the fallback for the rest of this invocation when it is not",
  "progress after migration_status":
    "-> migration_status -> render canonical progress",
  "progress after migration_run":
    "-> migration_run -> render canonical progress",
  "progress on every CONTINUE iteration":
    "On every iteration, render canonical progress",
  "no percentages":
    "add percentages to either form",
  "no provider-authored migration plan":
    "### Never author a migration plan",
  "no provider-specific checkpoint interpretation":
    "Providers never decide checkpoint progression themselves",
  "canonical progress and transient activity are distinct":
    "**CURRENT ACTIVITY** is one transient line",
  "activity is never migration state":
    "never writes `state.json`, never implies completion",
  "activity before each bounded operation":
    "before each operation that does real work, print one CURRENT ACTIVITY line and invoke only bounded work",
  "long work yields instead of blocking":
    "start it in the background, return control, then poll with separate bounded calls",
  "polling cadence":
    "roughly a 5-10 second cadence",
  "routine continuation stays automatic":
    "polling a background operation is not a stop condition",
  "no fabricated live-progress guarantee":
    "never tell the operator that live progress is guaranteed",
};

test("every provider receives the same canonical execution contract", async () => {
  const canonical = (await read("skills/start-migration/SKILL.md")).replace(/\s+/g, " ");
  for (const [rule, clause] of Object.entries(CONTRACT)) {
    assert.ok(canonical.includes(clause), `canonical skill lost: ${rule}`);
  }
  for (const [provider, paths] of Object.entries(providers)) {
    const prose = (await read(paths.skill)).replace(/\s+/g, " ");
    for (const [rule, clause] of Object.entries(CONTRACT)) {
      assert.ok(prose.includes(clause), `${provider} lost contract rule: ${rule}`);
    }
    // The self-healing/reuse preflight is a runtime behavior, not a per-provider one.
    assert.ok(prose.includes("reported as `mcpRepair`"), `${provider} omits repair reporting`);
    assert.ok(
      prose.includes("reuses a verified runtime another provider already installed in this same consumer without network access"),
      `${provider} omits cross-provider offline reuse`,
    );
  }
});

/**
 * Live-progress capability is provider presentation, declared once per adapter.
 * Only Claude and OpenCode were observed holding the <=15s ceiling in a real
 * host; the other two execute the same contract best-effort and may not claim
 * it. The skill carries the matrix because adapter.json is not installed into
 * the consumer, so this pairs the two and fails if either side drifts.
 */
const LIVE_PROGRESS = {
  claude: { label: "Claude Code", mode: "cooperative-yield", guarantee: "proven" },
  opencode: { label: "OpenCode", mode: "cooperative-yield", guarantee: "proven" },
  codex: { label: "Codex", mode: "best-effort", guarantee: "not-proven" },
  copilot: { label: "GitHub Copilot", mode: "best-effort", guarantee: "not-proven" },
};

test("each adapter declares its live-progress capability and the skill matrix agrees", async () => {
  const skillLines = (await read("skills/start-migration/SKILL.md")).split("\n");

  for (const [provider, expected] of Object.entries(LIVE_PROGRESS)) {
    const adapter = JSON.parse(await read(`providers/${provider}/adapter.json`));
    assert.deepEqual(
      adapter.liveProgress,
      { mode: expected.mode, guarantee: expected.guarantee },
      `${provider} live-progress declaration drifted`,
    );
    // Presentation only: two keys, no checkpoint, slice, progress or state field.
    assert.deepEqual(Object.keys(adapter.liveProgress), ["mode", "guarantee"]);

    const row = skillLines.find((line) => line.startsWith(`| ${expected.label} `));
    assert.ok(row, `skill capability matrix has no row for ${provider}`);
    const cells = row.split("|").map((cell) => cell.trim());
    assert.equal(cells[2], expected.mode, `${provider} matrix mode disagrees with its adapter`);
    assert.equal(cells[3], expected.guarantee, `${provider} matrix guarantee disagrees with its adapter`);
  }
});

test("capability metadata cannot reach the engine's progress or state", async () => {
  const engineSrc = path.join(root, "packages/migration-engine/src");
  for (const entry of await readdir(engineSrc, { recursive: true })) {
    if (!entry.endsWith(".mjs")) continue;
    const source = await readFile(path.join(engineSrc, entry), "utf8");
    assert.ok(
      !source.includes("liveProgress") && !source.includes("CURRENT ACTIVITY"),
      `engine reads provider presentation metadata: ${entry}`,
    );
  }
});
