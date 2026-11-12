#!/usr/bin/env node
/**
 * G2 (I4): binds an operator's screen recording to one native acceptance run by its file times.
 * Usage: acceptance-recording.mjs <output> <video>
 * Records path, size, SHA-256 and birth/modify times against the run's launch window; a recording
 * that does not provably cover the window is UNBOUND, and an UNBOUND recording never counts for a
 * native row (A8). The video itself is never copied. Review of its content stays human.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const fail = message => { process.stderr.write("ACCEPTANCE_RECORDING_ERROR: " + message + "\n"); process.exit(1); };
const argv = process.argv.slice(2);
if (argv.length !== 2) fail("usage: acceptance-recording.mjs <output> <video>");
const output = await realpath(argv[0]).catch(() => fail("no such run output: " + argv[0]));
const report = await readFile(path.join(output, "report.json"), "utf8").then(JSON.parse, () => fail("the run's report.json is missing"));
if (report.ui !== "native" || !report.native?.nonce || !report.launch?.startedAt || !report.launch?.endedAt)
  fail("not a launched native run: a recording binds only to a native report with a launch window");
const video = await realpath(argv[1]).catch(() => fail("no such recording: " + argv[1]));
const info = await stat(video);
if (!info.isFile()) fail("the recording is not a regular file");
const hash = createHash("sha256");
for await (const chunk of createReadStream(video)) hash.update(chunk);
// ponytail: file times are the only binding; Windows times over /mnt/c can be coarse. Content review stays human.
const startedAt = Date.parse(report.launch.startedAt), endedAt = Date.parse(report.launch.endedAt);
const born = info.birthtimeMs > 0 ? info.birthtimeMs : null;
const binding = born !== null && born <= startedAt && info.mtimeMs >= endedAt ? "BOUND" : "UNBOUND";
const recording = {
  video, size: info.size, sha256: hash.digest("hex"),
  birthtime: born === null ? null : new Date(born).toISOString(), mtime: info.mtime.toISOString(),
  window: { startedAt: report.launch.startedAt, endedAt: report.launch.endedAt }, nonce: report.native.nonce,
  binding, countsForNativeRow: binding === "BOUND",
  reviewRequired: ["nonce visible", "terminal window", "single invocation"],
  attestation: "AGENT_RELAYED",
};
await writeFile(path.join(output, "recording.json"), JSON.stringify(recording, null, 2) + "\n", { flag: "wx" })
  .catch(error => fail(error.code === "EEXIST" ? "recording.json already exists; never overwrite evidence" : error.message));
process.stdout.write(JSON.stringify({ recording: path.join(output, "recording.json"), binding }) + "\n");
