/**
 * The intake state machine (CLAUDE.md Step 5) — taxonomy-driven, Tier-0,
 * framework-free, plus a local message simulator for driving it without WhatsApp.
 */
export { startIntake, advance } from "./machine";
export { inactivityAction } from "./inactivity";
export type {
  InactivityAction,
  InactivityThresholds,
  SessionLifecycle,
  SessionTiming,
} from "./inactivity";
export { simulateIntake } from "./simulator";
export type { SimulationScript, SimulationResult } from "./simulator";
export type {
  CategoryDef,
  FieldDef,
  FieldType,
  IntakeCase,
  IntakeConfig,
  IntakeSession,
  IntakeState,
  IntakeStatus,
  Option,
  Prompt,
} from "./types";
