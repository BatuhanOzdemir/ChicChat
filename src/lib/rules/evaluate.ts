/**
 * Pure rule evaluation (SPEC.md §3): `evaluate(condition, context) -> action`.
 *
 * Evaluation never throws on missing data — a condition referencing a field
 * that isn't present (e.g. a computed field with no integration) simply doesn't
 * match, so the case still forms and routes with less context (§2 degradation).
 */
import type {
  Comparison,
  Condition,
  ConditionGroup,
  Rule,
  RuleAction,
  RuleContext,
} from "./types";

function isGroup(condition: Condition): condition is ConditionGroup {
  return (
    typeof condition === "object" &&
    condition !== null &&
    ("all" in condition || "any" in condition || "not" in condition)
  );
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isNaN(value) ? null : value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function resolveExpected(cmp: Comparison, ctx: RuleContext): unknown {
  return cmp.ref !== undefined ? ctx.config?.[cmp.ref] : cmp.value;
}

function evaluateComparison(cmp: Comparison, ctx: RuleContext): boolean {
  const actual = ctx.fields[cmp.field];

  if (cmp.op === "present") return isPresent(actual);
  if (cmp.op === "absent") return !isPresent(actual);

  const expected = resolveExpected(cmp, ctx);

  switch (cmp.op) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "nin":
      return Array.isArray(expected) && !expected.includes(actual);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = toNumber(actual);
      const e = toNumber(expected);
      if (a === null || e === null) return false;
      if (cmp.op === "gt") return a > e;
      if (cmp.op === "gte") return a >= e;
      if (cmp.op === "lt") return a < e;
      return a <= e;
    }
    default:
      return false;
  }
}

/** Evaluate a condition tree to a boolean. Empty `all` groups match. */
export function evaluateCondition(
  condition: Condition,
  ctx: RuleContext,
): boolean {
  if (isGroup(condition)) {
    if (condition.all)
      return condition.all.every((c) => evaluateCondition(c, ctx));
    if (condition.any)
      return condition.any.some((c) => evaluateCondition(c, ctx));
    if (condition.not) return !evaluateCondition(condition.not, ctx);
    return true;
  }
  return evaluateComparison(condition, ctx);
}

function toAction(rule: Rule): RuleAction {
  return {
    action_type: rule.action_type,
    target_queue: rule.target_queue ?? null,
    priority: rule.priority ?? null,
    auto_resolve: rule.auto_resolve ?? false,
  };
}

/** Evaluate a single rule: its action when the condition matches, else null. */
export function evaluate(rule: Rule, ctx: RuleContext): RuleAction | null {
  return evaluateCondition(rule.condition, ctx) ? toAction(rule) : null;
}

/** Actions of every matching rule, in input order. */
export function evaluateRules(rules: Rule[], ctx: RuleContext): RuleAction[] {
  return rules
    .filter((rule) => evaluateCondition(rule.condition, ctx))
    .map(toAction);
}
