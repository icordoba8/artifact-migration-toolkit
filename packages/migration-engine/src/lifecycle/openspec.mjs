/**
 * Lifecycle: OpenSpec lifecycle authority -- loading, proposal validation and
 * the current-authority check. Moved verbatim from `resumable-migration.mjs`
 * (Track A8).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { requirementsSourceFor, validateOpenSpecAuthorityShape } from "../formats/index.mjs";
import { contentIdentity, isResolvedWithin as isWithin } from "../shared/index.mjs";
import { contentIdentityMatchesSource } from "../store/index.mjs";

const OPEN_SPEC_REQUIREMENT =
  /^### Requirement: ([A-Z][A-Z0-9]*-REQ-\d{3,})(?:\s+.+)?$/;

const OPEN_SPEC_SCENARIO =
  /^#### Scenario: ([A-Z][A-Z0-9]*-SCN-\d{3,})(?:\s+.+)?$/;

const parseOpenSpec = (content, source) => {
  const requirementIds = [];
  const scenarioIds = [];
  const seen = new Set();
  let current = null;

  const finishRequirement = () => {
    if (!current) return;
    if (!current.normative) {
      throw new Error(
        `OpenSpec requirement '${current.id}' in ${source} must use SHALL or MUST.`,
      );
    }
    if (current.scenarios === 0) {
      throw new Error(
        `OpenSpec requirement '${current.id}' in ${source} requires a scenario.`,
      );
    }
  };

  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("### Requirement:")) {
      finishRequirement();
      const match = line.match(OPEN_SPEC_REQUIREMENT);
      if (!match) {
        throw new Error(
          `OpenSpec requirement headings in ${source} must start with a stable <CAPABILITY>-REQ-<NNN> id.`,
        );
      }
      const id = match[1];
      if (seen.has(id)) throw new Error(`OpenSpec repeats id '${id}'.`);
      seen.add(id);
      requirementIds.push(id);
      current = { id, normative: false, scenarios: 0 };
      continue;
    }
    if (line.startsWith("#### Scenario:")) {
      if (!current) {
        throw new Error(`OpenSpec scenario in ${source} has no requirement.`);
      }
      const match = line.match(OPEN_SPEC_SCENARIO);
      if (!match) {
        throw new Error(
          `OpenSpec scenario headings in ${source} must start with a stable <CAPABILITY>-SCN-<NNN> id.`,
        );
      }
      const id = match[1];
      if (seen.has(id)) throw new Error(`OpenSpec repeats id '${id}'.`);
      seen.add(id);
      scenarioIds.push(id);
      current.scenarios += 1;
      continue;
    }
    if (current && /\b(?:SHALL|MUST)\b/.test(line)) {
      current.normative = true;
    }
  }
  finishRequirement();
  if (requirementIds.length === 0) {
    throw new Error(
      `OpenSpec source ${source} requires at least one requirement.`,
    );
  }
  return { requirementIds, scenarioIds };
};

export const loadOpenSpecAuthority = async (targetRoot, targetModule) => {
  const source = requirementsSourceFor(targetModule);
  const filePath = path.resolve(targetRoot, source);
  if (!isWithin(targetRoot, filePath)) {
    throw new Error("Requirements source escapes the target repository.");
  }
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Required OpenSpec source does not exist: ${source}`);
    }
    throw error;
  }
  return {
    kind: "openspec",
    source,
    digest: contentIdentity(source, content),
    ...parseOpenSpec(content, source),
  };
};

export const validateOpenSpecProposal = (content, targetModule) => {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("The in-memory OpenSpec proposal must be non-empty.");
  }
  const source = requirementsSourceFor(targetModule);
  return {
    content,
    authority: {
      kind: "openspec",
      source,
      digest: contentIdentity(source, content),
      ...parseOpenSpec(content, source),
    },
  };
};

export const assertCurrentOpenSpecAuthority = async (targetRoot, state) => {
  const recorded = validateOpenSpecAuthorityShape(
    state.requirementsAuthority,
    state.targetModule,
  );
  const current = await loadOpenSpecAuthority(targetRoot, state.targetModule);
  // The digest is a file identity, so a checkout that only re-spelled the
  // spec's line endings is not a changed authority. Verify that one field
  // through the shared matcher and, when it still holds, carry the *recorded*
  // digest into the comparison projection -- every other field is compared
  // exactly as before, and the record on disk is left untouched. This also
  // keeps every `boundTo.requirementsDigest` in existing evidence valid,
  // since it was bound to that recorded spelling.
  const comparable =
    recorded.digest !== current.digest &&
    (await contentIdentityMatchesSource(
      recorded.digest,
      targetRoot,
      current.source,
    ))
      ? { ...current, digest: recorded.digest }
      : current;
  if (JSON.stringify(recorded) !== JSON.stringify(comparable)) {
    throw new Error(
      `OpenSpec authority changed for '${state.targetModule}'. Revalidate requirements before resuming.`,
    );
  }
  return comparable;
};
