/** Formats: record-layout names and vocabulary both record kinds share. */

/** The append-only audit log of both record kinds, relative to the record root. */
export const HISTORY_FILE = "history/history.ndjson";

// P1-1: the integrity anchor for `artifactHashes`, persisted outside
// `state.json` so pinning an artifact and rewriting its pin stop being the
// same edit. Written in the same journalled transaction as every advance
// (and at initialization); never read or written anywhere else.
export const INTEGRITY_FILE = "integrity.json";

// ponytail: keep the audit split explicit; absence remains the default.
export const PONYTAIL_TARGETS = {
  full: { audit: false },
  "full-audit": { audit: true },
};

const isPonytailTarget = (value) =>
  Object.hasOwn(PONYTAIL_TARGETS, value ?? "");

export const assertPonytailTarget = (value) => {
  if (!isPonytailTarget(value)) {
    throw new Error(
      `Invalid Ponytail target '${String(value)}'. Use ${Object.keys(PONYTAIL_TARGETS).join(" or ")}.`,
    );
  }
  return value;
};
