import assert from "node:assert/strict";

// Provider TOML emits JSON-compatible quoted strings. Target the encoded value,
// so a Windows backslash path cannot silently leave a negative fixture intact.
export const replaceSerializedPath = (text, oldPath, newPath) => {
  const encoded = (value) => JSON.stringify(value).slice(1, -1);
  const before = encoded(oldPath);
  assert.ok(text.includes(before), `serialized path was not found: ${oldPath}`);
  const changed = text.replace(before, encoded(newPath));
  assert.notEqual(changed, text, "path tampering must change the configuration");
  return changed;
};
