/**
 * The rule engine (SPEC.md §3) — pure, framework-free condition evaluation and
 * the `within_return_window` computed-field helper.
 */
export { evaluate, evaluateCondition, evaluateRules } from "./evaluate";
export { isWithinReturnWindow } from "./window";
export type {
  Comparison,
  ComparisonOp,
  Condition,
  ConditionGroup,
  ActionType,
  Rule,
  RuleAction,
  RuleContext,
} from "./types";
