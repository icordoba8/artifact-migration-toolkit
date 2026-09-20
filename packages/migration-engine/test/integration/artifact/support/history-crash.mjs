// Process death at the filesystem boundary; no production logic is mocked.
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
// `engineUrl` lets the external Format-17 acceptance point this same driver at
// the *installed* toolkit instead of this checkout. Defaulting to the checkout
// keeps every in-process caller unchanged.
const [optionsJson, phase = "NONE", engineUrl] = process.argv.slice(2);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ["2026-09-06T12:00:00.000Z"])); }
};
const crash = () => process.exit(86);
const isHistory = (file) => path.basename(String(file)) === "history.ndjson"
  || path.basename(String(file)).startsWith(".history.ndjson.");
const originalOpen = fs.open;
fs.open = async (file, ...args) => {
  const name = path.basename(String(file));
  const authority = ["state.json", "integrity.json", "transaction.json", "history.ndjson"]
    .some((base) => name === base || name.startsWith(`.${base}.`));
  if (phase === "DENY_MUTATION" && authority) process.exit(87);
  if (phase === "RECOVERY_AFTER_HISTORY" && name.startsWith(".state.json.")) crash();
  if (!isHistory(file)) return originalOpen(file, ...args);
  if (phase === "BEFORE_OPEN") crash();
  const handle = await originalOpen(file, ...args);
  if (phase === "AFTER_OPEN") crash();
  const write = handle.writeFile.bind(handle);
  handle.writeFile = async (content, ...writeArgs) => {
    if (phase.startsWith("PARTIAL_")) {
      const bytes = Buffer.from(content);
      const count = phase === "PARTIAL_ONE" ? 1
        : phase === "PARTIAL_HALF" ? Math.floor(bytes.length / 2) : bytes.length - 1;
      await write(bytes.subarray(0, count));
      await handle.sync();
      crash();
    }
    await write(content, ...writeArgs);
    if (phase === "AFTER_WRITE") crash();
  };
  const sync = handle.sync.bind(handle);
  handle.sync = async () => {
    await sync();
    if (phase === "AFTER_SYNC") crash();
  };
  return handle;
};
const originalRename = fs.rename;
fs.rename = async (from, to) => {
  if (isHistory(to) && phase === "BEFORE_RENAME") crash();
  await originalRename(from, to);
  if (isHistory(to) && phase === "AFTER_RENAME") crash();
};
syncBuiltinESMExports();
const { runArtifact } = await import(
  engineUrl ?? new URL("../../../../src/artifact/artifact-migration.mjs", import.meta.url).href
);
process.stdout.write(JSON.stringify(await runArtifact(JSON.parse(optionsJson))));
