// ChicChat — idempotent seed of the opinionated default (CLAUDE.md Step 2).
//
// Seeds: one demo merchant + merchant_config; the 8 categories from SPEC.md §1
// with their subcategories, field_defs (required flags) and default routing
// rules (§3); and one demo "order" — represented (per §4, which has no orders
// table) as a demo case with 2–3 case_items.
//
// Idempotent: re-running produces identical rows. Parents are upserted on their
// natural unique keys (or fixed UUIDs); rules and case_items are owned by this
// seed and replaced via scoped delete+insert. Run with: npm run db:seed

import pg from "pg";

const { Client } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Fixed ids so re-runs target the same rows.
const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const CASE_ID = "00000000-0000-0000-0000-000000000002";

const MERCHANT = {
  id: MERCHANT_ID,
  name: "Demo Apparel Co.",
  locale: "en", // labels below are the English opinionated default; merchant-editable / localizable per §4
  rtl: false,
  currency: "USD",
  config: {
    return_window_days: 30,
    refund_sla_days: 14,
    auto_approve_threshold: 50.0,
    order_id_regex: "^[A-Z0-9]{4,}$",
  },
};

// field tuple: [key, type, required, enum_values | null, normalize_rule | null]
const TAXONOMY = [
  {
    key: "wismo",
    label: "Where is my order?",
    subcategories: [
      ["not_shipped", "Not shipped yet"],
      ["shipped_not_arrived", "Shipped, not arrived"],
      ["marked_delivered_not_received", "Marked delivered but not received"],
      ["delayed", "Delayed past estimate"],
    ],
    fields: [["order_number", "string", true, null, "order_number"]],
    rules: [
      {
        condition: {
          all: [
            {
              field: "subcategory",
              op: "eq",
              value: "marked_delivered_not_received",
            },
          ],
        },
        action_type: "escalate",
        target_queue: "claims_carrier_dispute",
        priority: "high",
      },
    ],
  },
  {
    key: "return",
    label: "Return request",
    subcategories: [
      ["changed_mind", "Changed my mind"],
      ["doesnt_fit", "Doesn't fit"],
      ["not_as_described", "Not as described"],
      ["arrived_too_late", "Arrived too late"],
      ["found_cheaper", "Found it cheaper"],
    ],
    fields: [
      ["order_number", "string", true, null, "order_number"],
      ["item_ref", "ref", true, null, null],
      ["reason", "enum", true, null, null],
      [
        "condition",
        "enum",
        true,
        ["unworn_tags_on", "worn_tags_removed"],
        null,
      ],
    ],
    rules: [
      {
        condition: {
          all: [{ field: "subcategory", op: "eq", value: "not_as_described" }],
        },
        action_type: "request_info",
        target_queue: null,
        priority: "normal",
      },
      {
        condition: {
          all: [{ field: "within_return_window", op: "eq", value: false }],
        },
        action_type: "escalate",
        target_queue: "policy_exception",
        priority: "normal",
      },
      {
        condition: {
          all: [{ field: "within_return_window", op: "eq", value: true }],
        },
        action_type: "route",
        target_queue: "returns_queue",
        priority: "normal",
      },
    ],
  },
  {
    key: "exchange",
    label: "Exchange",
    subcategories: [
      ["different_size", "Different size"],
      ["different_color", "Different color"],
      ["different_item", "Different item"],
    ],
    fields: [
      ["order_number", "string", true, null, "order_number"],
      ["item_ref", "ref", true, null, null],
      ["desired_variant", "enum", true, null, null], // catalog-driven; validated when connected
      ["reason", "enum", true, null, null],
    ],
    rules: [
      {
        condition: {
          all: [{ field: "variant_in_stock", op: "eq", value: false }],
        },
        action_type: "escalate",
        target_queue: "exchange_out_of_stock",
        priority: "normal",
      },
      {
        condition: {
          all: [
            { field: "variant_in_stock", op: "eq", value: true },
            { field: "within_return_window", op: "eq", value: true },
          ],
        },
        action_type: "route",
        target_queue: "exchange_queue",
        priority: "normal",
      },
    ],
  },
  {
    key: "refund_not_received",
    label: "Refund not received",
    subcategories: [
      ["not_issued", "Not issued yet"],
      ["issued_not_in_account", "Issued but not in my account"],
      ["partial_refund", "Partial refund"],
      ["wrong_amount", "Wrong amount"],
    ],
    fields: [
      ["order_number", "string", true, null, "order_number"],
      ["return_proof", "string", true, null, null],
      [
        "refund_method",
        "enum",
        true,
        [
          "original_payment",
          "store_credit",
          "bank_transfer",
          "cash_on_delivery",
        ],
        null,
      ],
      ["date_returned", "string", true, null, null],
    ],
    rules: [
      // SPEC §3 example: refund received + past SLA -> finance queue, high priority.
      {
        condition: {
          all: [
            { field: "refund_status", op: "eq", value: "received" },
            {
              field: "days_since_return_received",
              op: "gt",
              ref: "refund_sla_days",
            },
          ],
        },
        action_type: "route",
        target_queue: "finance_refunds_queue",
        priority: "high",
      },
      {
        condition: {
          all: [
            { field: "refund_status", op: "eq", value: "received" },
            {
              field: "days_since_return_received",
              op: "lte",
              ref: "refund_sla_days",
            },
          ],
        },
        action_type: "auto_reply",
        target_queue: null,
        priority: "normal",
      },
      {
        condition: {
          all: [
            {
              field: "subcategory",
              op: "in",
              value: ["partial_refund", "wrong_amount"],
            },
          ],
        },
        action_type: "escalate",
        target_queue: "finance_review",
        priority: "normal",
      },
    ],
  },
  {
    key: "wrong_damaged_missing",
    label: "Wrong / damaged / missing item",
    subcategories: [
      ["wrong_item", "Wrong item sent"],
      ["wrong_size_sent", "Wrong size sent"],
      ["damaged", "Damaged"],
      ["defective", "Defective"],
      ["item_missing", "Item missing from order"],
    ],
    fields: [
      ["order_number", "string", true, null, "order_number"],
      ["item_ref", "ref", true, null, null],
      ["photo", "media", true, null, null], // required per §1
      ["description", "string", true, null, null],
    ],
    rules: [
      {
        condition: {
          all: [
            { field: "subcategory", op: "in", value: ["damaged", "defective"] },
            { field: "photo", op: "present" },
          ],
        },
        action_type: "route",
        target_queue: "priority_replacements",
        priority: "high",
      },
      {
        condition: { all: [{ field: "photo", op: "absent" }] },
        action_type: "request_info",
        target_queue: null,
        priority: "normal",
      },
      {
        condition: {
          all: [{ field: "subcategory", op: "eq", value: "item_missing" }],
        },
        action_type: "escalate",
        target_queue: "verify_order_contents",
        priority: "normal",
      },
    ],
  },
  {
    key: "cancel_modify",
    label: "Cancel or modify order",
    subcategories: [
      ["cancel", "Cancel order"],
      ["change_size_variant", "Change size/variant"],
      ["change_address", "Change shipping address"],
      ["change_payment", "Change payment"],
    ],
    fields: [
      ["order_number", "string", true, null, "order_number"],
      [
        "change_type",
        "enum",
        true,
        ["cancel", "size_variant", "shipping_address", "payment"],
        null,
      ],
      ["new_value", "string", false, null, null], // only when modifying
    ],
    rules: [
      {
        condition: {
          all: [{ field: "order_status", op: "neq", value: "shipped" }],
        },
        action_type: "route",
        target_queue: "order_changes",
        priority: "normal",
      },
      {
        condition: {
          all: [{ field: "order_status", op: "eq", value: "shipped" }],
        },
        action_type: "escalate",
        target_queue: "convert_to_return",
        priority: "normal",
      },
    ],
  },
  {
    key: "sizing_fit",
    label: "Sizing & fit help",
    subcategories: [
      ["which_size", "Which size should I get"],
      ["fit_measurements", "Fit & measurements"],
      ["fabric_care", "Fabric & care"],
      ["in_stock", "Is it in stock"],
    ],
    fields: [
      ["product_ref", "string", true, null, null],
      ["question", "string", true, null, null],
    ],
    rules: [
      // Low-stakes: deflect with a size-guide / KB auto-reply. Always-match default.
      {
        condition: { all: [] },
        action_type: "auto_reply",
        target_queue: "size_guide_kb",
        priority: "low",
      },
    ],
  },
  {
    key: "other",
    label: "Other / talk to a human",
    subcategories: [],
    fields: [
      ["description", "string", true, null, null],
      ["order_number", "string", false, null, "order_number"], // optional
    ],
    rules: [
      {
        condition: { all: [] },
        action_type: "route",
        target_queue: "human",
        priority: "normal",
      },
    ],
  },
];

