/**
 * Taxonomy CRUD (SPEC §§4, 8): everything a merchant can create, rename,
 * reorder, disable or delete — categories, subcategories, field defs and
 * routing rules — plus the policy settings.
 *
 * All writes are scoped by merchant id, and child writes verify the parent
 * belongs to the merchant, so a crafted form cannot reach another tenant's rows.
 */
import type {
  FieldInput,
  NamedInput,
  PolicyInput,
  RuleInput,
} from "@/lib/config/forms";
import type { Queryable } from "./database";

export type WriteResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

const DUPLICATE = "23505"; // Postgres unique_violation

function isDuplicate(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === DUPLICATE
  );
}

// --- Policy ----------------------------------------------------------------

export async function updatePolicy(
  db: Queryable,
  merchantId: string,
  policy: PolicyInput,
): Promise<void> {
  await db.query(
    `update merchant_config
        set return_window_days = $2, refund_sla_days = $3,
            nudge_after_minutes = $4, abandon_after_hours = $5,
            retention_months = $6, kvkk_url = $7, order_id_regex = $8
      where merchant_id = $1`,
    [
      merchantId,
      policy.returnWindowDays,
      policy.refundSlaDays,
      policy.nudgeAfterMinutes,
      policy.abandonAfterHours,
      policy.retentionMonths,
      policy.kvkkUrl,
      policy.orderIdRegex,
    ],
  );
}

// --- Categories ------------------------------------------------------------

export async function createCategory(
  db: Queryable,
  merchantId: string,
  input: NamedInput,
): Promise<WriteResult> {
  try {
    const { rows } = await db.query(
      `insert into categories (merchant_id, key, label, sort_order, enabled)
       values ($1, $2, $3, $4, true) returning id`,
      [merchantId, input.key, input.label, input.sortOrder],
    );
    return { ok: true, id: (rows[0] as { id: string }).id };
  } catch (err) {
    if (isDuplicate(err)) {
      return {
        ok: false,
        error: `a category with key "${input.key}" already exists`,
      };
    }
    throw err;
  }
}

export async function updateCategory(
  db: Queryable,
  merchantId: string,
  categoryId: string,
  input: { label: string; sortOrder: number; enabled: boolean },
): Promise<void> {
  await db.query(
    `update categories set label = $3, sort_order = $4, enabled = $5
      where id = $2 and merchant_id = $1`,
    [merchantId, categoryId, input.label, input.sortOrder, input.enabled],
  );
}

export async function deleteCategory(
  db: Queryable,
  merchantId: string,
  categoryId: string,
): Promise<void> {
  await db.query(`delete from categories where id = $2 and merchant_id = $1`, [
    merchantId,
    categoryId,
  ]);
}

/** True when the category belongs to this merchant (guards child writes). */
async function ownsCategory(
  db: Queryable,
  merchantId: string,
  categoryId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from categories where id = $2 and merchant_id = $1`,
    [merchantId, categoryId],
  );
  return rows.length > 0;
}

// --- Subcategories ---------------------------------------------------------

export async function createSubcategory(
  db: Queryable,
  merchantId: string,
  categoryId: string,
  input: NamedInput,
): Promise<WriteResult> {
  if (!(await ownsCategory(db, merchantId, categoryId))) {
    return { ok: false, error: "unknown category" };
  }
  try {
    const { rows } = await db.query(
      `insert into subcategories (category_id, key, label, sort_order)
       values ($1, $2, $3, $4) returning id`,
      [categoryId, input.key, input.label, input.sortOrder],
    );
    return { ok: true, id: (rows[0] as { id: string }).id };
  } catch (err) {
    if (isDuplicate(err)) {
      return {
        ok: false,
        error: `"${input.key}" already exists in this category`,
      };
    }
    throw err;
  }
}

export async function deleteSubcategory(
  db: Queryable,
  merchantId: string,
  subcategoryId: string,
): Promise<void> {
  await db.query(
    `delete from subcategories sc
      using categories c
      where sc.id = $2 and c.id = sc.category_id and c.merchant_id = $1`,
    [merchantId, subcategoryId],
  );
}

// --- Field definitions -----------------------------------------------------

export async function createField(
  db: Queryable,
  merchantId: string,
  categoryId: string,
  input: FieldInput,
): Promise<WriteResult> {
  if (!(await ownsCategory(db, merchantId, categoryId))) {
    return { ok: false, error: "unknown category" };
  }
  try {
    const { rows } = await db.query(
      `insert into field_defs
         (category_id, key, label, type, required, enum_values, normalize_rule, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        categoryId,
        input.key,
        input.label,
        input.type,
        input.required,
        input.enumValues ? JSON.stringify(input.enumValues) : null,
        input.normalizeRule,
        input.sortOrder,
      ],
    );
    return { ok: true, id: (rows[0] as { id: string }).id };
  } catch (err) {
    if (isDuplicate(err)) {
      return { ok: false, error: `field "${input.key}" already exists here` };
    }
    throw err;
  }
}

