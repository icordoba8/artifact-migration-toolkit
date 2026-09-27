import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withTestRoot } from "./test-isolation.mjs";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await withTestRoot(async (root) => {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      [path.join(source, "node_modules/vitest/vitest.mjs"), "run", ...process.argv.slice(2)],
      { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (status, signal) => resolve(signal ? 1 : status ?? 1));
  });
  if (code !== 0) process.exitCode = code;
});
