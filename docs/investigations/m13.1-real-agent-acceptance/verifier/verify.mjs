// Independent behavior verifier for the strings.cjs -> src/utils/strings.js
// migration. The contract (contract.json) was captured from the legacy module
// before the agent ran. argv[2] = consumer root. Exit 0 only if every check passes.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const here = path.dirname(new URL(import.meta.url).pathname);
const contract = JSON.parse(readFileSync(path.join(here, "contract.json"), "utf8"));
const root = path.resolve(process.argv[2] ?? ".");
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), ...(ok ? {} : { detail }) });
let target, entry;
try { target = await import(pathToFileURL(path.join(root, "src/utils/strings.js")).href); }
catch (error) { check("target imports as ESM", false, String(error.message).split("\n")[0]); }
try { entry = await import(pathToFileURL(path.join(root, "src/index.js")).href); }
catch (error) { check("entry imports", false, String(error.message).split("\n")[0]); }
if (target && entry) {
  check("target imports as ESM", true);
  check("entry imports", true);
  const named = Object.keys(target).filter((key) => key !== "default").sort();
  check("named exports", contract.exports.every((name) => named.includes(name)), named);
  check("entry re-exports the same bindings", contract.exports.every((name) => entry[name] === target[name]));
  check("VERSION", target.VERSION === contract.version, target.VERSION);
  for (const row of contract.rows) {
    let actual;
    try { actual = target[row.fn](...structuredClone(row.args)); } catch (error) { actual = `THREW ${error.name}`; }
    check(`${row.fn}(${JSON.stringify(row.args).slice(1, -1)})`, actual === row.expected, { expected: row.expected, actual });
  }
  for (const row of contract.throws) {
    let thrown = null;
    try { target[row.fn](...row.args); } catch (error) { thrown = error?.constructor?.name; }
    check(`${row.fn}(${JSON.stringify(row.args).slice(1, -1)}) throws ${row.error}`, thrown === row.error, thrown);
  }
}
const passed = results.filter((row) => row.ok).length;
console.log(JSON.stringify({ passed, total: results.length, failed: results.filter((row) => !row.ok) }, null, 1));
process.exit(passed === results.length && results.length > 0 ? 0 : 1);
