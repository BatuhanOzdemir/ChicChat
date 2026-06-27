/**
 * Rule-engine types (SPEC.md §3). A rule is condition(s) -> action. Conditions
 * reference captured fields, computed fields, and merchant config. These shapes
 * match the `routing_rules.condition` jsonb seeded in Step 2.
 */

export type ComparisonOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "nin"
  | "present"
  | "absent";

/** A single comparison against one field in the evaluation context. */
export interface Comparison {
  field: string;
  op: ComparisonOp;
  /** Literal comparison value. */
  value?: unknown;
  /** Resolve the comparison value from merchant config instead (e.g. "refund_sla_days"). */
  ref?: string;
}

/** Boolean composition of conditions. Exactly one of all/any/not is used. */
export interface ConditionGroup {
  all?: Condition[];
  any?: Condition[];
  not?: Condition;
}

export type Condition = Comparison | ConditionGroup;

export type ActionType =
  | "route"
  | "auto_reply"
  | "request_info"
  | "escalate"
  | "auto_resolve";

/** The outcome of a matching rule. */
export interface RuleAction {
  action_type: ActionType;
  target_queue: string | null;
  priority: string | null;
  auto_resolve: boolean;
}

/** A rule as stored in `routing_rules` (condition + flattened action fields). */
export interface Rule {
  condition: Condition;
  action_type: ActionType;
  target_queue?: string | null;
  priority?: string | null;
  auto_resolve?: boolean;
}

/**
 * Inputs to evaluation. `fields` holds captured + computed values; computed
 * fields absent in zero-integration mode are simply missing (-> conditions on
 * them don't match, per the §2 degradation rule). `config` holds merchant
 * settings referenced via `ref`.
 */
export interface RuleContext {
  fields: Record<string, unknown>;
  config?: Record<string, unknown>;
}
