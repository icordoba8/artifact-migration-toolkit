// @vitest-environment node
//
// P1 #4: the authoritative artifact journal/recovery contract. Exercises the
// real production writer (bootstrap and advance through migrate-artifact's
// actual checkpoints) against real filesystem crash-window reconstructions and
// forged-but-self-consistent transactions, through the production entrypoints
// (`runArtifact`, `getArtifactStatus`) only -- no private function is exposed
// just to unit-test duplicated logic.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- untyped production JS module, consumed directly for real behavior.
import { getArtifactStatus, previewArtifact, previewArtifactFormatUpgrade, runArtifact, upgradeArtifactFormat } from "../../../src/artifact/artifact-migration.mjs";

import {
  advanceAssessment,
  advanceBaseline,
  advanceDiscovery,
  advanceImplementation,
  authorSource,
  bootstrap,
  createFixture,
  driveToBuild,
  exists,
  FIXTURE_CENSUS,
  type Fixture,
  stateOf,
  writeJson,
} from "./support/fixtures";

type Snapshot = Record<string, string | null>;

const RECORD_FILES = ["state.json", "integrity.json", "history/history.ndjson", "transaction.json"];

const readMaybe = async (file: string): Promise<string | null> =>
  readFile(file, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });

const snapshot = async (fixture: Fixture): Promise<Snapshot> => {
  const entries: Snapshot = {};
  for (const relative of RECORD_FILES) entries[relative] = await readMaybe(path.join(fixture.artifactRoot, relative));
  return entries;
};

const restore = async (fixture: Fixture, snap: Snapshot) => {
  for (const relative of RECORD_FILES) {
    const file = path.join(fixture.artifactRoot, relative);
    const content = snap[relative];
    if (content === null || content === undefined) {
      await rm(file, { force: true });
    } else {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
  }
};

const readJson = (snap: Snapshot, relative: string) => (snap[relative] === null ? null : JSON.parse(snap[relative] as string));

const historyEvents = (content: string | null) =>
  (content ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const fixtures: Fixture[] = [];
const tracked = async (): Promise<Fixture> => {
  const fixture = await createFixture();
  fixtures.push(fixture);
  return fixture;
};
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

// Captures the transaction a real production run would have journaled for one
// checkpoint advance: pre/post snapshots of the same real writer's output, not
// a hand-built transition model. `previousState`/`previousIntegrity` are
// `null` when the action is a bootstrap (nothing existed beforehand).
const captureTransaction = async (
  fixture: Fixture,
  action: () => Promise<unknown>,
  input: { kind: "BOOTSTRAP" | "ADVANCE" | "FORMAT_UPGRADE"; selectedSlice?: string | null; confirmationId?: string; artifactType?: string; source?: unknown; target?: unknown },
) => {
  const pre = await snapshot(fixture);
  await action();
  const post = await snapshot(fixture);
  const previousState = readJson(pre, "state.json");
  const previousIntegrity = readJson(pre, "integrity.json");
  const state = readJson(post, "state.json");
  const preCount = historyEvents(pre["history/history.ndjson"]).length;
  const event = historyEvents(post["history/history.ndjson"])[preCount];
  const resolvedInput =
    input.kind === "BOOTSTRAP"
      ? {
        kind: "BOOTSTRAP" as const, artifactType: state.artifactType, source: state.source, target: state.target,
        ...(state.formatVersion === 14 ? { pilotFormat: 14 } : {})
      }
      : input.kind === "FORMAT_UPGRADE"
        ? { kind: "FORMAT_UPGRADE" as const, from: 13, to: 14, confirmationId: input.confirmationId }
        : { kind: "ADVANCE" as const, selectedSlice: input.selectedSlice ?? null };
  const transaction = { version: 2, previousState, previousIntegrity, input: resolvedInput, state, event };
  return { pre, post, transaction };
};

type Phase = "JOURNAL_ONLY" | "HISTORY_APPENDED" | "STATE_REPLACED" | "INTEGRITY_REPLACED";

// The crash-window table: which of {state, integrity, history} still show the
// previous value vs. the proposed one at each durable boundary between journal
// publication and journal removal.
const applyPhase = async (fixture: Fixture, pre: Snapshot, post: Snapshot, phase: Phase, transaction: unknown) => {
  const snap: Snapshot = {
    "state.json": phase === "JOURNAL_ONLY" || phase === "HISTORY_APPENDED" ? pre["state.json"] : post["state.json"],
    "integrity.json": phase === "INTEGRITY_REPLACED" ? post["integrity.json"] : pre["integrity.json"],
    "history/history.ndjson": phase === "JOURNAL_ONLY" ? pre["history/history.ndjson"] : post["history/history.ndjson"],
    "transaction.json": `${JSON.stringify(transaction, null, 2)}\n`,
  };
  await restore(fixture, snap);
};

// Reproduces production's canonicalization/digest exactly enough to build
// self-consistent forged events -- verified against a real captured digest
// below before it is trusted for any forgery case.
const localCanonical = (value: unknown): string =>
  JSON.stringify(
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, JSON.parse(localCanonical(child))]),
      )
      : Array.isArray(value)
        ? value.map((child) => JSON.parse(localCanonical(child)))
        : value,
  );
