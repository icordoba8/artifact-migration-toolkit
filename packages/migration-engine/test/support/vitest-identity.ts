// Vitest's half of what `scripts/engine-test.mjs` does for the node:test
// suites: install the fixture identity for the run, remove it after.
//
// @ts-expect-error -- the engine is untyped .mjs; this file only needs the two
// functions, and adding declarations for it would be scaffolding for nothing.
import { installFixtureIdentity, removeFixtureIdentity } from "./fixture-identity.mjs";

export const setup = async () => {
  await installFixtureIdentity();
};

export const teardown = async () => {
  await removeFixtureIdentity();
};
