// node --test docs/architecture/phase0/tools/test/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BASE, DATA, TOOLKIT, baseData, engineRepo, hasBase, rowsOf, tool } from "./fixture.mjs";

const FS = `import { constants as fsConstants, writeSync, openSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rm, writeFile, rename } from "node:fs/promises";
import path from "node:path";
`;
const inv = (files, mode) => tool("inventory.mjs", [engineRepo(files), "HEAD", mode]);
const writesOf = (body) => { const r = inv({ "a.mjs": FS + body }, "writes"); assert.equal(r.status, 0, r.stderr); return rowsOf(r.stdout).map((w) => w[3]); };
const refused = (r, pattern) => { assert.equal(r.status, 1, r.stdout + r.stderr); assert.equal(r.stdout, ""); if (pattern) assert.match(r.stderr, pattern); };

test("F6-1 an unsupported mode exits 2, lists the modes and prints nothing", () => {
  const r = inv({ "a.mjs": "export const a = 1;\n" }, "bogus");
  assert.equal(r.status, 2); assert.equal(r.stdout, ""); assert.match(r.stderr, /decls, writes, imports, fv/);
});

test("F6-2 missing or extra arguments and an unknown ref exit 2", () => {
  const repo = engineRepo({ "a.mjs": "export const a = 1;\n" });
  for (const args of [[repo, "HEAD"], [repo, "HEAD", "decls", "extra"], [repo, "no-such-ref", "decls"], [repo, "HEAD", "decls", "--samples"]]) {
    const r = tool("inventory.mjs", args);
    assert.equal(r.status, 2, args.join(" ")); assert.equal(r.stdout, "");
  }
});

test("A5 a file with a syntax error fails every mode", () => {
  for (const mode of ["decls", "writes", "imports", "fv"]) refused(inv({ "a.mjs": "export const a = ;\n" }, mode), /syntax error/);
});

test("F4-1 verbatim appendDurably (BASE record-decision.mjs:1388-1409): numeric-flag open and both handle.write calls", () => {
  const body = `${FS}const assertSecurePath = async () => {};
const appendDurably = async (targetRoot, file, text, onBoundary) => {
  await assertSecurePath(targetRoot, file);
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(text, "utf8");
    await onBoundary("during-append", { writePrefix: (length) => handle.write(bytes, 0, length) });
    for (let offset = 0; offset < bytes.length;) {
      offset += (await handle.write(bytes, offset, bytes.length - offset)).bytesWritten;
    }
    await onBoundary("after-append");
    await handle.sync();
    await onBoundary("after-fsync");
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") {
    const directory = await open(path.dirname(file), fsConstants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
};
`;
  const r = inv({ "record-decision.mjs": body }, "writes");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(rowsOf(r.stdout).map(([, line, owner, call]) => [Number(line), owner, call]),
    [[7, "appendDurably", "mkdir"], [8, "appendDurably", "open"], [11, "appendDurably", "handle.write"], [13, "appendDurably", "handle.write"]]);
});

test("F4-2 constant flags: write bits count, read-only and 0 do not, other numbers and variables fail", () => {
  assert.deepEqual(writesOf(`export const f = async (p) => { await (await open(p, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL)).close(); };\n`), ["open"]);
  assert.deepEqual(writesOf(`export const f = async (p) => { await (await open(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)).close(); };\n`), []);
  assert.deepEqual(writesOf(`export const f = (p) => openSync(p, 0);\n`), []);
  refused(inv({ "a.mjs": `${FS}export const f = (p) => openSync(p, 0o101);\n` }, "writes"), /cannot classify open flags 0o101/);
  refused(inv({ "a.mjs": `${FS}export const f = (p, flags) => openSync(p, flags);\n` }, "writes"), /cannot classify open flags flags/);
});

test("F4-3 string flags r, rs, r+, wx, a and none", () => {
  const body = `export const r = (p) => openSync(p, "r");
export const rs = (p) => openSync(p, "rs");
export const rplus = (p) => openSync(p, "r+");
export const wx = (p) => openSync(p, "wx");
export const a = (p) => openSync(p, "a");
export const none = (p) => openSync(p);
`;
  const r = inv({ "a.mjs": FS + body }, "writes");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(rowsOf(r.stdout).map((w) => w[2]), ["rplus", "wx", "a"]);
});