const localSha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const rehashEvent = (event: Record<string, unknown>) => {
  const { digest: _digest, ...body } = event;
  return { ...body, digest: localSha256(localCanonical(body)) };
};

const PHASES: Phase[] = ["JOURNAL_ONLY", "HISTORY_APPENDED", "STATE_REPLACED", "INTEGRITY_REPLACED"];

describe("shared production canonicalization (forgery-test sanity check)", () => {
  it("locally reproduces a real captured event digest byte for byte", async () => {
    const fixture = await tracked();
    await bootstrap(fixture);
    const [event] = historyEvents(await readMaybe(path.join(fixture.artifactRoot, "history/history.ndjson")));
    expect(rehashEvent(event)).toEqual(event);
  });
});

describe("normal execution establishes the transition proof exactly once", () => {
  it("a bootstrap commits with previewAdvance called zero times (bootstrap has no checkpoint to preview)", async () => {
    const fixture = await tracked();
    const result = await bootstrap(fixture);
    expect(result.metrics.previewAdvanceCalls).toBe(0);
    expect(await exists(path.join(fixture.artifactRoot, "transaction.json"))).toBe(false);
  });

  it("a normal advance calls previewAdvance exactly once before committing", async () => {
    const fixture = await tracked();
    await bootstrap(fixture);
    await authorSource(fixture);
    const result = await runArtifact(fixture.options);
    expect(result.outcome).toBe("CONTINUE");
    expect(result.metrics.previewAdvanceCalls).toBe(1);
    expect((await stateOf(fixture)).currentStep).toBe("DISCOVERY_COMPLETENESS");
  });

  it("--status never calls previewAdvance, even when a healthy pending journal exists", async () => {
    const fixture = await tracked();
    const { pre, post, transaction } = await captureTransaction(fixture, () => bootstrap(fixture), { kind: "BOOTSTRAP" });
    await applyPhase(fixture, pre, post, "JOURNAL_ONLY", transaction);
    const status = await getArtifactStatus(fixture.options);
    expect(status.status).toBe("ACTIVE");
    expect(status.metrics.previewAdvanceCalls).toBe(0);
  });
});

describe("crash windows: bootstrap", () => {
  for (const phase of PHASES) {
    it(`recovers a bootstrap interrupted at ${phase}, producing the exact same record`, async () => {
      const fixture = await tracked();
      const { pre, post, transaction } = await captureTransaction(fixture, () => bootstrap(fixture), { kind: "BOOTSTRAP" });
      await applyPhase(fixture, pre, post, phase, transaction);

      const status = await getArtifactStatus(fixture.options);
      expect(status.status).toBe("ACTIVE");
      expect(status.outcome).toBe("CONTINUE");

      const result = await runArtifact(fixture.options);
      expect(result.outcome).toBe("CONTINUE");
      expect(await exists(path.join(fixture.artifactRoot, "transaction.json"))).toBe(false);
      const finalSnapshot = await snapshot(fixture);
      expect(readJson(finalSnapshot, "state.json")).toEqual(readJson(post, "state.json"));
      expect(readJson(finalSnapshot, "integrity.json")).toEqual(readJson(post, "integrity.json"));
      expect(finalSnapshot["history/history.ndjson"]).toBe(post["history/history.ndjson"]);

      // Idempotent repeat: recovering an already-fully-applied record changes nothing further.
      const again = await runArtifact(fixture.options);
      expect(again.outcome).not.toBe("BLOCKED");
      const repeatSnapshot = await snapshot(fixture);
      expect(repeatSnapshot["history/history.ndjson"]).toBe(post["history/history.ndjson"]);
    });
  }
});

