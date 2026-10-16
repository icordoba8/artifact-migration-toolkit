/** Shared: value shape validators, the safe-name rule and the ISO clock. */

import { canonicalJson } from "./digest.mjs";

export const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const assertPlainObject = (value, label) => {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  return value;
};

export const assertArray = (value, label) => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
};

export const assertNonEmpty = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
};

export const assertBoolean = (value, label) => {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
};

export const assertUniqueIds = (rows, label) => {
  const ids = new Set();
  for (const [index, row] of rows.entries()) {
    assertPlainObject(row, `${label}[${index}]`);
    const id = assertNonEmpty(row.id, `${label}[${index}].id`);
    if (ids.has(id)) throw new Error(`${label} repeats id '${id}'.`);
    ids.add(id);
  }
  return ids;
};

export const now = () => new Date().toISOString();

export const assertIsoTimestamp = (value, label) => {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO 8601 timestamp.`);
  }
  return value;
};

const SAFE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const assertSafeName = (value, label = "module") => {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) {
    throw new Error(
      `Invalid ${label} '${String(value)}'. Use lowercase letters, digits, and single hyphens.`,
    );
  }
  return value;
};

export const exactObject = (value, label, required, optional = []) => {
  assertPlainObject(value, label);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown key(s): ${unknown.join(", ")}.`);
  }
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw new Error(`${label} is missing key(s): ${missing.join(", ")}.`);
  }
  return value;
};

export const versionOne = (value, label) => {
  if (value !== 1) throw new Error(`${label}.version must be 1.`);
};

export const unique = (values, label) => {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} repeats '${value}'.`);
    seen.add(value);
  }
  return seen;
};

export const sameMembers = (actual, expected, label) => {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new Error(`${label} must be exactly [${right.join(", ")}].`);
  }
};

/**
 * QW3. Checks that do not depend on one another run together, and every
 * failure is reported by one refusal instead of one refusal per run. `check`
 * records a thrown refusal against its field and returns false, so the caller
 * can skip only the checks that depended on it. Issues with the same `cause`
 * (one stale binding shared by every evidence entry) are reported once, naming
 * every field. Nothing here ever accepts: one recorded issue is a refusal.
 */
const MAX_REPORTED_ISSUES = 25;

export const issueCollector = () => {
  const issues = [];
  const add = (field, message, { code = "INVALID", cause } = {}) => {
    issues.push({ field, code, message, cause: cause ?? `${field}\u0000${message}` });
  };
  const check = async (field, run, options = {}) => {
    try {
      await run();
      return true;
    } catch (error) {
      add(field, error.message, { ...options, code: error.validationCode ?? options.code });
      return false;
    }
  };
  return { issues, add, check };
};

/**
 * Throws the collected issues as one error, or returns when there are none. A
 * single issue keeps its exact message; several are numbered in check order,
 * bounded at MAX_REPORTED_ISSUES, and also carried as `validationIssues`.
 */
export const throwIssues = (artifact, issues) => {
  if (issues.length === 0) return;
  const grouped = new Map();
  for (const { field, code, message, cause } of issues) {
    const known = grouped.get(cause);
    if (known) known.fields.push(field);
    else grouped.set(cause, { artifact, code, fields: [field], message });
  }
  const all = [...grouped.values()];
  const reported = all.slice(0, MAX_REPORTED_ISSUES);
  const also = ({ fields }) => (fields.length > 1 ? ` [same cause at ${fields.slice(1).join(", ")}]` : "");
  const message =
    all.length === 1
      ? `${reported[0].message}${also(reported[0])}`
      : `${artifact} has ${all.length} independent problems, all reported by this run: ` +
        reported.map((issue, index) => `(${index + 1}) ${issue.message}${also(issue)}`).join(" ") +
        (all.length > reported.length ? ` (+${all.length - reported.length} more not listed)` : "");
  throw Object.assign(new Error(message), { validationIssues: reported });
};