test("F4-4 FileHandle write methods count, read and lifecycle methods do not; reassigned and inline handles", () => {
  const body = `export const f = async (p) => {
  let h;
  h = await open(p, "r+");
  await h.write("x"); await h.writev([]); await h.writeFile("x"); await h.appendFile("x"); await h.truncate(0); await h.chmod(0o600);
  await h.sync(); await h.readFile(); await h.stat(); await h.close();
  await (await open(p, "wx")).close();
};
`;
  assert.deepEqual(writesOf(body), ["open", "h.appendFile", "h.chmod", "h.truncate", "h.write", "h.writeFile", "h.writev", "open"]);
});

test("F4-5 a handle that escapes fails the run", () => {
  refused(inv({ "a.mjs": `${FS}const use = () => {};\nexport const f = async (p) => { const handle = await open(p, "w"); use(handle); };\n` }, "writes"), /handle handle escapes/);
  refused(inv({ "a.mjs": `${FS}export const f = async (p) => { const handle = await open(p, "w"); return handle; };\n` }, "writes"), /escapes/);
  refused(inv({ "a.mjs": `${FS}export const f = async (p) => { let handle = await open(p, "w"); handle = 3; };\n` }, "writes"), /non-handle value/);
});

test("F4-6 aliases: renamed import, namespace import, fs.promises, one-level const alias", () => {
  const body = `import { writeFile as wf } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import fs from "node:fs";
const w = wf;
export const f = async (p) => { await wf(p, "x"); await fsp.rm(p); await fs.promises.rename(p, p); await w(p, "y"); fs.mkdirSync(p); };
`;
  const r = inv({ "a.mjs": body }, "writes");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(rowsOf(r.stdout).map((w) => w[3]), ["fs.mkdirSync", "fs.promises.rename", "fsp.rm", "w", "wf"]);
});

const EXPORTED = `import { writeFile as fsWriteFile } from "node:fs/promises";\nexport const writeFile = fsWriteFile;\n`;
const callsIn = (files) => { const r = inv(files, "writes"); assert.equal(r.status, 0, r.stderr); return rowsOf(r.stdout).map(([file, , , call]) => `${file} ${call}`); };

test("F4-11 P1 an exported const alias is followed through named imports, renames and re-export chains", () => {
  assert.deepEqual(callsIn({ "a.mjs": EXPORTED, "b.mjs": `import { writeFile } from "./a.mjs";\nexport const f = async (p) => { await writeFile(p, "x"); };\n` }), ["b.mjs writeFile"]);
  assert.deepEqual(callsIn({ "a.mjs": EXPORTED, "c.mjs": `export * from "./a.mjs";\nexport { writeFile as save } from "./a.mjs";\n`,
    "b.mjs": `import { writeFile, save } from "./c.mjs";\nexport const f = (p) => { writeFile(p, "x"); save(p, "y"); };\n` }), ["b.mjs save", "b.mjs writeFile"]);
});

test("F4-12 P2 const alias chains are followed transitively; P3 one level still counts; cycles end", () => {
  assert.deepEqual(writesOf(`const w1 = writeFile;\nconst w2 = w1;\nconst w3 = w2;\nexport const f = async (p) => { await w2(p, "x"); await w3(p, "y"); };\n`), ["w2", "w3"]);
  assert.deepEqual(writesOf(`const w = writeFile;\nexport const f = async (p) => { await w(p, "x"); };\n`), ["w"]);
  assert.deepEqual(callsIn({ "a.mjs": `import { y } from "./b.mjs";\nexport const x = y;\nconst c1 = c2;\nconst c2 = c1;\nexport const f = () => c1();\n`,
    "b.mjs": `import { x } from "./a.mjs";\nexport const y = x;\nexport const g = () => y();\n` }), []);
});

test("F4-13 aliases keep lexical identity: shadowed names and same-named engine functions are not writes", () => {
  assert.deepEqual(writesOf(`const w = writeFile;\nexport const f = (w, p) => w(p);\nexport const g = (p) => { const w = (q) => q; return w(p); };\n`), []);
  assert.deepEqual(callsIn({ "a.mjs": `export const writeFile = (p) => p;\nexport const w1 = writeFile;\n`,
    "b.mjs": `import { writeFile, w1 } from "./a.mjs";\nexport const f = (p) => { writeFile(p); w1(p); };\n` }), []);
});