describe("crash windows: explicit pilot bootstrap", () => {
  for (const phase of PHASES) {
    it(`replays a confirmed format-14 bootstrap once after ${phase}`, async () => {
      const fixture = await tracked();
      const options = { ...fixture.options, pilotFormat: 14 };
      const preview = await previewArtifact(options);
      const { pre, post, transaction } = await captureTransaction(
        fixture,
        () => runArtifact({ ...options, confirmationId: preview.confirmationId }),
        { kind: "BOOTSTRAP" },
      );
      await applyPhase(fixture, pre, post, phase, transaction);
      expect((await runArtifact(fixture.options)).outcome).toBe("CONTINUE");
      expect((await stateOf(fixture)).formatVersion).toBe(14);
      expect(await snapshot(fixture)).toEqual(post);
    });
  }

  it("refuses a format-14 bootstrap journal with no pilot selection", async () => {
    const fixture = await tracked();
    const options = { ...fixture.options, pilotFormat: 14 };
    const preview = await previewArtifact(options);
    const { pre, post, transaction } = await captureTransaction(
      fixture,
      () => runArtifact({ ...options, confirmationId: preview.confirmationId }),
      { kind: "BOOTSTRAP" },
    );
    const { pilotFormat: _pilotFormat, ...input } = transaction.input as Record<string, unknown>;
    await applyPhase(fixture, pre, post, "JOURNAL_ONLY", { ...transaction, input });
    const before = await snapshot(fixture);
    expect((await runArtifact(fixture.options)).outcome).toBe("BLOCKED");
    expect(await snapshot(fixture)).toEqual(before);
  });
});

describe("crash windows: advance", () => {
  for (const phase of PHASES) {
    it(`recovers an advance interrupted at ${phase}, producing the exact same record`, async () => {
      const fixture = await tracked();
      await bootstrap(fixture);
      await authorSource(fixture);
      const { pre, post, transaction } = await captureTransaction(fixture, () => runArtifact(fixture.options), {
        kind: "ADVANCE",
        selectedSlice: null,
      });
      await applyPhase(fixture, pre, post, phase, transaction);

      const status = await getArtifactStatus(fixture.options);
      expect(status.status).toBe("ACTIVE");

      const result = await runArtifact(fixture.options);
      expect(result.outcome).toBe("CONTINUE");
      expect(await exists(path.join(fixture.artifactRoot, "transaction.json"))).toBe(false);
      const finalSnapshot = await snapshot(fixture);
      expect(readJson(finalSnapshot, "state.json")).toEqual(readJson(post, "state.json"));
      expect(readJson(finalSnapshot, "integrity.json")).toEqual(readJson(post, "integrity.json"));
      expect(finalSnapshot["history/history.ndjson"]).toBe(post["history/history.ndjson"]);
    });
  }
});

describe("crash windows: explicit pristine 13 -> 14 upgrade", () => {
  for (const phase of PHASES) {
    it(`replays the exact format upgrade once after ${phase}`, async () => {
      const fixture = await tracked();
      await bootstrap(fixture);
      const { confirmationId } = await previewArtifactFormatUpgrade(fixture.options);
      const { pre, post, transaction } = await captureTransaction(
        fixture,
        () => upgradeArtifactFormat({ ...fixture.options, confirmationId }),
        { kind: "FORMAT_UPGRADE", confirmationId },
      );
      await applyPhase(fixture, pre, post, phase, transaction);
      expect((await getArtifactStatus(fixture.options)).outcome).toBe("CONTINUE");
      const result = await runArtifact(fixture.options);
      expect(result.outcome).toBe("CONTINUE");
      expect((await stateOf(fixture)).formatVersion).toBe(14);
      expect(await snapshot(fixture)).toEqual(post);
      await runArtifact(fixture.options);
      expect(await snapshot(fixture)).toEqual(post);
    });
  }

  it("refuses a forged confirmation journal without changing any record bytes", async () => {
    const fixture = await tracked();
    await bootstrap(fixture);
    const { confirmationId } = await previewArtifactFormatUpgrade(fixture.options);
    const { pre, post, transaction } = await captureTransaction(
      fixture,
      () => upgradeArtifactFormat({ ...fixture.options, confirmationId }),
      { kind: "FORMAT_UPGRADE", confirmationId },
    );
    await applyPhase(fixture, pre, post, "JOURNAL_ONLY", {
      ...transaction,
      input: { kind: "FORMAT_UPGRADE", from: 13, to: 14, confirmationId: "forged" },
    });
    const before = await snapshot(fixture);
    const status = await getArtifactStatus(fixture.options);
    expect(status.outcome).toBe("BLOCKED");
    expect(status.reason).toMatch(/format upgrade does not match its pristine preimage/);
    expect(await snapshot(fixture)).toEqual(before);
    expect((await runArtifact(fixture.options)).outcome).toBe("BLOCKED");
    expect(await snapshot(fixture)).toEqual(before);
  });
});

