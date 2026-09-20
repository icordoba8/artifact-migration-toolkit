// Attribution, not disambiguation.
//
// Both legacy sources live in one repository, so a `<source>:<path>` evidence
// qualifier would resolve against the same root and disambiguate nothing --
// `resolveEvidencePath` already finds the right bytes for any repo-relative
// claim. What the engine could not do was answer *which source* a piece of
// evidence belongs to, which is what every per-source cardinality and coverage
// rule needs. These cover that function and the disjointness it depends on.
//
// The fixture is a synthetic pair with the same multi-root and basename-collision shape: two
// multi-root sources whose full repo-relative paths cannot collide, and whose
// basenames (`page.tsx`, `index.ts`) very much can.

import assert from "node:assert/strict";
import test from "node:test";

import { sourceOfEvidence } from "../../src/resumable-migration.mjs";

const SOURCES = ["catalog-source", "catalog-target"];

/** Multi-root sources, the shape `inventories/module-classification.json` holds. */
const CLASSIFICATION = {
  moduleRoots: [
    {
      path: "src/components/catalog-target",
      reason: "The visible UI slice being migrated.",
      decisionId: null,
      source: "catalog-target",
    },
    {
      path: "src/services/catalog-target.service.ts",
      reason: "The data access the table depends on.",
      decisionId: "DEC-1",
      source: "catalog-target",
    },
    {
      path: "src/components/catalog-source",
      reason: "The planning support slice.",
      decisionId: null,
      source: "catalog-source",
    },
  ],
};

test("a claim attributes to the one source whose root contains it", () => {
  assert.equal(
    sourceOfEvidence(
      "src/components/catalog-target/page.tsx",
      CLASSIFICATION,
      SOURCES,
    ),
    "catalog-target",
  );
  // A shared basename under a different root is a different source: paths, not
  // file names, are what attribution reads.
  assert.equal(
    sourceOfEvidence(
      "src/components/catalog-source/page.tsx",
      CLASSIFICATION,
      SOURCES,
    ),
    "catalog-source",
  );
  // A source is the union of its roots, so a second root needs no extra
  // machinery -- including a root that is a file rather than a directory.
  assert.equal(
    sourceOfEvidence(
      "src/services/catalog-target.service.ts",
      CLASSIFICATION,
      SOURCES,
    ),
    "catalog-target",
  );
});

test("a claim under no declared root attributes to nothing", () => {
  assert.equal(
    sourceOfEvidence(
      "src/components/shared/catalog-detail/index.ts",
      CLASSIFICATION,
      SOURCES,
    ),
    null,
  );
  // A prefix that is not a path boundary must not match.
  assert.equal(
    sourceOfEvidence(
      "src/components/catalog-target-legacy/page.tsx",
      CLASSIFICATION,
      SOURCES,
    ),
    null,
  );
});

test("a single-source record needs no source field, and a bare string root still reads", () => {
  const classification = {
    moduleRoots: [
      { path: "src/features/auth", reason: "The module's own slice." },
      "src/legacy/auth-shell",
    ],
  };
  for (const claim of [
    "src/features/auth/index.ts",
    "src/legacy/auth-shell/page.tsx",
  ]) {
    assert.equal(sourceOfEvidence(claim, classification, ["auth"]), "auth");
  }
  // With more than one declared source the field is not optional, so an entry
  // that omits it attributes to nothing rather than guessing.
  assert.equal(
    sourceOfEvidence("src/features/auth/index.ts", classification, SOURCES),
    null,
  );
});
