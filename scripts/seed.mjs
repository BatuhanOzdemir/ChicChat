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
const SECOND_MERCHANT_ID = "00000000-0000-0000-0000-000000000003";

// Inbound messages are routed by `phone_number_id` (Step 6), so the demo
// merchant is linked to whatever number the environment points at — otherwise a
// real WhatsApp message would arrive for a number no merchant owns and be
// dropped. Falls back to a placeholder when no credentials are configured.
const DEMO_PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID ?? "demo-phone-number-id";
const SECOND_PHONE_NUMBER_ID = "second-merchant-phone-number-id";

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
    // Every new conversation opens by disclosing this (SPEC §12). Seeded so the
    // demo merchants show the real behaviour; a merchant that clears it simply
    // discloses nothing.
    kvkk_url: "https://demo-apparel.example.com/kvkk",
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
      // SPEC §5: an enum must be tappable, so it carries its own values. These
      // are item-level reasons and deliberately overlap the subcategory list —
      // the customer may pick any subcategory and still need to say why.
      [
        "reason",
        "enum",
        true,
        [
          "wrong_size",
          "poor_quality",
          "looks_different",
          "changed_mind",
          "arrived_late",
          "other",
        ],
        null,
      ],
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
      [
        "reason",
        "enum",
        true,
        [
          "wrong_size",
          "wrong_color",
          "poor_quality",
          "looks_different",
          "other",
        ],
        null,
      ],
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
// A second tenant with a deliberately different taxonomy, so multi-tenancy is
// demonstrable (Step 6): different keys, different labels, different language,
// different policy windows, and its own queues.
const SECOND_MERCHANT = {
  id: SECOND_MERCHANT_ID,
  name: "Butik Moda",
  locale: "tr",
  rtl: false,
  currency: "TRY",
  config: {
    return_window_days: 14,
    refund_sla_days: 7,
    auto_approve_threshold: 250.0,
    order_id_regex: "^BM[0-9]{5,}$",
    kvkk_url: "https://butikmoda.example.com/kvkk-aydinlatma-metni",
  },
};

const SECOND_TAXONOMY = [
  {
    key: "iade",
    label: "İade talebi",
    subcategories: [
      ["beden", "Beden uymadı"],
      ["fikir_degisti", "Vazgeçtim"],
    ],
    fields: [
      ["siparis_no", "string", true, null, "order_number"],
      ["urun", "ref", true, null, null],
      ["durum", "enum", true, ["etiketli", "etiketsiz"], null],
    ],
    rules: [
      {
        condition: { all: [{ field: "durum", op: "eq", value: "etiketsiz" }] },
        action_type: "escalate",
        target_queue: "iade_istisna",
        priority: "high",
      },
      {
        condition: { all: [] },
        action_type: "route",
        target_queue: "iade_kuyrugu",
        priority: "normal",
      },
    ],
  },
  {
    key: "kargo",
    label: "Kargo nerede?",
    subcategories: [
      ["gelmedi", "Hiç gelmedi"],
      ["gecikti", "Gecikti"],
    ],
    fields: [["siparis_no", "string", true, null, "order_number"]],
    rules: [
      {
        condition: {
          all: [{ field: "subcategory", op: "eq", value: "gelmedi" }],
        },
        action_type: "escalate",
        target_queue: "kargo_takip",
        priority: "high",
      },
    ],
  },
];

// Which WhatsApp number reaches which merchant (SPEC §10).
const CHANNELS = [
  {
    merchantId: MERCHANT_ID,
    phoneNumberId: DEMO_PHONE_NUMBER_ID,
    wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? null,
    displayNumber: "Demo Apparel line",
  },
  {
    merchantId: SECOND_MERCHANT_ID,
    phoneNumberId: SECOND_PHONE_NUMBER_ID,
    wabaId: null,
    displayNumber: "Butik Moda line",
  },
];

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

