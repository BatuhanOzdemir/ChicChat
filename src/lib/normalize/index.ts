/**
 * The normalization layer (SPEC.md §2) — core product IP, framework-free and
 * unit-testable. Runs on every captured field so the agent never re-cleans.
 */
export {
  normalizeOrderNumber,
  type NormalizeOrderNumberOptions,
  type OrderNumberResult,
} from "./order-number";
export {
  constrainEnum,
  type ConstrainEnumOptions,
  type EnumResult,
} from "./enums";
export { normalizeText } from "./text";
