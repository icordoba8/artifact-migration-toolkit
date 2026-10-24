// Independent reference verifier for the slugify fixture (v1.6.2 M12 code-changing acceptance).
// Expected values are hand-derived from the legacy contract, not computed from the legacy code.
// argv[2] = target root, argv[3] = report dir. Exit 0 only if every case matches.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [root, reportDir] = process.argv.slice(2);
if (!root || !reportDir) { console.error("usage: verify.mjs <target-root> <report-dir>"); process.exit(2); }
const file = path.join(root, process.argv[4] ?? "src/utils/slugify.js");
const cases = [
  ["Hello World", undefined, "hello-world"],
  ["  Hello,   World!  ", undefined, "hello-world"],
  ["Crème Brûlée", undefined, "creme-brulee"],
  ["Ünïcödé Ståff", undefined, "unicode-staff"],
  ["ﬁne print", undefined, "fine-print"],
  ["Rock & Roll", undefined, "rock-and-roll"],
  ["Don't Stop", undefined, "dont-stop"],
  ["It’s here", undefined, "its-here"],
  ["émoji 🎉 party", undefined, "emoji-party"],
  ["line\none\ttwo", undefined, "line-one-two"],
  ["UPPER lower 123", undefined, "upper-lower-123"],
  ["already-slugged", undefined, "already-slugged"],
  ["---", undefined, ""],
  ["", undefined, ""],
  [null, undefined, ""],
  [undefined, undefined, ""],
  [12345, undefined, "12345"],
  ["A B", null, "a-b"],
  ["Hello World", { separator: "_" }, "hello_world"],
  ["a b c", { separator: "" }, "abc"],
  ["The quick brown fox", { maxLength: 10 }, "the-quick"],
  ["The quick brown fox", { maxLength: 12 }, "the-quick-br"],
  ["The quick brown fox", { maxLength: 100 }, "the-quick-brown-fox"],
  ["abc", { maxLength: 0 }, ""],
  ["abc", { maxLength: -1 }, "abc"],
  ["abcdefgh", { maxLength: "3" }, "abcdefgh"],
  ["foo bar", { separator: "--", maxLength: 5 }, "foo"],
];
const encoded = JSON.stringify(cases.map(([input, options]) => [input === undefined ? { u: 1 } : { v: input },
  options === undefined ? { u: 1 } : { v: options }]));
// The target's code runs in a child process; CommonJS and ESM shapes both load through import().
const child = `
const m = await import(${JSON.stringify(pathToFileURL(file).href)});
const fn = [m.default, m.slugify, m.default && m.default.slugify].find(f => typeof f === "function");
if (!fn) { console.log(JSON.stringify({ error: "no callable slugify export" })); process.exit(0); }
const out = ${encoded}.map(([i, o]) => { const a = [i.u ? undefined : i.v]; if (!o.u) a.push(o.v);
  try { return { ok: fn(...a) }; } catch (e) { return { threw: String(e) }; } });
console.log(JSON.stringify({ out }));`;
let results;
try {
  if (!existsSync(file)) throw new Error("missing " + file);
  const raw = execFileSync(process.execPath, ["--input-type=module", "-e", child], { cwd: root, encoding: "utf8", timeout: 30000 });
  const parsed = JSON.parse(raw.trim().split("\n").pop());
  if (parsed.error) throw new Error(parsed.error);
  results = cases.map(([input, options, expected], k) => ({ input: String(input), options, expected,
    actual: parsed.out[k], pass: parsed.out[k].ok === expected }));
} catch (error) {
  results = [{ error: error.message, pass: false }];
}
const passed = results.filter(r => r.pass).length;
mkdirSync(reportDir, { recursive: true });
writeFileSync(path.join(reportDir, "verifier-result.json"), JSON.stringify({ file, passed, total: cases.length, results }, null, 2) + "\n");
for (const r of results.filter(r => !r.pass)) console.log("FAIL", JSON.stringify(r));
console.log(`${passed}/${cases.length} ${passed === cases.length ? "PASS" : "FAIL"}`);
process.exit(passed === cases.length ? 0 : 1);
