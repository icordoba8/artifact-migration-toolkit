import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { buildRelease, contentHashOf, payloadPaths, recordRelease, releaseCheck, repositoryRoot } from "../scripts/release.mjs";
import { resolveRelease } from "../scripts/runtime-bootstrap.mjs";
import { linkEngineDependencies } from "../packages/migration-engine/test/support/candidate-release-root.mjs";

const execFileAsync = promisify(execFile);
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const toolkit = { name: "artifact-migration-tools", version: "0.0.1", commit: "a".repeat(40), contentHash: `sha256:${"b".repeat(64)}` };
const member = `artifact-migration-tools-${toolkit.version}/release-manifest.json`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const scratch = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-discipline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

// Tiny USTAR fixtures; real system tar lists, type-checks and reads every case.
const archiveOf = (entries) => {
  const chunks = [];
  for (const { name, type = "0", body = "", link = "" } of entries) {
    const bytes = Buffer.from(body);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write(link, 157, 100);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
};
const manifestEntry = (identity = toolkit) => ({ name: member, body: json({ toolkit: identity }) });
const transport = (bytes, options = {}) => {
  let archive;
  return {
    resolve: async (version) => {
      assert.equal(version, toolkit.version);
      return { version, commit: toolkit.commit, asset: {
        name: `artifact-migration-tools-v${version}.tar.gz`, digest: options.digest ?? hash(bytes),
      } };
    },
    download: async (_resolved, destination) => {
      archive = destination;
      await writeFile(destination, bytes);
    },
    cleaned: async () => {
      assert.ok(archive, "the transport was exercised");
      await assert.rejects(stat(path.dirname(archive)), { code: "ENOENT" });
    },
  };
};

// Only payload bytes are copied; the live published registry is never a fixture.
const candidate = async (t) => {
  const root = await scratch(t);
  for (const relative of await payloadPaths()) {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(repositoryRoot, relative), destination);
    if (["package.json", "packages/migration-engine/package.json"].includes(relative) ||
        path.basename(relative) === "release-identity.json") {
      const value = JSON.parse(await readFile(destination, "utf8"));
      await writeFile(destination, json({ ...value, version: toolkit.version }));
    }
  }
  await linkEngineDependencies(root);
  return root;
};

test("established payload identity is read-only, outside contentHash, and cannot be forced", async (t) => {
  const root = await candidate(t);
  const registry = path.join(root, "released-versions.json");
  const initial = await contentHashOf(root);
  const rows = [{ version: toolkit.version, contentHash: initial.contentHash }];
  await writeFile(registry, json(rows));
  assert.ok(!(await payloadPaths(root)).includes("released-versions.json"));
  assert.equal((await contentHashOf(root)).contentHash, initial.contentHash);
  assert.equal((await releaseCheck(root)).versionConflict, null, "identical payload passes");
  await writeFile(path.join(root, "packages/migration-engine/src/f02-fixture.mjs"), "export const changed = true;\n");
  const before = await readFile(registry);
  const changed = await releaseCheck(root);
  assert.match(changed.versionConflict, /already established.*bump the version/s);
  assert.ok(changed.blockers.includes(changed.versionConflict));
  for (const force of [false, true]) {
    await assert.rejects(buildRelease({ root, force }), /already established/);
    assert.deepEqual(await readFile(registry), before);
  }
  await assert.rejects(stat(path.join(root, "dist")), { code: "ENOENT" });
  await writeFile(registry, "[ ]\n");
  assert.equal((await contentHashOf(root)).contentHash, changed.contentHash);
  assert.equal((await releaseCheck(root)).versionConflict, null, "unregistered version passes");
  const candidateRegistry = await readFile(registry);
  const built = await buildRelease({ root, force: true });
  assert.equal(built.identity.contentHash, changed.contentHash);
  assert.deepEqual(await readFile(registry), candidateRegistry, "build does not reserve a version");
});

test("record uses only the verified published toolkit hash; repeat is byte-identical, conflict refuses", async (t) => {
  const root = await scratch(t); // No working-tree payload from which to derive identity.
  const registry = path.join(root, "released-versions.json");
  const body = manifestEntry();
  const bytes = archiveOf([body]);
  assert.notEqual(hash(bytes), toolkit.contentHash);
  assert.notEqual(hash(body.body), toolkit.contentHash);
  assert.notEqual(hash(bytes), hash(body.body));
  const remote = transport(bytes);
  const row = await recordRelease(toolkit.version, { root, ...remote });
  assert.deepEqual(row, { version: toolkit.version, contentHash: toolkit.contentHash });
  assert.deepEqual(JSON.parse(await readFile(registry, "utf8")), [row]);
  await remote.cleaned();
  // Noncanonical whitespace proves an idempotent call does not rewrite JSON.
  await writeFile(registry, ` [ ${JSON.stringify(row)} ]\n\n`);
  const before = await readFile(registry);
  await recordRelease(toolkit.version, { root, ...remote });
  assert.deepEqual(await readFile(registry), before);
  await remote.cleaned();
  const conflict = transport(archiveOf([manifestEntry({ ...toolkit, contentHash: `sha256:${"c".repeat(64)}` })]));
  await assert.rejects(recordRelease(toolkit.version, { root, ...conflict }), /already established/);
  assert.deepEqual(await readFile(registry), before);
  await conflict.cleaned();
});

