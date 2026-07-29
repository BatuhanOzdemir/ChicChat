/**
 * Turning matched routing rules into a case's queue, priority and status
 * (SPEC §3 → §9) — pure, so "why did this case land in that queue?" is
 * answerable from a unit test rather than from production data.
 *
 * Precedence is **first match wins**: rules are evaluated in the merchant's
 * configured order and the first one that matches decides the queue, the
 * priority and the resulting status. Later matches are still reported, so the
 * console can show the agent what else applied without silently compounding
 * decisions. When nothing matches, the case stays `open` in the unrouted queue
 * — including the Tier-0 case where rules reference computed fields no
 * integration has supplied yet (SPEC §2 degradation).
 */
import { evaluateCondition } from "../rules";
import type { Rule, RuleContext } from "../rules";
import { constrainPriority, type CaseStatus, type Priority } from "./workflow";

/** A rule as stored, plus the label the editor gives it (SPEC §8). */
export interface LabelledRule extends Rule {
  id?: string;
  label?: string | null;
}

export interface RoutingDecision {
  /** Target queue, or null for the unrouted/general queue. */
  queue: string | null;
  priority: Priority;
  /** The status the case is created with. */
  status: CaseStatus;
  /** The rule that decided, then any others that also matched, in order. */
  matched: { id: string | null; label: string; action_type: string }[];
}

export const UNROUTED_QUEUE_LABEL = "unrouted";

/** Status implied by a rule's action. Unknown actions leave the case open. */
function statusFor(actionType: string): CaseStatus {
  if (actionType === "escalate") return "escalated";
  if (actionType === "request_info") return "needs_info";
  return "open";
}

function describe(
  rule: LabelledRule,
  index: number,
): {
  id: string | null;
  label: string;
  action_type: string;
} {
  return {
    id: rule.id ?? null,
    label: rule.label?.trim() || `rule ${index + 1}`,
    action_type: rule.action_type,
  };
}

export function decideRouting(
  rules: readonly LabelledRule[],
  ctx: RuleContext,
): RoutingDecision {
  const matched = rules
    .map((rule, index) => ({ rule, described: describe(rule, index) }))
    .filter(({ rule }) => evaluateCondition(rule.condition, ctx));

  const described = matched.map((m) => m.described);
  const winner = matched[0]?.rule;

  if (!winner) {
    return { queue: null, priority: "normal", status: "open", matched: [] };
  }

  return {
    queue: winner.target_queue?.trim() || null,
    priority: constrainPriority(winner.priority),
    status: statusFor(winner.action_type),
    matched: described,
  };
}

/**
 * The evaluation context for a finished Tier-0 intake: every captured field by
 * its normalized value (falling back to the raw one, so a field that failed
 * normalization can still be routed on), plus `category`/`subcategory`, which
 * the default rules key off. Computed fields (`within_return_window`, stock,
 * order status) are absent until a connector exists — Step 9.
 */
export function routingContext(input: {
  category: string;
  subcategory: string | null;
  fields: { key: string; raw: string; normalized: string | null }[];
  settings?: Record<string, unknown>;
}): RuleContext {
  const fields: Record<string, unknown> = {
    category: input.category,
    subcategory: input.subcategory,
  };
  for (const field of input.fields) {
    fields[field.key] = field.normalized ?? field.raw;
  }
  return { fields, config: input.settings };
}

/** One line describing a decision, for the case timeline. */
export function describeRouting(decision: RoutingDecision): string {
  const where = decision.queue ?? UNROUTED_QUEUE_LABEL;
  const why =
    decision.matched.length === 0
      ? "no rule matched"
      : `matched ${decision.matched.map((m) => m.label).join(", ")}`;
  return `Routed to ${where} (${decision.priority} priority, ${decision.status}) — ${why}`;
}
