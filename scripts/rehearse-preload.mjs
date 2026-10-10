// `pnpm rehearse` preload (`--import`, inherited by every child through
// NODE_OPTIONS). Fixes the clock and randomUUID so a replay writes the same
// record bytes every time: digests match because their inputs are fixed, not
// because anything is masked afterwards. Only scripts/rehearse.mjs loads this.
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// ponytail: one constant instant, not a ticking clock. Every freshness check the
// lifecycle reaches is non-strict (`producedAt < freshSince` fails, equal
// passes); a fixture that hits a strict-order check needs a logical clock.
const FIXED = Date.parse("2026-01-01T00:00:00.000Z");
const RealDate = Date;
globalThis.Date = class Date extends RealDate {
  constructor(...args) { super(...(args.length > 0 ? args : [FIXED])); }
  static now() { return FIXED; }
};

// Per-process counter. Children run one at a time, so names never collide.
let uuids = 0;
const randomUUID = () => `00000000-0000-4000-8000-${(++uuids).toString(16).padStart(12, "0")}`;
crypto.randomUUID = randomUUID;
globalThis.crypto.randomUUID = randomUUID;
// mkdtemp with a counter suffix: the engine writes absolute legacy/target roots
// into digested step documents, so the scratch path has to be fixed too.
let temps = 0;
fs.mkdtempSync = (prefix) => {
  for (;;) {
    const directory = `${prefix}${String(++temps).padStart(6, "0")}`;
    try {
      fs.mkdirSync(directory, 0o700);
      return directory;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
};
fs.promises.mkdtemp = async (prefix) => fs.mkdtempSync(prefix);
fs.mkdtemp = (prefix, options, callback = options) => {
  try {
    const directory = fs.mkdtempSync(prefix);
    process.nextTick(callback, null, directory);
  } catch (error) {
    process.nextTick(callback, error);
  }
};
// The engine imports `randomUUID` and `mkdtemp` as named ESM bindings; this
// re-points them.
syncBuiltinESMExports();