describe("PLAN slice selection recovers unambiguously", () => {
  it("recovers a default (first) slice selection interrupted mid-commit", async () => {
    const fixture = await tracked();
    await driveToBuild(fixture, "TARGET_EXTEND");
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await writeJson(fixture.artifactRoot, "slices/index.json", {
      version: 1,
      slices: [{ id: "slice-1", behaviorIds: ["B-1"], dependsOn: [], kind: "EXTEND" }],
    });
    const { pre, post, transaction } = await captureTransaction(fixture, () => runArtifact(fixture.options), {
      kind: "ADVANCE",
      selectedSlice: null,
    });
    expect((transaction.state as { activeSlice: string }).activeSlice).toBe("slice-1");
    await applyPhase(fixture, pre, post, "JOURNAL_ONLY", transaction);
    const result = await runArtifact(fixture.options);
    expect(result.outcome).toBe("CONTINUE");
    expect((await stateOf(fixture)).activeSlice).toBe("slice-1");
  });

  it("recovers an explicit slice selection interrupted mid-commit", async () => {
    const fixture = await tracked();
    await driveToBuild(fixture, "TARGET_EXTEND");
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await writeJson(fixture.artifactRoot, "slices/index.json", {
      version: 1,
      slices: [{ id: "slice-1", behaviorIds: ["B-1"], dependsOn: [], kind: "EXTEND" }],
    });
    const { pre, post, transaction } = await captureTransaction(fixture, () => runArtifact({ ...fixture.options, slice: "slice-1" }), {
      kind: "ADVANCE",
      selectedSlice: "slice-1",
    });
    await applyPhase(fixture, pre, post, "JOURNAL_ONLY", transaction);
    const result = await runArtifact(fixture.options);
    expect(result.outcome).toBe("CONTINUE");
    expect((await stateOf(fixture)).activeSlice).toBe("slice-1");
  });
});

describe("VERIFY_SLICES and FINALIZE recover through the same reproof", () => {
  it("recovers an IMPLEMENT_SLICES -> VERIFY_SLICES advance interrupted mid-commit", async () => {
    const fixture = await tracked();
    await driveToBuild(fixture, "TARGET_EXTEND");
    await advanceBaseline(fixture, "TARGET_EXTEND");
    await writeJson(fixture.artifactRoot, "slices/index.json", {
      version: 1,
      slices: [{ id: "slice-1", behaviorIds: ["B-1"], dependsOn: [], kind: "EXTEND" }],
    });
    await runArtifact(fixture.options);
    const { pre, post, transaction } = await captureTransaction(fixture, () => advanceImplementation(fixture, "TARGET_EXTEND"), {
      kind: "ADVANCE",
      selectedSlice: null,
    });
    await applyPhase(fixture, pre, post, "HISTORY_APPENDED", transaction);
    const result = await runArtifact(fixture.options);
    expect(result.outcome).toBe("CONTINUE");
    expect((await stateOf(fixture)).currentStep).toBe("VERIFY_SLICES");
  }, 15_000); // Drives the record through BUILD first; 6.1s observed on Windows CI.
});

