// Track A1: the store/ and shared/ module boundary, and adversarial cases for
// the persistence guarantees store/ now owns. Imports only the two entries.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  isLexicallyWithin,
  isResolvedWithin,
  sha256Hex,
} from "../../src/shared/index.mjs";
import {
  appendDurably,
  appendHistory,
  assertUnanchoredHistoryTail,
  atomicWrite,
  digestArtifactHashes,
  hashHistoryEvent,
  HISTORY_FILE,
  INTEGRITY_FILE,
  pinDigest,
  prepareHistoryEvent,
  readHistoryEvents,
  readTree,
  recoverRegistryJournal,
  registryJournalPathFor,
  renderIntegrity,
  sealHistoryTail,
} from "../../src/store/index.mjs";

const src = fileURLToPath(new URL("../../src/", import.meta.url));
const ts = createRequire(import.meta.url)("ts-discovery-compiler");
const repo = path.resolve(src, "../../..");

const scratch = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "a1-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const sourceFiles = async (root) =>
  (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.m?js$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !file.split(path.sep).includes("node_modules"));

/** Every module specifier a file names: static, re-export and dynamic import. */
const specifiers = async (file) => {
  const sf = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      found.push({ spec: node.moduleSpecifier.text, names: names(node) });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found.push({ spec: ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : "<dynamic>", names: [] });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { sf, found };
};
const names = (node) => {
  const clause = node.importClause?.namedBindings ?? node.exportClause;
  if (!clause) return node.importClause?.name ? ["default"] : ["*"];
  if (ts.isNamespaceImport(clause)) return ["*"];
  return clause.elements.map((element) => (element.propertyName ?? element.name).text);
};

// -- boundary ----------------------------------------------------------------

const MODULES = ["store", "shared", "formats", "decisions", "slices"];
// store may reach down to formats, shared and the leaf `engine-paths.mjs`;
// formats only to shared (Track A2, layering option (b)); decisions only to
// store, formats and shared (Track A3), so it reads no census, slice, visual,
// lifecycle or transport code, not even lazily; slices only to decisions,
// store, formats and shared (Track A4), so census, visual, lifecycle and
// transport facts reach it only as data from its seams; shared reaches nothing
// in the engine. Anything else would be an upward edge or a cycle.
const ALLOWED = {
  slices: new Set(["decisions/index.mjs", "store/index.mjs", "formats/index.mjs", "shared/index.mjs"]),
  decisions: new Set(["store/index.mjs", "formats/index.mjs", "shared/index.mjs"]),
  store: new Set(["formats/index.mjs", "shared/index.mjs", "engine-paths.mjs"]),
  formats: new Set(["shared/index.mjs"]),
  shared: new Set(),
};
const FS_WRITES = new Set([
  "appendFile", "chmod", "chown", "copyFile", "cp", "createWriteStream", "link", "mkdir",
  "mkdtemp", "open", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile",
]);

