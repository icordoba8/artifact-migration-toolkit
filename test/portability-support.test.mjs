import assert from "node:assert/strict";
import test from "node:test";
import { replaceSerializedPath } from "../packages/migration-engine/test/support/serialized-path.mjs";

test("serialized Windows paths are changed, and absent paths fail closed", () => {
  const original = 'args = ["C:\\\\Users\\\\RUNNER~1\\\\engine.mjs"]';
  assert.equal(
    replaceSerializedPath(original, 'C:\\Users\\RUNNER~1\\engine.mjs', '/foreign'),
    'args = ["/foreign"]',
  );
  assert.throws(() => replaceSerializedPath(original, '/missing', '/foreign'), /not found/);
});
