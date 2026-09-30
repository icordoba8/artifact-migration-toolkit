import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linkPackageDependencies } from "../packages/migration-engine/test/support/dependency-links.mjs";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const withTestRoot = async (run) => {
  const root = await mkdtemp(path.join(os.tmpdir(),
    `migration-tests-${process.env.AMT_TEST_ROOT_TAG ?? ""}`));
  try {
    await cp(source, root, {
      recursive: true,
      filter: (entry) => {
        const relative = path.relative(source, entry).split(path.sep);
        return !relative.some((part) => [".git", "dist", "node_modules"].includes(part)) &&
          !(/^packages\/[^/]+\/build-identity\.json$/.test(relative.join("/")));
      },
    });
    await linkPackageDependencies(root, "");
    await linkPackageDependencies(root, "packages/migration-engine");
    for (const args of [["init", "-q"], ["add", "-A"],
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test snapshot"]]) {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`scratch git ${args[0]}: ${result.stderr}`);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