describe("forged (but internally self-consistent) transactions fail production replay", () => {
  const capturedAdvance = async (fixture: Fixture) => {
    await bootstrap(fixture);
    await authorSource(fixture);
    return captureTransaction(fixture, () => runArtifact(fixture.options), { kind: "ADVANCE", selectedSlice: null });
  };

  it("a fully rehashed forged previousState is still refused by an independent replay", async () => {
    const fixture = await tracked();
    const { pre, post, transaction } = await capturedAdvance(fixture);
    const forgedPreviousState = { ...(transaction.previousState as Record<string, unknown>), currentStep: "ASSESS_TARGET" };
    const forgedPreviousIntegrity = {
      ...(transaction.previousIntegrity as Record<string, unknown>),
      stateSha256: localSha256(`${JSON.stringify(forgedPreviousState, null, 2)}\n`),
    };
    const forged = { ...transaction, previousState: forgedPreviousState, previousIntegrity: forgedPreviousIntegrity };
    await applyPhase(fixture, pre, post, "JOURNAL_ONLY", forged);

    const beforeRun = await snapshot(fixture);
    const result = await runArtifact(fixture.options);
    expect(result.outcome).toBe("BLOCKED");
    expect(await snapshot(fixture)).toEqual(beforeRun);
  });

  it("a rehashed forged proposed state (wrong revision) is refused despite matching its own event", async () => {
    const fixture = await tracked();
    const { pre, post, transaction } = await capturedAdvance(fixture);
    const forgedState = { ...(transaction.state as Record<string, unknown>), revision: 99 };
    const forgedEvent = rehashEvent({ ...(transaction.event as Record<string, unknown>), revision: 99 });
    const forged = { ...transaction, state: forgedState, event: forgedEvent };
    await applyPhase(fixture, pre, post, "JOURNAL_ONLY", forged);

    const beforeRun = await snapshot(fixture);
    const result = await runArtifact(fixture.options);
    expect(result.outcome).toBe("BLOCKED");
    expect(await snapshot(fixture)).toEqual(beforeRun);
  });

  it("a forged event.to that disagrees with the proposed state's currentStep is refused", async () => {
    const fixture = await tracked();
    const { pre, post, transaction } = await capturedAdvance(fixture);
    const forgedEvent = rehashEvent({ ...(transaction.event as Record<string, unknown>), to: "ASSESS_TARGET" });
    const forged = { ...transaction, event: forgedEvent };
    await applyPhase(fixture, pre, post, "JOURNAL_ONLY", forged);
    const result = await runArtifact(fixture.options);
    expect(result.outcome).toBe("BLOCKED");
  });

  it("a forged input.selectedSlice naming an inactive slice is refused before any mutation", async () => {
    const fixture = await tracked();
    const { pre, post, transaction } = await capturedAdvance(fixture);
    const forged = { ...transaction, input: { kind: "ADVANCE", selectedSlice: "no-such-slice" } };
    await applyPhase(fixture, pre, post, "JOURNAL_ONLY", forged);
    const beforeRun = await snapshot(fixture);
    const result = await runArtifact(fixture.options);
    expect(result.outcome).toBe("BLOCKED");
    expect(await snapshot(fixture)).toEqual(beforeRun);
  });

  it("a checkpoint that is not yet authored cannot be reproved as CONTINUE (ready:false is insufficient)", async () => {
    const fixture = await tracked();
    const { pre, post, transaction } = await capturedAdvance(fixture);
    // The captured transaction advances FROM DISCOVER_LEGACY, whose checkpoint
    // requires inventories/source.json; remove it so previewAdvance's reproof
    // sees the checkpoint as not actually ready, and try to recover the commit.
    await rm(path.join(fixture.artifactRoot, "inventories/source.json"), { force: true });
    await applyPhase(fixture, pre, post, "JOURNAL_ONLY", transaction);
    const result = await runArtifact(fixture.options);
    expect(result.outcome).toBe("BLOCKED");
  });

  it("a previousIntegrity with a forged history-event count is refused", async () => {
    const fixture = await tracked();
    const { pre, post, transaction } = await capturedAdvance(fixture);
    const forgedPreviousIntegrity = { ...(transaction.previousIntegrity as Record<string, unknown>), historyEvents: 0 };
    const forged = { ...transaction, previousIntegrity: forgedPreviousIntegrity };
    await applyPhase(fixture, pre, post, "JOURNAL_ONLY", forged);
    const result = await runArtifact(fixture.options);
    expect(result.outcome).toBe("BLOCKED");
  });

  it("an unknown transaction version fails closed", async () => {
    const fixture = await tracked();
    const { pre, post, transaction } = await capturedAdvance(fixture);
    const forged = { ...transaction, version: 3 };
    await applyPhase(fixture, pre, post, "JOURNAL_ONLY", forged);
    const status = await getArtifactStatus(fixture.options);
    expect(status.status).toBe("BLOCKED");
    const result = await runArtifact(fixture.options);
    expect(result.outcome).toBe("BLOCKED");
  });

  it("an unknown key in the transaction envelope is refused", async () => {
    const fixture = await tracked();
    const { pre, post, transaction } = await capturedAdvance(fixture);
    const forged = { ...transaction, extraneous: true };
    await applyPhase(fixture, pre, post, "JOURNAL_ONLY", forged);
    const status = await getArtifactStatus(fixture.options);
    expect(status.status).toBe("BLOCKED");
  });
});

