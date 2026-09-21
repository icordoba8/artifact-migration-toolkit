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