test("invalid published manifests and unsafe archives never mutate the registry or extract files", async (t) => {
  const root = await scratch(t);
  const registry = path.join(root, "released-versions.json");
  const before = Buffer.from("[ ]\n");
  await writeFile(registry, before);
  const cases = [
    ["version mismatch", archiveOf([manifestEntry({ ...toolkit, version: "9.9.9" })]), /toolkit version/],
    ["name mismatch", archiveOf([manifestEntry({ ...toolkit, name: "other" })]), /toolkit version/],
    ["commit mismatch", archiveOf([manifestEntry({ ...toolkit, commit: "c".repeat(40) })]), /toolkit version/],
    ["missing hash", archiveOf([manifestEntry({ ...toolkit, contentHash: undefined })]), /contentHash/],
    ["invalid hash", archiveOf([manifestEntry({ ...toolkit, contentHash: "b".repeat(64) })]), /contentHash/],
    ["malformed JSON", archiveOf([{ name: member, body: "{" }]), /JSON/],
    ["missing toolkit", archiveOf([{ name: member, body: "{}" }]), /toolkit version/],
    ["missing manifest", archiveOf([{ name: "other.json", body: "{}" }]), /exactly one/],
    ["duplicate manifest", archiveOf([manifestEntry(), manifestEntry()]), /exactly one/],
    ["empty archive", archiveOf([]), /Unsafe or empty/],
    ["symlink", archiveOf([{ name: member, type: "2", link: "other.json" }]), /regular file/],
    ["hardlink", archiveOf([{ name: member, type: "1", link: "other.json" }]), /regular file/],
    ["directory", archiveOf([{ name: member, type: "5" }]), /regular file/],
    ["corrupt tar", Buffer.from("not a tar archive"), /Command failed/],
  ];
  for (const name of ["../outside", "/outside", "a/../outside", "a/./outside", "a//outside", "a\\outside", "C:/outside"]) {
    cases.push([`unsafe ${name}`, archiveOf([manifestEntry(), { name, body: "must not extract" }]), /Unsafe/]);
  }
  for (const [label, bytes, expected] of cases) {
    const remote = transport(bytes);
    await assert.rejects(recordRelease(toolkit.version, { root, ...remote }), expected, label);
    assert.deepEqual(await readFile(registry), before, label);
    await remote.cleaned();
  }
});

test("digest verification precedes every tar call; tar failures clean scratch without a write", async (t) => {
  const root = await scratch(t);
  const registry = path.join(root, "released-versions.json");
  await writeFile(registry, "[]\n");
  const before = await readFile(registry);
  const marker = path.join(root, "tar-called");
  const tar = path.join(root, "tar");
  await writeFile(tar, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called'); process.exit(1);\n`);
  await chmod(tar, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${root}${path.delimiter}${oldPath}`;
  try {
    const badDigest = transport(Buffer.from("not tar"), { digest: toolkit.contentHash });
    await assert.rejects(recordRelease(toolkit.version, { root, ...badDigest }), /digest mismatch/);
    await assert.rejects(stat(marker), { code: "ENOENT" });
    await badDigest.cleaned();
    const tarFailure = transport(archiveOf([manifestEntry()]));
    await assert.rejects(recordRelease(toolkit.version, { root, ...tarFailure }), /Command failed/);
    assert.equal(await readFile(marker, "utf8"), "called");
    await tarFailure.cleaned();
    assert.deepEqual(await readFile(registry), before);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("the public resolver rejects nonpublication evidence before download or registry write", async (t) => {
  const root = await scratch(t);
  const registry = path.join(root, "released-versions.json");
  await writeFile(registry, "[]\n");
  const before = await readFile(registry);
  const asset = { name: "artifact-migration-tools-v0.0.1.tar.gz", digest: toolkit.contentHash };
  const release = { tag_name: "v0.0.1", draft: false, prerelease: false, immutable: true, assets: [asset] };
  for (const changed of [null, { draft: true }, { prerelease: true }, { immutable: false },
    { tag_name: "v9.9.9" }, { assets: [] }, { assets: [asset, asset] }, { assets: [{ ...asset, digest: "bad" }] }]) {
    let downloads = 0;
    await assert.rejects(recordRelease(toolkit.version, {
      root,
      resolve: (version) => resolveRelease(version, { api: async () => {
        if (changed === null) throw new Error("release not found");
        return { value: { ...release, ...changed }, viaGh: false };
      } }),
      download: async () => { downloads++; },
    }));
    assert.equal(downloads, 0);
    assert.deepEqual(await readFile(registry), before);
  }
  for (const version of [undefined, "v1.3.0", "1.3", "1.3.0-beta", "01.3.0"]) {
    await assert.rejects(recordRelease(version, { root, resolve: async () => assert.fail("resolver called") }), /exact X.Y.Z/);
  }
  await assert.rejects(execFileAsync(process.execPath, [path.join(repositoryRoot, "scripts/release.mjs"), "--record", "0.0.1", "extra"]),
    (error) => error.code === 1 && /Usage/.test(error.stderr));
});
