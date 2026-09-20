import { defineConfig } from "vitest/config";

// The only Vitest suites in this repository are the two TypeScript artifact
// filesystem/recovery specs. Everything else is `node:test`; see README.
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/migration-engine/test/**/*.spec.ts"],
    // These specs drive real artifact records, and every mutation is refused
    // until a toolkit is explicitly adopted -- a source checkout has no identity
    // to adopt. So the run installs a real fixture `build-identity.json` and is
    // an identified toolkit, exactly as `scripts/engine-test.mjs` does for the
    // node:test suites. There is no in-process seam that fabricates one.
    globalSetup: ["packages/migration-engine/test/support/vitest-identity.ts"],
  },
});