// The demo "order" (case + line items). Tier 0: line ids are captured text.
const DEMO_CASE = {
  id: CASE_ID,
  customer_wa_id: "+905551234567",
  category_key: "return",
  subcategory_key: "doesnt_fit",
  status: "open",
  integration_tier: 0,
  fields: [
    // raw shows messy input; normalized is what Step 3 will produce.
    ["order_number", "#TR-100 432", "TR100432"],
    ["reason", "Doesn't fit", "doesnt_fit"],
  ],
  items: [
    {
      line_item_id: "li_8841",
      title: "Slim Fit Shirt — Blue / M",
      variant: "Blue / M",
      qty: 1,
    },
    {
      line_item_id: "li_8842",
      title: "Chino Trousers — Beige / 32",
      variant: "Beige / 32",
      qty: 2,
    },
  ],
};

const j = (v) => (v == null ? null : JSON.stringify(v));

async function seed(client) {
  // 1. Merchant + config
  await client.query(
    `insert into merchants (id, name, locale, rtl, currency)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do update
       set name = excluded.name, locale = excluded.locale,
           rtl = excluded.rtl, currency = excluded.currency`,
    [
      MERCHANT.id,
      MERCHANT.name,
      MERCHANT.locale,
      MERCHANT.rtl,
      MERCHANT.currency,
    ],
  );
  await client.query(
    `insert into merchant_config
       (merchant_id, return_window_days, refund_sla_days, auto_approve_threshold, order_id_regex)
     values ($1, $2, $3, $4, $5)
     on conflict (merchant_id) do update
       set return_window_days = excluded.return_window_days,
           refund_sla_days = excluded.refund_sla_days,
           auto_approve_threshold = excluded.auto_approve_threshold,
           order_id_regex = excluded.order_id_regex`,
    [
      MERCHANT.id,
      MERCHANT.config.return_window_days,
      MERCHANT.config.refund_sla_days,
      MERCHANT.config.auto_approve_threshold,
      MERCHANT.config.order_id_regex,
    ],
  );

  // 2. Taxonomy. Rules are owned by the seed -> clear this merchant's rules first.
  await client.query(
    `delete from routing_rules
      where category_id in (select id from categories where merchant_id = $1)`,
    [MERCHANT.id],
  );

  const categoryIdByKey = {};
  for (let i = 0; i < TAXONOMY.length; i++) {
    const cat = TAXONOMY[i];
    const {
      rows: [{ id: categoryId }],
    } = await client.query(
      `insert into categories (merchant_id, key, label, sort_order, enabled)
       values ($1, $2, $3, $4, true)
       on conflict (merchant_id, key) do update
         set label = excluded.label, sort_order = excluded.sort_order, enabled = excluded.enabled
       returning id`,
      [MERCHANT.id, cat.key, cat.label, i + 1],
    );
    categoryIdByKey[cat.key] = categoryId;

    for (let s = 0; s < cat.subcategories.length; s++) {
      const [key, label] = cat.subcategories[s];
      await client.query(
        `insert into subcategories (category_id, key, label, sort_order)
         values ($1, $2, $3, $4)
         on conflict (category_id, key) do update
           set label = excluded.label, sort_order = excluded.sort_order`,
        [categoryId, key, label, s + 1],
      );
    }

    // Fields are seeded in the order the spec lists them, and that order is
    // what the intake asks in (sort_order, not alphabetically).
    for (let f = 0; f < cat.fields.length; f++) {
      const [key, type, required, enumValues, normalizeRule] = cat.fields[f];
      await client.query(
        `insert into field_defs
           (category_id, key, type, required, enum_values, normalize_rule, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (category_id, key) do update
           set type = excluded.type, required = excluded.required,
               enum_values = excluded.enum_values,
               normalize_rule = excluded.normalize_rule,
               sort_order = excluded.sort_order`,
        [
          categoryId,
          key,
          type,
          required,
          j(enumValues),
          normalizeRule,
          (f + 1) * 10,
        ],
      );
    }

    for (const rule of cat.rules) {
      await client.query(
        `insert into routing_rules
           (category_id, condition, action_type, target_queue, priority, auto_resolve)
         values ($1, $2, $3, $4, $5, false)`,
        [
          categoryId,
          j(rule.condition),
          rule.action_type,
          rule.target_queue,
          rule.priority,
        ],
      );
    }
  }

  // 3. Demo order = demo case + case_items (+ a couple of case_fields).
  await client.query(
    `insert into cases
       (id, merchant_id, customer_wa_id, category_id, subcategory_id, status, integration_tier)
     values ($1, $2, $3, $4,
             (select id from subcategories
                where category_id = $4 and key = $5), $6, $7)
     on conflict (id) do update
       set merchant_id = excluded.merchant_id, customer_wa_id = excluded.customer_wa_id,
           category_id = excluded.category_id, subcategory_id = excluded.subcategory_id,
           status = excluded.status, integration_tier = excluded.integration_tier`,
    [
      DEMO_CASE.id,
      MERCHANT.id,
      DEMO_CASE.customer_wa_id,
      categoryIdByKey[DEMO_CASE.category_key],
      DEMO_CASE.subcategory_key,
      DEMO_CASE.status,
      DEMO_CASE.integration_tier,
    ],
  );

  for (const [fieldKey, raw, normalized] of DEMO_CASE.fields) {
    await client.query(
      `insert into case_fields (case_id, field_key, raw_value, normalized_value)
       values ($1, $2, $3, $4)
       on conflict (case_id, field_key) do update
         set raw_value = excluded.raw_value, normalized_value = excluded.normalized_value`,
      [DEMO_CASE.id, fieldKey, raw, normalized],
    );
  }

  // case_items are owned by the seed -> replace.
  await client.query(`delete from case_items where case_id = $1`, [
    DEMO_CASE.id,
  ]);
  for (const item of DEMO_CASE.items) {
    await client.query(
      `insert into case_items (case_id, line_item_id, title, variant, qty)
       values ($1, $2, $3, $4, $5)`,
      [DEMO_CASE.id, item.line_item_id, item.title, item.variant, item.qty],
    );
  }
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    await seed(client);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    await client.end();
  }

  console.log(
    `[db:seed] Seeded merchant "${MERCHANT.name}": ` +
      `${TAXONOMY.length} categories, ` +
      `${TAXONOMY.reduce((n, c) => n + c.subcategories.length, 0)} subcategories, ` +
      `${TAXONOMY.reduce((n, c) => n + c.fields.length, 0)} field defs, ` +
      `${TAXONOMY.reduce((n, c) => n + c.rules.length, 0)} routing rules, ` +
      `1 demo order (${DEMO_CASE.items.length} line items).`,
  );
}

main().catch((err) => {
  console.error("[db:seed] failed:", err);
  process.exit(1);
});