describe("history and integrity corruption fails closed without mutation", () => {
  const capturedAdvance = async (fixture: Fixture) => {
    await bootstrap(fixture);
    await authorSource(fixture);
    return captureTransaction(fixture, () => runArtifact(fixture.options), { kind: "ADVANCE", selectedSlice: null });
  };

  it("a truncated history file is refused", async () => {
    const fixture = await tracked();
    const { pre, post, transaction } = await capturedAdvance(fixture);
    await applyPhase(fixture, pre, post, "HISTORY_APPENDED", transaction);
    const history = (await readMaybe(path.join(fixture.artifactRoot, "history/history.ndjson")))!;
    await writeFile(path.join(fixture.artifactRoot, "history/history.ndjson"), history.slice(0, Math.floor(history.length / 2)));
    const result = await runArtifact(fixture.options);
    expect(result.outcome).toBe("BLOCKED");
  });

  it("a rehashed but reordered history is refused", async () => {
    const fixture = await tracked();
    const { pre, post, transaction } = await capturedAdvance(fixture);
    await applyPhase(fixture, pre, post, "HISTORY_APPENDED", transaction);
    const events = historyEvents(await readMaybe(path.join(fixture.artifactRoot, "history/history.ndjson")));
    // Two real events exist by now (BOOTSTRAPPED, ADVANCED); swap and relink
    // prevDigest/seq so the chain is self-consistent but out of order.
    if (events.length >= 2) {
      const [first, second] = events;
      const reorderedFirst = rehashEvent({ ...second, seq: 1, prevDigest: null });
      const reorderedSecond = rehashEvent({ ...first, seq: 2, prevDigest: reorderedFirst.digest });
      await writeFile(
        path.join(fixture.artifactRoot, "history/history.ndjson"),
        `${[reorderedFirst, reorderedSecond].map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
      const result = await runArtifact(fixture.options);
      expect(result.outcome).toBe("BLOCKED");
    }
  });

  it("a corrupted integrity.json is refused by recovery (status stays shallow and still reports ACTIVE)", async () => {
    const fixture = await tracked();
    const { pre, post, transaction } = await capturedAdvance(fixture);
    await applyPhase(fixture, pre, post, "INTEGRITY_REPLACED", transaction);
    const integrity = JSON.parse((await readMaybe(path.join(fixture.artifactRoot, "integrity.json")))!);
    await writeFile(
      path.join(fixture.artifactRoot, "integrity.json"),
      `${JSON.stringify({ ...integrity, historyBytes: integrity.historyBytes + 1 }, null, 2)}\n`,
    );
    // --status never inspects integrity.json when a journal is pending -- that
    // is unchanged, intentional behavior, not a gap. Recovery is where the
    // actual bytes on disk are checked before anything is overwritten.
    const status = await getArtifactStatus(fixture.options);
    expect(status.status).toBe("ACTIVE");
    const before = await snapshot(fixture);
    const result = await runArtifact(fixture.options);
    expect(result.outcome).toBe("BLOCKED");
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("a missing integrity.json at the INTEGRITY_REPLACED phase is refused by recovery, not silently repaired", async () => {
    const fixture = await tracked();
    const { pre, post, transaction } = await capturedAdvance(fixture);
    await applyPhase(fixture, pre, post, "INTEGRITY_REPLACED", transaction);
    await rm(path.join(fixture.artifactRoot, "integrity.json"), { force: true });
    const result = await runArtifact(fixture.options);
    expect(result.outcome).toBe("BLOCKED");
    expect(await exists(path.join(fixture.artifactRoot, "integrity.json"))).toBe(false);
  });
});

describe("cross-record and stale journals are refused before any mutation", () => {
  it("a transaction.json copied from a different artifact's record is refused before it can overwrite this one", async () => {
    const fixtureA = await tracked();
    const fixtureB = await tracked();
    await bootstrap(fixtureA);
    await authorSource(fixtureA);
    const { pre, post, transaction } = await captureTransaction(fixtureA, () => runArtifact(fixtureA.options), {
      kind: "ADVANCE",
      selectedSlice: null,
    });
    await applyPhase(fixtureA, pre, post, "JOURNAL_ONLY", transaction);
    // fixtureA's genuine, self-consistent transaction now sits in fixtureB's record directory.
    await bootstrap(fixtureB);
    const beforeB = await snapshot(fixtureB);
    await writeFile(path.join(fixtureB.artifactRoot, "transaction.json"), `${JSON.stringify(transaction, null, 2)}\n`);
    const result = await runArtifact(fixtureB.options);
    expect(result.outcome).toBe("BLOCKED");
    const afterB = await snapshot(fixtureB);
    expect(afterB["state.json"]).toEqual(beforeB["state.json"]);
    expect(afterB["history/history.ndjson"]).toEqual(beforeB["history/history.ndjson"]);
  });

  it("a stale journal whose event already sits earlier in a longer history is refused, not treated as already applied", async () => {
    const fixture = await tracked();
    await bootstrap(fixture);
    await authorSource(fixture);
    const { transaction } = await captureTransaction(fixture, () => runArtifact(fixture.options), {
      kind: "ADVANCE",
      selectedSlice: null,
    });
    expect((await stateOf(fixture)).currentStep).toBe("DISCOVERY_COMPLETENESS");

    // Genuinely advance one more real checkpoint past the captured transaction,
    // so its recorded prefix no longer reaches the current history tip.
    const state = await stateOf(fixture);
    await writeJson(fixture.artifactRoot, "inventories/completeness.json", {
      version: 1,
      sourceFiles: state.bindings.source.entries.filter((entry: { kind: string }) => entry.kind === "FILE").map((entry: { path: string }) => entry.path),
      units: FIXTURE_CENSUS.map((unitPath) => ({ path: unitPath, disposition: "MIGRATED_BEHAVIOR", ref: "B-1" })),
      requirements: [],
    });
    const further = await runArtifact(fixture.options);
    expect(further.outcome).toBe("CONTINUE");
    expect((await stateOf(fixture)).currentStep).toBe("ASSESS_TARGET");

    // Replay the now-superseded transaction as if it were still pending.
    await writeFile(path.join(fixture.artifactRoot, "transaction.json"), `${JSON.stringify(transaction, null, 2)}\n`);
    const result = await runArtifact(fixture.options);
    expect(result.outcome).toBe("BLOCKED");
    expect(result.reason).toMatch(/diverged from its recorded prefix/);
  });
});

describe("legacy (version 1) journals", () => {
  it("a fully-applied version-1 bootstrap journal remains recoverable (base regression)", async () => {
    const fixture = await tracked();
    await bootstrap(fixture);
    const state = JSON.parse((await readMaybe(path.join(fixture.artifactRoot, "state.json")))!);
    const [event] = historyEvents(await readMaybe(path.join(fixture.artifactRoot, "history/history.ndjson")));
    await writeFile(
      path.join(fixture.artifactRoot, "transaction.json"),
      `${JSON.stringify({ version: 1, state, event }, null, 2)}\n`,
    );
    const status = await getArtifactStatus(fixture.options);
    expect(status.status).toBe("ACTIVE");
    const result = await runArtifact(fixture.options);
    expect(result.outcome).toBe("CONTINUE");
    expect(await exists(path.join(fixture.artifactRoot, "transaction.json"))).toBe(false);
  });

  it.each(["JOURNAL_ONLY", "HISTORY_APPENDED"] as const)(
    "recovers a v1 advance at %s exactly as uninterrupted execution, once",
    async (phase) => {
      const fixture = await tracked();
      await bootstrap(fixture);
      await authorSource(fixture);
      const { pre, post, transaction } = await captureTransaction(
        fixture, () => runArtifact(fixture.options), { kind: "ADVANCE", selectedSlice: null },
      );
      const legacy = { version: 1, state: transaction.state, event: transaction.event };
      await applyPhase(fixture, pre, post, phase, legacy);
      const pending = await snapshot(fixture);
      expect((await getArtifactStatus(fixture.options)).status).toBe("ACTIVE");
      expect(await snapshot(fixture)).toEqual(pending);

      const recovered = await runArtifact(fixture.options);
      expect(recovered.outcome, recovered.reason).toBe("CONTINUE");
      expect(await snapshot(fixture)).toEqual(post);
      const events = historyEvents((await snapshot(fixture))["history/history.ndjson"]);
      expect(events.filter((event) => event.digest === transaction.event.digest)).toHaveLength(1);
      expect(await stateOf(fixture)).toEqual(transaction.state);

      // A subsequent invocation must neither append the event nor rewrite authority.
      expect((await runArtifact(fixture.options)).outcome).toBe("CONTINUE");
      expect(await snapshot(fixture)).toEqual(post);
    },
  );

  it.each(["STATE_REPLACED", "INTEGRITY_REPLACED"] as const)(
    "keeps a v1 advance at %s BLOCKED without its lost preimage",
    async (phase) => {
      const fixture = await tracked();
      await bootstrap(fixture);
      await authorSource(fixture);
      const { pre, post, transaction } = await captureTransaction(
        fixture, () => runArtifact(fixture.options), { kind: "ADVANCE", selectedSlice: null },
      );
      await applyPhase(fixture, pre, post, phase, {
        version: 1, state: transaction.state, event: transaction.event,
      });
      const before = await snapshot(fixture);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await runArtifact(fixture.options);
        expect(result.outcome).toBe("BLOCKED");
        expect(result.reason).toMatch(/no reconstructible predecessor/);
        expect(await snapshot(fixture)).toEqual(before);
      }
    },
  );

  it.each([
    "forged event", "forged proposal", "corrupt prefix", "corrupt integrity",
    "missing integrity", "stale suffix", "truncated history", "missing checkpoint",
    "foreign identity", "unknown envelope key",
  ])("rejects a v1 HISTORY_APPENDED journal with %s before mutation", async (variant) => {
    const fixture = await tracked();
    await bootstrap(fixture);
    await authorSource(fixture);
    const { pre, post, transaction } = await captureTransaction(
      fixture, () => runArtifact(fixture.options), { kind: "ADVANCE", selectedSlice: null },
    );
    const legacy = { version: 1, state: transaction.state, event: transaction.event };
    const damaged = { ...post };
    if (variant === "forged event") {
      // Both copies and the digest agree: only transition reproof detects the lie.
      legacy.event = rehashEvent({ ...legacy.event, to: "ASSESS_TARGET" });
      damaged["history/history.ndjson"] = `${pre["history/history.ndjson"]}${JSON.stringify(legacy.event)}\n`;
    } else if (variant === "forged proposal") {
      legacy.state = { ...legacy.state, nextAction: "Skip the checkpoint." };
    } else if (variant === "corrupt prefix") {
      // Semantically unchanged history is still not the exact anchored byte prefix.
      damaged["history/history.ndjson"] = ` ${post["history/history.ndjson"]}`;
    } else if (variant === "stale suffix") {
      const extra = rehashEvent({ ...legacy.event, seq: legacy.event.seq + 1, prevDigest: legacy.event.digest });
      damaged["history/history.ndjson"] += `${JSON.stringify(extra)}\n`;
    } else if (variant === "truncated history") {
      damaged["history/history.ndjson"] = post["history/history.ndjson"]!.slice(0, -12);
    } else if (variant === "foreign identity") {
      legacy.state = { ...legacy.state, artifactId: "different-artifact" };
    }
    await applyPhase(fixture, pre, damaged, "HISTORY_APPENDED",
      variant === "unknown envelope key" ? { ...legacy, extra: true } : legacy);
    if (variant === "corrupt integrity") {
      await writeJson(fixture.artifactRoot, "integrity.json", {
        ...JSON.parse(pre["integrity.json"]!), historyBytes: 0,
      });
    } else if (variant === "missing integrity") {
      await rm(path.join(fixture.artifactRoot, "integrity.json"));
    } else if (variant === "missing checkpoint") {
      await rm(path.join(fixture.artifactRoot, "inventories/source.json"));
    }
    const before = await snapshot(fixture);
    const inventoryPath = path.join(fixture.artifactRoot, "inventories/source.json");
    const inventory = await readMaybe(inventoryPath);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await getArtifactStatus(fixture.options);
      expect(await snapshot(fixture)).toEqual(before);
      const result = await runArtifact(fixture.options);
      expect(result.outcome, result.reason).toBe("BLOCKED");
      expect(await snapshot(fixture)).toEqual(before);
      expect(await readMaybe(inventoryPath)).toBe(inventory);
    }
  });

  it("the pre-existing orphan-transaction regression keeps its exact message", async () => {
    const fixture = await tracked();
    await bootstrap(fixture);
    const state = await stateOf(fixture);
    const orphan = {
      version: 1,
      state,
      event: {
        seq: 99,
        at: state.updatedAt,
        event: "ADVANCED",
        from: "DISCOVER_LEGACY",
        to: "DISCOVERY_COMPLETENESS",
        slice: null,
        revision: state.revision,
        prevDigest: null,
        digest: localSha256("orphan"),
      },
    };
    await writeFile(path.join(fixture.artifactRoot, "transaction.json"), `${JSON.stringify(orphan, null, 2)}\n`);
    const status = await getArtifactStatus(fixture.options);
    expect(status.status).toBe("BLOCKED");
    expect(status.reason).toMatch(/cannot be appended in sequence/);
  });
});

describe("--status stays read-only even under a BLOCKED record", () => {
  it("BLOCKED status never mutates the on-disk record", async () => {
    const fixture = await tracked();
    const { pre, post, transaction } = await (async () => {
      await bootstrap(fixture);
      await authorSource(fixture);
      return captureTransaction(fixture, () => runArtifact(fixture.options), { kind: "ADVANCE", selectedSlice: null });
    })();
    const forged = { ...transaction, previousState: { ...(transaction.previousState as Record<string, unknown>), currentStep: "ASSESS_TARGET" } };
    await applyPhase(fixture, pre, post, "JOURNAL_ONLY", forged);
    const before = await snapshot(fixture);
    const status = await getArtifactStatus(fixture.options);
    expect(status.status).toBe("ACTIVE"); // status never deep-proves; this is intentional and documented.
    expect(await snapshot(fixture)).toEqual(before);
  });
});
