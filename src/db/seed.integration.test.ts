import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * Step 2 gate: the seed is idempotent (running twice does not duplicate rows)
 * and a query returns the full taxonomy + the demo order's line items.
 * Runs against the live local Supabase DB.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const CASE_ID = "00000000-0000-0000-0000-000000000002";

// Expected row counts for the demo merchant after seeding (transcribed from §1).
const EXPECTED_COUNTS = {
  merchants: 1,
  merchant_config: 1,
  categories: 8,
  subcategories: 29,
  field_defs: 24,
  routing_rules: 16,
  cases: 1,
  case_fields: 2,
  case_items: 2,
};

const client = new Client({ connectionString: DATABASE_URL });

function runSeed() {
  execFileSync("node", ["scripts/seed.mjs"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
}

async function countsForDemoMerchant() {
  const { rows } = await client.query<{ k: string; n: string }>(
    `select 'merchants' k, count(*) n from merchants where id = $1
     union all select 'merchant_config', count(*) from merchant_config where merchant_id = $1
     union all select 'categories', count(*) from categories where merchant_id = $1
     union all select 'subcategories', count(*) from subcategories sc
        join categories c on c.id = sc.category_id where c.merchant_id = $1
     union all select 'field_defs', count(*) from field_defs fd
        join categories c on c.id = fd.category_id where c.merchant_id = $1
     union all select 'routing_rules', count(*) from routing_rules rr
        join categories c on c.id = rr.category_id where c.merchant_id = $1
     union all select 'cases', count(*) from cases where merchant_id = $1
     union all select 'case_fields', count(*) from case_fields where case_id = $2
     union all select 'case_items', count(*) from case_items where case_id = $2`,
    [MERCHANT_ID, CASE_ID],
  );
  return Object.fromEntries(rows.map((r) => [r.k, Number(r.n)]));
}

let countsAfterFirst: Record<string, number>;
let countsAfterSecond: Record<string, number>;

beforeAll(async () => {
  await client.connect();
  runSeed();
  countsAfterFirst = await countsForDemoMerchant();
  runSeed();
  countsAfterSecond = await countsForDemoMerchant();
}, 60_000);

afterAll(async () => {
  await client.end();
});

describe("seed — idempotency", () => {
  it("a second run does not duplicate any rows", () => {
    expect(countsAfterSecond).toEqual(countsAfterFirst);
  });

  it("row counts match the opinionated default (§1)", () => {
    expect(countsAfterSecond).toEqual(EXPECTED_COUNTS);
  });
});

describe("seed — taxonomy query (§1)", () => {
  it("returns the 8 categories in sort order", async () => {
    const { rows } = await client.query<{ key: string }>(
      `select key from categories where merchant_id = $1 order by sort_order`,
      [MERCHANT_ID],
    );
    expect(rows.map((r) => r.key)).toEqual([
      "wismo",
      "return",
      "exchange",
      "refund_not_received",
      "wrong_damaged_missing",
      "cancel_modify",
      "sizing_fit",
      "other",
    ]);
  });

  it("marks photo required on wrong/damaged/missing and new_value optional on cancel/modify", async () => {
    const { rows } = await client.query<{
      cat: string;
      key: string;
      required: boolean;
    }>(
      `select c.key cat, fd.key, fd.required
         from field_defs fd join categories c on c.id = fd.category_id
        where c.merchant_id = $1
          and (c.key, fd.key) in (('wrong_damaged_missing','photo'), ('cancel_modify','new_value'))`,
      [MERCHANT_ID],
    );
    const byCat = Object.fromEntries(rows.map((r) => [r.cat, r.required]));
    expect(byCat["wrong_damaged_missing"]).toBe(true);
    expect(byCat["cancel_modify"]).toBe(false);
  });

  it("loads the SPEC §3 finance-refunds rule", async () => {
    const { rows } = await client.query(
      `select rr.priority
         from routing_rules rr join categories c on c.id = rr.category_id
        where c.merchant_id = $1 and c.key = 'refund_not_received'
          and rr.action_type = 'route' and rr.target_queue = 'finance_refunds_queue'`,
      [MERCHANT_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].priority).toBe("high");
  });
});

describe("seed — demo order line items (§6 / case_items)", () => {
  it("returns the demo order's line items with normalized order number", async () => {
    const items = await client.query<{
      line_item_id: string;
      qty: number;
    }>(
      `select line_item_id, qty from case_items where case_id = $1 order by line_item_id`,
      [CASE_ID],
    );
    expect(items.rows).toHaveLength(2);
    expect(items.rows.map((r) => r.line_item_id)).toEqual([
      "li_8841",
      "li_8842",
    ]);

    const { rows } = await client.query<{ normalized_value: string }>(
      `select normalized_value from case_fields where case_id = $1 and field_key = 'order_number'`,
      [CASE_ID],
    );
    expect(rows[0]?.normalized_value).toBe("TR100432");
  });
});
