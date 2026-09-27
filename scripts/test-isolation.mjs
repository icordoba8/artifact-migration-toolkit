import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const withTestRoot = async (run) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-tests-"));
  try {
    await cp(source, root, {
      recursive: true,
      filter: (entry) => {
        const relative = path.relative(source, entry).split(path.sep);
        return !relative.some((part) => [".git", "dist", "node_modules"].includes(part)) &&
          !(/^packages\/[^/]+\/build-identity\.json$/.test(relative.join("/")));
      },
    });
    await symlink(path.join(source, "node_modules"), path.join(root, "node_modules"), "junction");
    await symlink(path.join(source, "packages/migration-engine/node_modules"),
      path.join(root, "packages/migration-engine/node_modules"), "junction");
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
