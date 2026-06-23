import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * Step 1 gate: assert the migrated schema contains every table and column
 * described in docs/SPEC.md §4. Runs against the live local Supabase DB.
 *
 * Connection: DATABASE_URL if set, else the Supabase CLI local default.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// The expected schema, transcribed straight from SPEC.md §4.
const EXPECTED: Record<string, string[]> = {
  merchants: ["id", "name", "locale", "rtl", "currency", "created_at"],
  merchant_config: [
    "merchant_id",
    "return_window_days",
    "refund_sla_days",
    "auto_approve_threshold",
    "order_id_regex",
  ],
  categories: ["id", "merchant_id", "key", "label", "sort_order", "enabled"],
  subcategories: ["id", "category_id", "key", "label", "sort_order"],
  field_defs: [
    "id",
    "category_id",
    "key",
    "type",
    "required",
    "enum_values",
    "normalize_rule",
  ],
  routing_rules: [
    "id",
    "category_id",
    "condition",
    "action_type",
    "target_queue",
    "priority",
    "auto_resolve",
  ],
  integrations: [
    "id",
    "merchant_id",
    "platform",
    "status",
    "oauth_token_ref",
    "connected_at",
  ],
  cases: [
    "id",
    "merchant_id",
    "customer_wa_id",
    "category_id",
    "subcategory_id",
    "status",
    "integration_tier",
  ],
  case_fields: ["id", "case_id", "field_key", "raw_value", "normalized_value"],
  case_items: ["id", "case_id", "line_item_id", "title", "variant", "qty"],
};

const client = new Client({ connectionString: DATABASE_URL });
let actual: Map<string, Set<string>>;

beforeAll(async () => {
  await client.connect();
  const { rows } = await client.query<{
    table_name: string;
    column_name: string;
  }>(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'`,
  );
  actual = new Map();
  for (const { table_name, column_name } of rows) {
    if (!actual.has(table_name)) actual.set(table_name, new Set());
    actual.get(table_name)!.add(column_name);
  }
});

afterAll(async () => {
  await client.end();
});

describe("schema (SPEC.md §4)", () => {
  for (const [table, columns] of Object.entries(EXPECTED)) {
    it(`table "${table}" exists`, () => {
      expect(actual.has(table), `missing table: ${table}`).toBe(true);
    });

    for (const column of columns) {
      it(`${table}.${column} exists`, () => {
        expect(
          actual.get(table)?.has(column) ?? false,
          `missing column: ${table}.${column}`,
        ).toBe(true);
      });
    }
  }
});