test("A1-ARCH-1: outside its directory, store/, shared/, formats/, decisions/ and slices/ are reached only through index.mjs", async () => {
  const offenders = [];
  for (const root of ["packages/migration-engine/src", "packages/migration-engine/test", "test", "scripts"]) {
    for (const file of await sourceFiles(path.join(repo, root))) {
      for (const { spec } of (await specifiers(file)).found) {
        if (!spec.startsWith(".")) continue;
        const target = path.relative(src, path.resolve(path.dirname(file), spec)).split(path.sep).join("/");
        const [module, ...rest] = target.split("/");
        if (!MODULES.includes(module) || rest.join("/") === "index.mjs") continue;
        if (path.relative(path.join(src, module), file).startsWith("..")) offenders.push(`${path.relative(repo, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
  for (const module of MODULES) await readFile(path.join(src, module, "index.mjs"));
});

test("A1-ARCH-2: store/, shared/, formats/, decisions/ and slices/ import nothing above them, shared/ writes nothing, formats/ touches no file, none runs code at import", async () => {
  for (const module of MODULES) {
    for (const file of await sourceFiles(path.join(src, module))) {
      const label = path.relative(src, file);
      const { sf, found } = await specifiers(file);
      for (const { spec, names: imported } of found) {
        if (spec.startsWith("node:")) {
          if (module === "shared" && /^node:fs(\/promises)?$/.test(spec)) {
            assert.deepEqual(imported.filter((name) => FS_WRITES.has(name) || name === "*" || name === "default"), [], `${label} imports a filesystem write from ${spec}`);
          }
          // Formats is the record model: pure, so no filesystem access at all.
          assert.ok(module !== "formats" || !/^node:fs(\/|$)/.test(spec), `${label} imports ${spec}`);
          continue;
        }
        assert.ok(spec.startsWith("."), `${label} imports the package ${spec}`);
        const target = path.relative(src, path.resolve(path.dirname(file), spec)).split(path.sep).join("/");
        assert.ok(target.startsWith(`${module}/`) || ALLOWED[module].has(target), `${label} imports ${target}`);
      }
      for (const statement of sf.statements) {
        assert.ok(
          ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ||
            ts.isVariableStatement(statement) || ts.isFunctionDeclaration(statement) ||
            // A class runs nothing at import unless a static member does.
            (ts.isClassDeclaration(statement) &&
              !statement.members.some((member) => ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static)),
          `${label}:${sf.getLineAndCharacterOfPosition(statement.getStart()).line + 1} runs at import time`,
        );
      }
    }
  }
  // The leaf file store may import must stay a leaf, or the edge closes a cycle.
  for (const [file, allowed] of [["engine-paths.mjs", []]]) {
    const local = (await specifiers(path.join(src, file))).found.map(({ spec }) => spec).filter((spec) => spec.startsWith("."));
    assert.deepEqual(local, allowed, file);
  }
});

// The declarations A1 moved, by their old home. A second live copy at the old
// site would make the guarantee two-owner again.
const MOVED = {
  "migration-utils.mjs": ["portablePath", "comparablePath", "samePath", "isWithin", "assertSecurePath", "assertProjectRootContainment", "assertPlainObject", "SAFE_NAME", "assertSafeName", "sha256Hex", "contentIdentity", "contentIdentityMatches", "execFileAsync", "gitRevision", "dirtyManifest", "atomicWrite", "fileContentIdentity", "fileContentIdentityMatches", "readRegistry", "resolveRegistryPath", "previewRegistryUpdate", "recoverRegistryJournal", "canonical"],
  "resumable-migration.mjs": ["isWithin", "isPlainObject", "assertPlainObject", "assertNonEmpty", "hashContent", "sha256Json", "now", "fileExists", "readJson", "hashFile", "fileIdentity", "migrationRoot", "INTEGRITY_FILE", "digestArtifactHashes", "renderIntegrity", "readIntegrity", "historyDigest", "canonicalHistoryJson", "hashHistoryEvent", "prepareHistoryEvent", "appendHistory", "sealHistoryTail", "readHistoryEvents", "assertUnanchoredHistoryTail", "removeEmptyParents"],
  "record-decision.mjs": ["appendDurably"],
  "artifact/artifact-migration.mjs": ["portable", "sha256", "canonical", "jsonBytes", "samePath", "isWithin", "exists", "plainObject", "nonEmpty", "normalizeRelative", "secureHash", "pinDigest", "integrityFor", "artifactRoot", "readJsonAt"],
  "discovery-scan.mjs": ["portable", "isWithin", "execFileAsync"],
  "upgrades/upgrade-migration.mjs": ["sha256", "exists", "readTree", "writeTree", "manifestOf"],
  "visual-evidence.mjs": ["sha256"],
};

test("A1-ARCH-3: a moved declaration has no second live implementation at its old site", async () => {
  for (const [file, moved] of Object.entries(MOVED)) {
    const { sf } = await specifiers(path.join(src, file));
    const declared = new Set(sf.statements.flatMap((statement) =>
      ts.isFunctionDeclaration(statement) ? [statement.name.text]
        : ts.isVariableStatement(statement) ? statement.declarationList.declarations.map((d) => d.name.text) : []));
    assert.deepEqual(moved.filter((name) => declared.has(name)), [], file);
  }
});

// -- shared ------------------------------------------------------------------

test("shared: the two containment checks stay two exports and agree on absolute inputs", () => {
  assert.notEqual(isLexicallyWithin, isResolvedWithin);
  for (const [root, candidate, expected] of [["/a", "/a", true], ["/a", "/a/b", true], ["/a", "/ab", false], ["/a", "/a/../b", false]]) {
    assert.equal(isLexicallyWithin(root, candidate), expected);
    assert.equal(isResolvedWithin(root, candidate), expected);
  }
});

test("shared: sha256Hex and canonicalJson are the primitives the pins digest", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(canonicalJson({ b: [{ d: 1, c: 2 }], a: null }), '{"a":null,"b":[{"c":2,"d":1}]}');
});

// -- store: durable writes ---------------------------------------------------

test("store: atomicWrite refuses a symlinked path with zero mutation and leaves no temp file behind", async (t) => {
  const root = await scratch(t);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "victim.json"), "original");
  const repoRoot = path.join(root, "repo");
  await mkdir(repoRoot);
  await symlink(outside, path.join(repoRoot, "link"));
  await assert.rejects(atomicWrite(repoRoot, path.join(repoRoot, "link/victim.json"), "forged"), /Refusing symlink output path/);
  assert.equal(await readFile(path.join(outside, "victim.json"), "utf8"), "original");
  await assert.rejects(atomicWrite(repoRoot, path.join(root, "escape.json"), "x"), /escapes the target repository/);

  // rename onto a directory fails after the temp file exists: it must be cleaned up.
  await mkdir(path.join(repoRoot, "occupied"));
  await assert.rejects(atomicWrite(repoRoot, path.join(repoRoot, "occupied"), "x"));
  assert.deepEqual((await readdir(repoRoot)).sort(), ["link", "occupied"]);
});

test("store: appendDurably appends exact bytes through its crash boundaries and refuses a symlinked ledger", async (t) => {
  const root = await scratch(t);
  const ledger = path.join(root, "decisions/ledger.ndjson");
  const seen = [];
  await appendDurably(root, ledger, "one\n", async (boundary) => seen.push(boundary));
  await appendDurably(root, ledger, "two\n", async () => {});
  assert.deepEqual(seen, ["during-append", "after-append", "after-fsync"]);
  assert.equal(await readFile(ledger, "utf8"), "one\ntwo\n");

  // A crash after a torn prefix leaves exactly that prefix: nothing is rewritten.
  await assert.rejects(appendDurably(root, ledger, "three\n", async (boundary, io) => {
    if (boundary === "during-append") { await io.writePrefix(2); throw new Error("killed"); }
  }), /killed/);
  assert.equal(await readFile(ledger, "utf8"), "one\ntwo\nth");

  await writeFile(path.join(root, "target"), "kept");
  await symlink(path.join(root, "target"), path.join(root, "decisions/linked.ndjson"));
  await assert.rejects(appendDurably(root, path.join(root, "decisions/linked.ndjson"), "x\n", async () => {}));
  assert.equal(await readFile(path.join(root, "target"), "utf8"), "kept");
});

// -- store: history chain and integrity anchor ---------------------------------

/** A record born chained, as initialization writes it, then one transition per event. */
const chain = async (record, [created, ...events]) => {
  await mkdir(path.join(record, path.dirname(HISTORY_FILE)), { recursive: true });
  Object.assign(created, { at: "2026-01-01T00:00:00.000Z", seq: 1, previousHash: null });
  created.hash = hashHistoryEvent(created);
  await writeFile(path.join(record, HISTORY_FILE), `${JSON.stringify(created)}\n`);
  let historyChain = { version: 1, startSeq: 1, legacyPrefixSha256: null, headHash: created.hash };
  for (const event of events) {
    await writeFile(path.join(record, INTEGRITY_FILE), `${JSON.stringify({ historyChain })}\n`);
    historyChain = await prepareHistoryEvent(record, event);
    await writeFile(path.join(record, INTEGRITY_FILE), `${JSON.stringify({ historyChain })}\n`);
    await appendHistory(record, record, event);
  }
};

test("store: the history chain verifies, and a one-byte edit, a reorder or a forged head is refused", async (t) => {
  const record = await scratch(t);
  await chain(record, [{ event: "A", revision: 1 }, { event: "B", revision: 2 }, { event: "C", revision: 3 }]);
  const events = await readHistoryEvents(record);
  assert.deepEqual(events.map(({ seq, event }) => [seq, event]), [[1, "A"], [2, "B"], [3, "C"]]);
  assert.equal(events[1].previousHash, events[0].hash);

  const file = path.join(record, HISTORY_FILE);
  const good = await readFile(file, "utf8");
  await writeFile(file, good.replace('"event":"B"', '"event":"X"'));
  await assert.rejects(readHistoryEvents(record), /line 2 has an invalid hash/);
  const lines = good.split("\n");
  await writeFile(file, [lines[1], lines[0], lines[2], ""].join("\n"));
  await assert.rejects(readHistoryEvents(record), /invalid hash, seq, or previousHash/);
  await writeFile(file, good);
  const integrity = JSON.parse(await readFile(path.join(record, INTEGRITY_FILE), "utf8"));
  integrity.historyChain.headHash = `sha256:${"0".repeat(64)}`;
  await assert.rejects(readHistoryEvents(record, integrity), /headHash disagrees/);
});

test("store: a torn history tail is refused until sealed, and sealing cuts a fragment but keeps a whole event", async (t) => {
  const record = await scratch(t);
  await mkdir(path.join(record, "history"));
  const file = path.join(record, HISTORY_FILE);
  await writeFile(file, '{"event":"A"}\n{"event":"B"}');
  await assert.rejects(readHistoryEvents(record, null), /unterminated/);
  assert.equal(await sealHistoryTail(record, record), "TERMINATED");
  assert.equal(await readFile(file, "utf8"), '{"event":"A"}\n{"event":"B"}\n');
  await writeFile(file, '{"event":"A"}\n{"eve');
  assert.equal(await sealHistoryTail(record, record), "TRUNCATED");
  assert.equal(await readFile(file, "utf8"), '{"event":"A"}\n');
  assert.equal(await sealHistoryTail(record, record), null);
});

test("store: past the integrity anchor only the one event of the current revision may sit", () => {
  const tail = (...events) => Buffer.from(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  assertUnanchoredHistoryTail({ revision: 4 }, tail({ revision: 4 }));
  assertUnanchoredHistoryTail({ revision: 4 }, Buffer.from('{"revision":4}\n{"rev'));
  assert.throws(() => assertUnanchoredHistoryTail({ revision: 4 }, tail({ revision: 4 }, { revision: 4 })), /2 events past/);
  assert.throws(() => assertUnanchoredHistoryTail({ revision: 4 }, tail({ revision: 3 })), /records revision 3/);
});

test("store: integrity.json bytes are stable, and the artifactHashes digest ignores key order", () => {
  assert.equal(digestArtifactHashes({ b: "2", a: "1" }), digestArtifactHashes({ a: "1", b: "2" }));
  assert.notEqual(digestArtifactHashes({ a: "1" }), digestArtifactHashes({ a: "2" }));
  const anchor = { bytes: 0, sha256: createHash("sha256").digest("hex") };
  // An unstamped record without an AUTO ledger writes no trailing fields at all.
  assert.equal(
    renderIntegrity({ revision: 3, artifactHashes: {} }, anchor, anchor, null, null),
    `${JSON.stringify({ revision: 3, artifactHashesSha256: digestArtifactHashes({}), history: anchor, decisions: anchor }, null, 2)}\n`,
  );
});

// -- store: registry journal, upgrade tree, artifact pins -----------------------

test("store: registry journal recovery finishes only a write whose before-bytes still match", async (t) => {
  const root = await scratch(t);
  const registryPath = path.join(root, "registry.json");
  const configPath = path.join(root, "package.json");
  await writeFile(registryPath, "before");
  await writeFile(configPath, "changed later");
  await mkdir(path.dirname(registryJournalPathFor(root)), { recursive: true });
  await writeFile(registryJournalPathFor(root), JSON.stringify({
    registryPath, registryBefore: "before", registryAfter: "after",
    configPath, configBefore: "config before", configAfter: "config after", projectRoot: root,
  }));
  await recoverRegistryJournal(root);
  assert.equal(await readFile(registryPath, "utf8"), "after");
  assert.equal(await readFile(configPath, "utf8"), "changed later");
  await assert.rejects(readFile(registryJournalPathFor(root)), { code: "ENOENT" });

  await writeFile(registryJournalPathFor(root), "{torn");
  await assert.rejects(recoverRegistryJournal(root), /journal is unreadable/);
  assert.equal(await readFile(registryJournalPathFor(root), "utf8"), "{torn");
});

test("store: readTree refuses a symlink anywhere in the tree", async (t) => {
  const root = await scratch(t);
  await mkdir(path.join(root, "tree/nested"), { recursive: true });
  await writeFile(path.join(root, "tree/nested/a.md"), "a");
  assert.deepEqual(await readTree(path.join(root, "tree")), { "nested/a.md": "a" });
  await symlink(path.join(root, "tree/nested/a.md"), path.join(root, "tree/nested/b.md"));
  await assert.rejects(readTree(path.join(root, "tree")), /Refusing symlinked migration file/);
});

test("store: the semantic artifact pin ignores provider and session but nothing else", async (t) => {
  const root = await scratch(t);
  const write = (rows) => writeFile(path.join(root, "evidence.json"), JSON.stringify({ kind: "ui", runtimeEvidence: rows }));
  await write([{ provider: "codex", sessionId: "1", step: "load" }]);
  const pinned = await pinDigest(root, "evidence.json#semantic");
  await write([{ provider: "claude", sessionId: "2", step: "load" }]);
  assert.equal(await pinDigest(root, "evidence.json#semantic"), pinned);
  await write([{ provider: "claude", sessionId: "2", step: "submit" }]);
  assert.notEqual(await pinDigest(root, "evidence.json#semantic"), pinned);
  await assert.rejects(pinDigest(root, "../escape.json"), /escapes its declared root/);
});
