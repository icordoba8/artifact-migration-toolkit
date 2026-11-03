// E6 against a real Codex rollout: one MCP call to a release-installed engine
// whose registry binding names a missing file. The refusal must reach the
// model as an isError tool result whose structuredContent carries the code.
// Usage (from the repository root): node <this file> <scratch dir>  (prints the codex argv; run it in a shell)
import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { buildRelease } from "../../../../scripts/release.mjs";
import { candidateReleaseRoot } from "../../../../packages/migration-engine/test/support/candidate-release-root.mjs";

const scratch = path.resolve(process.argv[2]);
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });
const built = await buildRelease({ root: await candidateReleaseRoot(scratch, { version: "1.3.1" }), force: true });
const root = path.join(scratch, "consumer");
await mkdir(root, { recursive: true });
await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "e6", private: true, config: { startMigration: { registry: "missing/registry.json" } } }));
execFileSync("git", ["init", "-q"], { cwd: root });
const server = path.join(built.stagingRoot, "packages/migration-engine/src/mcp-server.mjs");
console.log(JSON.stringify({ root, server }));