/** One tenant: merchant row, config, categories/subcategories/fields/rules. */
async function seedMerchant(client, merchant, taxonomy) {
  // 1. Merchant + config
  await client.query(
    `insert into merchants (id, name, locale, rtl, currency)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do update
       set name = excluded.name, locale = excluded.locale,
           rtl = excluded.rtl, currency = excluded.currency`,
    [
      merchant.id,
      merchant.name,
      merchant.locale,
      merchant.rtl,
      merchant.currency,
    ],
  );
  await client.query(
    `insert into merchant_config
       (merchant_id, return_window_days, refund_sla_days, auto_approve_threshold, order_id_regex, kvkk_url)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (merchant_id) do update
       set return_window_days = excluded.return_window_days,
           refund_sla_days = excluded.refund_sla_days,
           auto_approve_threshold = excluded.auto_approve_threshold,
           order_id_regex = excluded.order_id_regex,
           kvkk_url = excluded.kvkk_url`,
    [
      merchant.id,
      merchant.config.return_window_days,
      merchant.config.refund_sla_days,
      merchant.config.auto_approve_threshold,
      merchant.config.order_id_regex,
      merchant.config.kvkk_url,
    ],
  );

  // 2. Taxonomy. Rules are owned by the seed -> clear this merchant's rules first.
  await client.query(
    `delete from routing_rules
      where category_id in (select id from categories where merchant_id = $1)`,
    [merchant.id],
  );

  const categoryIdByKey = {};
  for (let i = 0; i < taxonomy.length; i++) {
    const cat = taxonomy[i];
    const {
      rows: [{ id: categoryId }],
    } = await client.query(
      `insert into categories (merchant_id, key, label, sort_order, enabled)
       values ($1, $2, $3, $4, true)
       on conflict (merchant_id, key) do update
         set label = excluded.label, sort_order = excluded.sort_order, enabled = excluded.enabled
       returning id`,
      [merchant.id, cat.key, cat.label, i + 1],
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

    // Rules are first-match-wins, so their listed order is their precedence
    // and has to be recorded explicitly (§3).
    for (let r = 0; r < cat.rules.length; r++) {
      const rule = cat.rules[r];
      await client.query(
        `insert into routing_rules
           (category_id, condition, action_type, target_queue, priority,
            sort_order, auto_resolve)
         values ($1, $2, $3, $4, $5, $6, false)`,
        [
          categoryId,
          j(rule.condition),
          rule.action_type,
          rule.target_queue,
          rule.priority,
          r + 1,
        ],
      );
    }
  }

  return categoryIdByKey;
}

/** The demo "order", which belongs to the first merchant only. */
async function seedDemoCase(client, categoryIdByKey) {
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

/** Channels are owned by the seed: one number per merchant, replaced on re-run. */
async function seedChannels(client) {
  // Drop numbers this seed no longer claims, so changing
  // WHATSAPP_PHONE_NUMBER_ID re-links the merchant instead of leaving the old
  // number attached to it as well.
  await client.query(
    `delete from whatsapp_channels
      where merchant_id = any($1) and phone_number_id <> all($2)`,
    [CHANNELS.map((c) => c.merchantId), CHANNELS.map((c) => c.phoneNumberId)],
  );

  for (const ch of CHANNELS) {
    await client.query(
      `insert into whatsapp_channels
         (merchant_id, phone_number_id, waba_id, display_number, is_primary)
       values ($1, $2, $3, $4, true)
       on conflict (phone_number_id) do update
         set merchant_id = excluded.merchant_id,
             waba_id = excluded.waba_id,
             display_number = excluded.display_number`,
      [ch.merchantId, ch.phoneNumberId, ch.wabaId, ch.displayNumber],
    );
  }
}

async function seed(client) {
  const categoryIdByKey = await seedMerchant(client, MERCHANT, TAXONOMY);
  await seedDemoCase(client, categoryIdByKey);
  // The second tenant exists so tenancy is exercised, not assumed: its taxonomy
  // shares no keys with the first merchant's.
  await seedMerchant(client, SECOND_MERCHANT, SECOND_TAXONOMY);
  await seedChannels(client);
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

  const count = (taxonomy, pick) => taxonomy.reduce((n, c) => n + pick(c), 0);
  console.log(
    `[db:seed] Seeded "${MERCHANT.name}": ${TAXONOMY.length} categories, ` +
      `${count(TAXONOMY, (c) => c.subcategories.length)} subcategories, ` +
      `${count(TAXONOMY, (c) => c.fields.length)} field defs, ` +
      `${count(TAXONOMY, (c) => c.rules.length)} routing rules, ` +
      `1 demo order (${DEMO_CASE.items.length} line items).`,
  );
  console.log(
    `[db:seed] Seeded "${SECOND_MERCHANT.name}": ${SECOND_TAXONOMY.length} categories, ` +
      `${count(SECOND_TAXONOMY, (c) => c.subcategories.length)} subcategories, ` +
      `${count(SECOND_TAXONOMY, (c) => c.fields.length)} field defs, ` +
      `${count(SECOND_TAXONOMY, (c) => c.rules.length)} routing rules.`,
  );
  for (const ch of CHANNELS) {
    console.log(
      `[db:seed] phone_number_id ${ch.phoneNumberId} -> ${ch.displayNumber}`,
    );
  }
  if (!process.env.WHATSAPP_PHONE_NUMBER_ID) {
    console.log(
      "[db:seed] WHATSAPP_PHONE_NUMBER_ID is not set, so the demo merchant is " +
        "linked to a placeholder number. Real inbound messages will be dropped " +
        "as an unknown number until you re-seed with credentials configured.",
    );
  }
}

main().catch((err) => {
  console.error("[db:seed] failed:", err);
  process.exit(1);
});
