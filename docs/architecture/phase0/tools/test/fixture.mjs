// Test helpers: throwaway engine repositories and tool runs with an allowlisted environment.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TOOLKIT = path.resolve(TOOLS, "../../../..");
export const DATA = path.resolve(TOOLS, "../data");
export const BASE = "05e604992f10b239753a74246a9ac5a45d9b2fed";

export const tmp = () => mkdtempSync(path.join(tmpdir(), "phase0-tools-"));
const ENV = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

// Runs tools/<name> (or an absolute script path) with only PATH and git isolation in the environment.
export const tool = (name, args, { env = {} } = {}) => {
  const r = spawnSync(process.execPath, [path.isAbsolute(name) ? name : path.join(TOOLS, name), ...args], { encoding: "utf8", env: { ...ENV, ...env }, maxBuffer: 1 << 28 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

// A one-commit git repo with { "a.mjs": text } under packages/migration-engine/src.
export const engineRepo = (files) => {
  const dir = tmp();
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, "packages/migration-engine/src", name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { env: ENV, stdio: "pipe" });
  git("init", "-q"); git("add", "."); git("commit", "-q", "-m", "fixture");
  return dir;
};

export const writeTsv = (rows, name = "f.tsv") => {
  const file = path.join(tmp(), name);
  writeFileSync(file, rows.map((r) => (Array.isArray(r) ? r.join("\t") : r)).map((l) => `${l}\n`).join(""));
  return file;
};
export const rowsOf = (stdout) => stdout.trim().split("\n").filter(Boolean).map((l) => l.split("\t"));

export const hasBase = () => spawnSync("git", ["-C", TOOLKIT, "cat-file", "-e", `${BASE}^{commit}`], { env: ENV }).status === 0;

// Every dataset regenerated from BASE with the tools under test, once per process.
let base;
export const baseData = () => {
  if (base) return base;
  const dir = tmp(), out = {};
  const save = (name, r) => {
    if (r.status !== 0 || r.stderr) throw new Error(`${name} failed at BASE (${r.status}): ${r.stderr}`);
    writeFileSync(path.join(dir, name), r.stdout);
    out[name] = path.join(dir, name);
  };
  for (const mode of ["decls", "writes", "imports", "fv"]) save(`${mode}.tsv`, tool("inventory.mjs", [TOOLKIT, BASE, mode]));
  save("edges.tsv", tool("callgraph.mjs", [TOOLKIT, BASE]));
  save("owners.tsv", tool("assign.mjs", [out["decls.tsv"], "a"]));
  save("owners-b.tsv", tool("assign.mjs", [out["decls.tsv"], "b"]));
  return (base = out);
};
