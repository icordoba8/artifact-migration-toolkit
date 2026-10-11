// Compatibility re-export (Track A2): the format-upgrade primitives now live in
// formats/ (`formats/upgrade.mjs`, reached through `formats/index.mjs`).
// Compatibility re-export (Track A2): these names are formats-owned now.
export {
  assertRegistryCoverage,
  classifyUpgrade,
  nextIncrement,
  upgradeIsActive,
  upgradeProjection,
} from "./formats/index.mjs";