test("F4-14 an alias chain that escapes fails: value use at any depth, namespace and dynamic imports of a module exporting one", () => {
  refused(inv({ "a.mjs": `${FS}const w1 = rm;\nconst w2 = w1;\nexport const f = (ps) => ps.map(w2);\n` }, "writes"), /used as a value: w2/);
  refused(inv({ "a.mjs": EXPORTED, "b.mjs": `import { writeFile } from "./a.mjs";\nexport const f = (ps) => ps.map(writeFile);\n` }, "writes"), /used as a value: writeFile/);
  refused(inv({ "a.mjs": EXPORTED, "b.mjs": `import * as a from "./a.mjs";\nexport const f = (p) => a.writeFile(p, "x");\n` }, "writes"), /namespace or dynamic import of \.\/a\.mjs, which exports fs write alias writeFile/);
  refused(inv({ "a.mjs": EXPORTED, "c.mjs": `export * from "./a.mjs";\n`, "b.mjs": `import * as c from "./c.mjs";\nexport const f = (p) => c.writeFile(p, "x");\n` }, "writes"), /import of \.\/c\.mjs/);
  refused(inv({ "a.mjs": EXPORTED, "b.mjs": `export const f = async (p) => { const { writeFile } = await import("./a.mjs"); await writeFile(p, "x"); };\n` }, "writes"), /namespace or dynamic import/);
  assert.deepEqual(callsIn({ "a.mjs": `export const g = () => 1;\n`, "b.mjs": `import * as a from "./a.mjs";\nexport const f = async () => { a.g(); (await import("./a.mjs")).g(); };\n` }), []);
});

test("B1 fs re-exports consumed through namespace or dynamic imports fail; named imports of them fail; read-only re-exports pass", () => {
  const NS = `import * as a from "./a.mjs";\nexport const f = (p) => a.writeFile(p, "x");\n`;
  const DYN = `export const f = async (p) => (await import("./a.mjs")).writeFile(p, "x");\n`;
  const NSX = `import * as a from "./a.mjs";\nexport const f = (p) => a.fsx.writeFileSync(p, "x");\n`;
  const RE = `export { writeFile } from "node:fs/promises";\n`;
  refused(inv({ "a.mjs": RE, "b.mjs": NS }, "writes"), /namespace or dynamic import of \.\/a\.mjs, which exports fs write alias writeFile/);
  refused(inv({ "a.mjs": RE, "b.mjs": DYN }, "writes"), /namespace or dynamic import of \.\/a\.mjs, which exports fs write alias writeFile/);
  refused(inv({ "a.mjs": `export { promises } from "node:fs";\n`, "b.mjs": NS }, "writes"), /exports fs write alias promises/);
  refused(inv({ "a.mjs": `export * from "node:fs/promises";\n`, "b.mjs": NS }, "writes"), /export \* from fs/);
  refused(inv({ "a0.mjs": `export * from "node:fs/promises";\n`, "a.mjs": `export * from "./a0.mjs";\n`, "b.mjs": DYN }, "writes"), /export \* from fs/);
  refused(inv({ "a.mjs": `export * as fsx from "node:fs";\n`, "b.mjs": NSX }, "writes"), /exports fs write alias fsx/);
  refused(inv({ "a0.mjs": RE, "a.mjs": `export * from "./a0.mjs";\n`, "b.mjs": NS }, "writes"), /exports fs write alias writeFile/);
  refused(inv({ "a.mjs": RE, "b.mjs": `import { writeFile } from "./a.mjs";\nexport const f = (p) => writeFile(p, "x");\n` }, "writes"), /writeFile does not resolve/);
  refused(inv({ "a.mjs": `import { writeFile } from "node:fs/promises";\nexport { writeFile };\n`, "b.mjs": NS }, "writes"), /does not resolve/);
  assert.deepEqual(callsIn({ "a.mjs": `export { readFile } from "node:fs/promises";\nexport const g = () => 1;\n`, "b.mjs": `import * as a from "./a.mjs";\nexport const f = (p) => { a.g(); return a.readFile(p); };\n` }), []);
});

test("F4-7 same-named locals, stdio and non-fs streams are not writes", () => {
  const body = `const rm = () => {}; const write = () => {}; const opener = { open: () => {} };
export const f = async (stdout, response, socket) => {
  rm(); write(); opener.open("x", "w"); stdout.write("x"); process.stderr.write("x"); response.end(); socket.write("x");
  const local = { write() {} }; local.write("x");
};
`;
  const r = inv({ "a.mjs": body }, "writes");
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, "");
});

test("F4 two identical calls on one line are two write sites", () => {
  assert.deepEqual(writesOf(`export const f = async (a, b) => { await rm(a); await rm(b); };\n`), ["rm", "rm"]);
});

