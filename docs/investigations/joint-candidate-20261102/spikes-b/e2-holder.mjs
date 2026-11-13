import { acquireModuleLock } from "../../../../packages/migration-engine/src/lifecycle/lock.mjs";
import { spawn } from "node:child_process";
await acquireModuleLock(process.argv[2], "auth");
spawn("sleep", ["61"], { detached: true, stdio: "ignore" }).unref();
console.log("HELD");
setInterval(() => {}, 1000);
