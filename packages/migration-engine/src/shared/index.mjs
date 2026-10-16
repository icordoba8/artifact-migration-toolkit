/**
 * Shared: leaf primitives below every other module (Track A1).
 *
 * Domain-neutral and import-time side-effect free: paths, hashing and content
 * identity, canonical JSON, shape validators and read-only git queries. No
 * file in `shared/` writes to the filesystem or imports an engine module.
 * Importers outside `shared/` use this file only.
 */
export {
  canonicalJson,
  CONTENT_IDENTITY_BYTES,
  CONTENT_IDENTITY_TEXT,
  contentIdentity,
  contentIdentityMatches,
  isContentIdentity,
  isTextIdentityEligible,
  jsonBytes,
  jsonBytesEqual,
  parseContentIdentity,
  sha256Hex,
  sha256Json,
} from "./digest.mjs";
export {
  commitsIntroducingBlob,
  commitsTouchingSince,
  committedChangesSince,
  dirtyManifest,
  execFileAsync,
  fileAtRevision,
  gitRevision,
  headRevision,
  isAncestorCommit,
} from "./git.mjs";
export {
  assertProjectRootContainment,
  assertSecurePath,
  commonAncestor,
  isLexicallyWithin,
  normalizeRelative,
  portablePath,
  recordRelative,
  sameFile,
  samePath,
  withoutExtension,
} from "./paths.mjs";
export {
  assertArray,
  assertBoolean,
  assertIsoTimestamp,
  assertNonEmpty,
  assertPlainObject,
  assertSafeName,
  assertUniqueIds,
  exactObject,
  isPlainObject,
  issueCollector,
  now,
  sameMembers,
  throwIssues,
  unique,
  versionOne,
} from "./values.mjs";
