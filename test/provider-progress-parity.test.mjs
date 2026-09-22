import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