test("F4-8 writeSync on a literal stdio fd is excluded; on an opened fd it counts", () => {
  assert.deepEqual(writesOf(`export const f = (p) => { writeSync(1, "x"); writeSync(2, "x"); const fd = openSync(p, "w"); writeSync(fd, "x"); };\n`), ["openSync", "writeSync"]);
});

test("F4-9 write primitives as values, computed fs access and dynamic fs loads fail", () => {
  refused(inv({ "a.mjs": `${FS}export const f = (ps) => Promise.all(ps.map(rm));\n` }, "writes"), /used as a value: rm/);
  refused(inv({ "a.mjs": `import * as fs from "node:fs";\nexport const f = (k, p) => fs[k](p);\n` }, "writes"), /computed fs access/);
  refused(inv({ "a.mjs": `import * as fs from "node:fs";\nexport const f = (k) => { const g = fs[k]; return g; };\n` }, "writes"), /computed fs access/);
  refused(inv({ "a.mjs": `${FS}export const ops = { writeFile };\n` }, "writes"), /used as a value: writeFile/);
  refused(inv({ "a.mjs": `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nexport const f = () => require("node:fs");\n` }, "writes"), /fs loaded dynamically/);
  refused(inv({ "a.mjs": `export const f = async () => import("node:fs");\n` }, "writes"), /fs loaded dynamically/);
});

test("A1-1 fv: one row per comparison, even when both operands match", () => {
  const r = inv({ "a.mjs": "const FORMAT_VERSION = 3;\nexport const ok = (s) => s.formatVersion === FORMAT_VERSION || s.formatVersion < 2;\n" }, "fv");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(rowsOf(r.stdout), [["a.mjs", "2", "ok", "s.formatVersion < 2"], ["a.mjs", "2", "ok", "s.formatVersion === FORMAT_VERSION"]]);
});

test("A2 decls: one row per declarator and an explicit <module-init> for top-level statements; writes there are owned by it", () => {
  const files = { "a.mjs": `${FS}export const a = 1, b = () => a;\nfunction main() {}\nif (process.argv[1]) main();\nawait writeFile("x", "y");\n` };
  const d = inv(files, "decls");
  assert.equal(d.status, 0, d.stderr);
  assert.deepEqual(rowsOf(d.stdout).map((r) => [r[3], r[4]]), [["fn", "b"], ["value", "a"], ["fn", "main"], ["module-init", "<module-init>"]]);
  assert.deepEqual(rowsOf(inv(files, "writes").stdout).map((r) => r[2]), ["<module-init>"]);
});

test("A2 unsupported top-level forms fail instead of being dropped", () => {
  refused(inv({ "a.mjs": "export const { a, b } = { a: 1, b: 2 };\n" }, "decls"), /destructuring/);
  refused(inv({ "a.mjs": "export default function () {}\n" }, "decls"), /default export/);
});

test("D-1 inventory output is byte-identical across runs", () => {
  const repo = engineRepo({ "a.mjs": `${FS}export const f = async (p) => { await rm(p); await writeFile(p, "x"); };\n`, "b.mjs": "export const g = 1;\n" });
  for (const mode of ["decls", "writes", "imports", "fv"]) assert.equal(tool("inventory.mjs", [repo, "HEAD", mode]).stdout, tool("inventory.mjs", [repo, "HEAD", mode]).stdout);
});

test("F4-10 BASE: 96 write sites, a superset of the 90 committed rows; decls/imports keep every committed row", { skip: !hasBase() && "BASE commit not in this clone" }, () => {
  const b = baseData(), lines = (f) => readFileSync(f, "utf8").trim().split("\n");
  const writes = new Set(lines(b["writes.tsv"]));
  assert.equal(writes.size, 96);
  for (const row of lines(path.join(DATA, "writes-05e6049.tsv"))) assert.ok(writes.has(row), row);
  for (const row of ["record-decision.mjs\t1391\tappendDurably\topen", "record-decision.mjs\t1394\tappendDurably\thandle.write", "record-decision.mjs\t1396\tappendDurably\thandle.write"])
    assert.ok(writes.has(row), row);
  const decls = new Set(lines(b["decls.tsv"]));
  for (const row of lines(path.join(DATA, "decls-05e6049.tsv"))) assert.ok(decls.has(row), row);
  assert.deepEqual(lines(b["imports.tsv"]).sort(), lines(path.join(DATA, "imports-05e6049.tsv")).sort());
  assert.equal(tool("inventory.mjs", [TOOLKIT, BASE, "writes"]).stdout, readFileSync(b["writes.tsv"], "utf8"));
});
