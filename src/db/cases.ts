/**
 * Case persistence & the agent-handoff package (CLAUDE.md Step 6).
 *
 * Thin DB layer over the §4 tables. Decoupled from any specific driver via the
 * `Queryable`/`Database` contracts, so the engine stays testable. `persistCase`
 * writes cases/case_fields/case_items atomically; `buildHandoff` reads them back
 * into the clean JSON a human agent (or the Phase-2 resolver) consumes:
 * category, subcategory, normalized fields, selected items, photos.
 */
import type { Database, Queryable } from "./database";

export type { Queryable };

export interface PersistCaseInput {
  merchantId: string;
  customerWaId: string;
  categoryKey: string;
  subcategoryKey?: string | null;
  integrationTier?: number;
  status?: string;
  fields: { key: string; raw: string; normalized: string | null }[];
  /** Selected line items (Tier 1+ picker). Empty in Tier 0. */
  items?: {
    lineItemId: string;
    title?: string | null;
    variant?: string | null;
    qty?: number;
  }[];
}

export interface HandoffItem {
  line_item_id: string;
  title: string | null;
  variant: string | null;
  qty: number;
}

export interface HandoffPackage {
  case_id: string;
  category: string;
  subcategory: string | null;
  integration_tier: number;
  status: string;
  customer_wa_id: string;
  /** field_key -> normalized value. */
  fields: Record<string, string | null>;
  /** Normalized refs of media-typed fields (e.g. photo). */
  photos: string[];
  items: HandoffItem[];
}

async function one<R>(
  db: Queryable,
  text: string,
  values: unknown[],
): Promise<R | undefined> {
  const { rows } = await db.query(text, values);
  return rows[0] as R | undefined;
}

/**
 * Persist a case with its fields and items **atomically** (Handbook §6, SPEC
 * §11): a failure part-way through leaves no partial case behind.
 */
export async function persistCase(
  db: Database,
  input: PersistCaseInput,
): Promise<string> {
  return db.transaction(async (tx) => {
    const category = await one<{ id: string }>(
      tx,
      `select id from categories where merchant_id = $1 and key = $2`,
      [input.merchantId, input.categoryKey],
    );
    if (!category) {
      throw new Error(
        `unknown category "${input.categoryKey}" for merchant ${input.merchantId}`,
      );
    }

    let subcategoryId: string | null = null;
    if (input.subcategoryKey) {
      const sub = await one<{ id: string }>(
        tx,
        `select id from subcategories where category_id = $1 and key = $2`,
        [category.id, input.subcategoryKey],
      );
      subcategoryId = sub?.id ?? null;
    }

    const created = await one<{ id: string }>(
      tx,
      `insert into cases
         (merchant_id, customer_wa_id, category_id, subcategory_id, status, integration_tier)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [
        input.merchantId,
        input.customerWaId,
        category.id,
        subcategoryId,
        input.status ?? "open",
        input.integrationTier ?? 0,
      ],
    );
    const caseId = created!.id;

    for (const field of input.fields) {
      await tx.query(
        `insert into case_fields (case_id, field_key, raw_value, normalized_value)
         values ($1, $2, $3, $4)
         on conflict (case_id, field_key) do update
           set raw_value = excluded.raw_value, normalized_value = excluded.normalized_value`,
        [caseId, field.key, field.raw, field.normalized],
      );
    }

    for (const item of input.items ?? []) {
      await tx.query(
        `insert into case_items (case_id, line_item_id, title, variant, qty)
         values ($1, $2, $3, $4, $5)`,
        [
          caseId,
          item.lineItemId,
          item.title ?? null,
          item.variant ?? null,
          item.qty ?? 1,
        ],
      );
    }

    return caseId;
  });
}

export async function buildHandoff(
  db: Queryable,
  caseId: string,
): Promise<HandoffPackage> {
  const header = await one<{
    id: string;
    status: string;
    integration_tier: number;
    customer_wa_id: string;
    category: string;
    subcategory: string | null;
  }>(
    db,
    `select c.id, c.status, c.integration_tier, c.customer_wa_id,
            cat.key as category, sub.key as subcategory
       from cases c
       join categories cat on cat.id = c.category_id
       left join subcategories sub on sub.id = c.subcategory_id
      where c.id = $1`,
    [caseId],
  );
  if (!header) throw new Error(`case not found: ${caseId}`);

  const { rows: fieldRows } = await db.query(
    `select cf.field_key, cf.normalized_value, fd.type
       from case_fields cf
       join cases c on c.id = cf.case_id
       left join field_defs fd on fd.category_id = c.category_id and fd.key = cf.field_key
      where cf.case_id = $1
      order by cf.field_key`,
    [caseId],
  );

  const fields: Record<string, string | null> = {};
  const photos: string[] = [];
  for (const r of fieldRows as {
    field_key: string;
    normalized_value: string | null;
    type: string | null;
  }[]) {
    fields[r.field_key] = r.normalized_value;
    if (r.type === "media" && r.normalized_value)
      photos.push(r.normalized_value);
  }

  const { rows: itemRows } = await db.query(
    `select line_item_id, title, variant, qty
       from case_items where case_id = $1 order by line_item_id`,
    [caseId],
  );

  return {
    case_id: header.id,
    category: header.category,
    subcategory: header.subcategory,
    integration_tier: header.integration_tier,
    status: header.status,
    customer_wa_id: header.customer_wa_id,
    fields,
    photos,
    items: itemRows as HandoffItem[],
  };
}