export async function updateField(
  db: Queryable,
  merchantId: string,
  fieldId: string,
  input: FieldInput,
): Promise<void> {
  await db.query(
    `update field_defs fd
        set label = $3, type = $4, required = $5, enum_values = $6,
            normalize_rule = $7, sort_order = $8
      from categories c
      where fd.id = $2 and c.id = fd.category_id and c.merchant_id = $1`,
    [
      merchantId,
      fieldId,
      input.label,
      input.type,
      input.required,
      input.enumValues ? JSON.stringify(input.enumValues) : null,
      input.normalizeRule,
      input.sortOrder,
    ],
  );
}

export async function deleteField(
  db: Queryable,
  merchantId: string,
  fieldId: string,
): Promise<void> {
  await db.query(
    `delete from field_defs fd
      using categories c
      where fd.id = $2 and c.id = fd.category_id and c.merchant_id = $1`,
    [merchantId, fieldId],
  );
}

// --- Routing rules ---------------------------------------------------------

export async function createRule(
  db: Queryable,
  merchantId: string,
  categoryId: string,
  input: RuleInput,
): Promise<WriteResult> {
  if (!(await ownsCategory(db, merchantId, categoryId))) {
    return { ok: false, error: "unknown category" };
  }
  const { rows } = await db.query(
    `insert into routing_rules
       (category_id, label, condition, action_type, target_queue, priority,
        sort_order, auto_resolve)
     values ($1, $2, $3, $4, $5, $6, $7, false) returning id`,
    [
      categoryId,
      input.label,
      JSON.stringify(input.condition),
      input.actionType,
      input.targetQueue,
      input.priority,
      input.sortOrder,
    ],
  );
  return { ok: true, id: (rows[0] as { id: string }).id };
}

export async function deleteRule(
  db: Queryable,
  merchantId: string,
  ruleId: string,
): Promise<void> {
  await db.query(
    `delete from routing_rules rr
      using categories c
      where rr.id = $2 and c.id = rr.category_id and c.merchant_id = $1`,
    [merchantId, ruleId],
  );
}

/** Routing rules for the editor, grouped per category. */
export async function listRules(
  db: Queryable,
  merchantId: string,
): Promise<
  {
    id: string;
    category_id: string;
    label: string | null;
    condition: unknown;
    action_type: string;
    target_queue: string | null;
    priority: string | null;
    sort_order: number;
  }[]
> {
  const { rows } = await db.query(
    `select rr.id, rr.category_id, rr.label, rr.condition, rr.action_type,
            rr.target_queue, rr.priority, rr.sort_order
       from routing_rules rr
       join categories c on c.id = rr.category_id
      where c.merchant_id = $1
      -- Same order the engine evaluates them in, so the editor shows
      -- precedence as it actually is (first match wins).
      order by c.sort_order, rr.sort_order, rr.created_at, rr.id`,
    [merchantId],
  );
  return rows as Awaited<ReturnType<typeof listRules>>;
}
