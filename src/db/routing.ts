/**
 * Loading a category's routing rules (SPEC §3) for the decision made at case
 * creation. One merchant-scoped query; the evaluation itself is pure
 * (`lib/cases/routing`).
 */
import type { LabelledRule } from "@/lib/cases/routing";
import type { ActionType, Condition } from "@/lib/rules";
import type { Queryable } from "./database";

/**
 * Rules for one category, in the merchant's configured order — which is the
 * order that decides precedence (first match wins), so it must be stable.
 */
export async function loadRoutingRules(
  db: Queryable,
  merchantId: string,
  categoryKey: string,
): Promise<LabelledRule[]> {
  const { rows } = await db.query(
    `select rr.id, rr.label, rr.condition, rr.action_type,
            rr.target_queue, rr.priority, rr.auto_resolve
       from routing_rules rr
       join categories cat on cat.id = rr.category_id
      where cat.merchant_id = $1 and cat.key = $2
      order by rr.sort_order, rr.created_at, rr.id`,
    [merchantId, categoryKey],
  );

  return (
    rows as {
      id: string;
      label: string | null;
      condition: Condition;
      action_type: ActionType;
      target_queue: string | null;
      priority: string | null;
      auto_resolve: boolean;
    }[]
  ).map((r) => ({
    id: r.id,
    label: r.label,
    condition: r.condition,
    action_type: r.action_type,
    target_queue: r.target_queue,
    priority: r.priority,
    auto_resolve: r.auto_resolve,
  }));
}
