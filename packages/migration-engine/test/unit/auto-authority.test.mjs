// The AUTO principal's own regression suite. Every other suite pins what a
// *human* may do; this one pins what the engine may do on its own authority
// under `--mode auto`, and -- just as importantly -- what it still may not.
//
// The posture it encodes is recorded in `docs/auto-mode-autonomy.md` §5.2a:
// AUTO is a distinct trusted workflow principal, never a simulated human.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTO_DECISIONS_FILE,
  DECISIONS_FILE,
  isAutoAuthority,
} from "../../src/resumable-migration.mjs";
import { autoAdoptableToolkitTransition } from "../../src/toolkit-identity.mjs";
import { maySelfConfirm } from "../../src/migration-policy.mjs";
import { parseDiscoverArguments } from "../../src/cli/discover-module.mjs";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

/** Every `.mjs` under `src/`, so a new front end cannot escape the gate below. */
const sourceFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".mjs")) found.push(full);
  }
  return found;
};

test("AUTO is the default principal and `--mode step` is the only way out of it", () => {
  assert.equal(isAutoAuthority(undefined), true, "the default mode is auto");
  assert.equal(isAutoAuthority("auto"), true);
  assert.equal(isAutoAuthority("step"), false);
});

test("the AUTO ledger is a separate file from the human ledger", () => {
  assert.notEqual(AUTO_DECISIONS_FILE, DECISIONS_FILE);
  assert.match(DECISIONS_FILE, /operator-decisions\.ndjson$/);
  assert.match(AUTO_DECISIONS_FILE, /auto-decisions\.ndjson$/);
});

test("deterministic transitions self-confirm under auto and never under step", () => {
  // The transitions that used to be a per-flag denylist. Each is a function of
  // evidence the engine already holds, so AUTO decides them; `step` keeps the
  // human confirmation semantics byte-for-byte.
  const transitions = [
    { refresh: true },
    { reopenUi: true },
    { reopenComplete: true, preview: { state: "COMPLETE" } },
    { reworkSlice: "slice-a" },
    { adoptVisualContract: true },
    { amendSlice: "slice-a" },
    {},
  ];
  for (const transition of transitions) {
    const base = { command: "discover", preview: { state: "ACTIVE" }, ...transition };
    assert.equal(
      maySelfConfirm({ ...base, mode: "auto" }),
      true,
      `auto refused an internally decidable transition: ${JSON.stringify(transition)}`,
    );
    assert.equal(
      maySelfConfirm({ ...base, mode: "step" }),
      false,
      `step self-confirmed: ${JSON.stringify(transition)}`,
    );
  }
});

test("a bootstrap is AUTO's own decision and stays two-phase under step", () => {
  // NOT_STARTED used to be denied to every principal. It is derived from the
  // preview the engine just computed, so AUTO owns it; `step` still stops.
  const bootstrap = (mode) =>
    maySelfConfirm({ command: "discover", mode, preview: { state: "NOT_STARTED" } });
  assert.equal(bootstrap("auto"), true);
  assert.equal(bootstrap("step"), false);
});

test("the operator-only transitions are reachable under auto instead of throwing", () => {
  // These four used to throw out of argv parsing under `--mode auto`, which is
  // what made the unattended loop unable to reach them at all.
  const cases = [
    [["--refresh", "--confirm-mismatch"], "refresh", true],
    [["--rework-slice", "slice-a", "--confirm-rework"], "reworkSlice", "slice-a"],
  ];
  for (const [argv, field, expected] of cases) {
    const parsed = parseDiscoverArguments(["auth", ...argv, "--mode", "auto"]);
    assert.equal(parsed.mode, "auto");
    assert.equal(parsed[field], expected, argv.join(" "));
  }
});

test("toolkit identity: safe transitions auto-adopt, unsafe ones fail closed", () => {
  const pinned = {
    name: "artifact-migration-tools",
    version: "1.2.4",
    commit: "8b3f246f05f7",
    contentHash: "sha256:aaaa",
  };
  const newer = { ...pinned, version: "1.3.0", commit: "ffffffffffff", contentHash: "sha256:bbbb" };

  // Safe: an unstamped record, and a strictly newer release of the same toolkit.
  assert.ok(autoAdoptableToolkitTransition(null, pinned), "unstamped must auto-adopt");
  assert.ok(autoAdoptableToolkitTransition(pinned, newer), "an upgrade must auto-adopt");
  // Replay of the identical pin is not a transition to adopt.
  assert.ok(!autoAdoptableToolkitTransition(pinned, pinned));

  // Unsafe: a downgrade, a different toolkit, or the same version from
  // different bytes. Never approved around -- these stay BLOCKED.
  assert.ok(!autoAdoptableToolkitTransition(newer, pinned), "a downgrade must fail closed");
  assert.ok(
    !autoAdoptableToolkitTransition(pinned, { ...newer, name: "other-toolkit" }),
    "a different toolkit must fail closed",
  );
  assert.ok(
    !autoAdoptableToolkitTransition(pinned, { ...pinned, contentHash: "sha256:cccc" }),
    "the same version from different bytes must fail closed",
  );
  assert.ok(
    !autoAdoptableToolkitTransition(pinned, { ...pinned, commit: "0000deadbeef" }),
    "the same version from a different commit must fail closed",
  );
});

/**
 * The regression gate for §4.7 criterion 2. A pseudo-interactive prompt is a
 * line the process prints *after it has already exited* -- nobody can answer
 * it, so under the AUTO principal it is a hang, not a question. `--mode step`
 * front ends may still print one, and say so on the same line.
 */
test("no pseudo-interactive prompt is reachable under the AUTO principal", async () => {
  const offenders = [];
  for (const file of await sourceFiles(sourceRoot)) {
    const text = await readFile(file, "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (!/Reply Yes or No/.test(line)) continue;
      // Allowed only where the surrounding statement names `step` as the mode
      // that produced it, which is what makes the prompt answerable.
      offenders.push(`${path.relative(sourceRoot, file)}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `pseudo-interactive prose survives in:\n${offenders.join("\n")}`,
  );
});

test("the step-mode stop prose names the mode that caused it", async () => {
  for (const front of [
    "cli/discover-module.mjs",
    "cli/advance-migration.mjs",
    "cli/update-migration-registry.mjs",
  ]) {
    const text = await readFile(path.join(sourceRoot, front), "utf8");
    assert.match(
      text,
      /Mode: step — awaiting explicit confirmation\. No execution has started\./,
      front,
    );
  }
});
