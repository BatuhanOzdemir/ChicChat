-- ChicChat — initial core schema (docs/SPEC.md §4)
-- Structured-intake & triage data model for the WhatsApp fashion-CS bot.
--
-- Notes:
--  * UUID PKs via gen_random_uuid() (core in Postgres 13+; local DB is PG17).
--  * Labels live on categories/subcategories so the same taxonomy can serve
--    multiple locales (one row-set per locale). See §4.
--  * RLS is intentionally NOT enabled here — Phase A is local-only with no auth
--    layer. Access policies land alongside the API layer in a later step.

-- 1. Merchants ---------------------------------------------------------------
create table merchants (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null,
  locale     text        not null default 'en',   -- en | tr | pt | ar | id ...
  rtl        boolean      not null default false,
  currency   text        not null default 'USD',   -- ISO 4217
  created_at timestamptz not null default now()
);

-- 2. Per-merchant configuration (1:1 with merchants) -------------------------
create table merchant_config (
  merchant_id           uuid primary key references merchants (id) on delete cascade,
  return_window_days    integer       not null default 30,
  refund_sla_days       integer       not null default 14,
  auto_approve_threshold numeric(12, 2) not null default 0,
  order_id_regex        text,                          -- merchant order-id pattern (§2)
  created_at            timestamptz   not null default now()
);

-- 3. Categories (the 8 opinionated defaults, merchant-editable) --------------
create table categories (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid        not null references merchants (id) on delete cascade,
  key         text        not null,                    -- stable machine key, e.g. 'wismo'
  label       text        not null,                    -- localized display label
  sort_order  integer      not null default 0,
  enabled     boolean      not null default true,
  created_at  timestamptz not null default now(),
  unique (merchant_id, key)
);

-- 4. Subcategories -----------------------------------------------------------
create table subcategories (
  id          uuid primary key default gen_random_uuid(),
  category_id uuid        not null references categories (id) on delete cascade,
  key         text        not null,
  label       text        not null,
  sort_order  integer      not null default 0,
  created_at  timestamptz not null default now(),
  unique (category_id, key)
);

-- 5. Field definitions (which fields a category captures) --------------------
create table field_defs (
  id            uuid primary key default gen_random_uuid(),
  category_id   uuid        not null references categories (id) on delete cascade,
  key           text        not null,                  -- e.g. 'order_number', 'photo'
  type          text        not null,                  -- string | enum | media | ref | bool | computed ...
  required      boolean      not null default false,
  enum_values   jsonb,                                 -- allowed values when type = enum
  normalize_rule text,                                 -- reference to a normalization rule (§2)
  created_at    timestamptz not null default now(),
  unique (category_id, key)
);

-- 6. Routing rules (condition -> action; §3) ---------------------------------
create table routing_rules (
  id           uuid primary key default gen_random_uuid(),
  category_id  uuid        not null references categories (id) on delete cascade,
  condition    jsonb       not null,                   -- condition tree referencing captured/computed fields
  action_type  text        not null,                   -- route | auto_reply | request_info | escalate | auto_resolve
  target_queue text,                                   -- queue name for route/escalate actions
  priority     text,                                   -- high | normal | low
  auto_resolve boolean      not null default false,     -- Phase 2 only
  created_at   timestamptz not null default now()
);

-- 7. Store integrations (Shopify / WooCommerce / İkas ...) -------------------
create table integrations (
  id            uuid primary key default gen_random_uuid(),
  merchant_id   uuid        not null references merchants (id) on delete cascade,
  platform      text        not null,                  -- shopify | woocommerce | ikas | ...
  status        text        not null default 'disconnected', -- connected | disconnected | error
  oauth_token_ref text,                                -- reference to a secret store (never the raw token)
  connected_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- 8. Cases (one customer issue) ----------------------------------------------
create table cases (
  id              uuid primary key default gen_random_uuid(),
  merchant_id     uuid        not null references merchants (id) on delete cascade,
  customer_wa_id  text        not null,                -- WhatsApp user id
  category_id     uuid references categories (id) on delete set null,
  subcategory_id  uuid references subcategories (id) on delete set null,
  status          text        not null default 'open', -- open | needs_info | handed_off | escalated | resolved
  integration_tier smallint   not null default 0 check (integration_tier in (0, 1, 2)),
  created_at      timestamptz not null default now()
);

-- 9. Captured case fields (key/value, raw + normalized) ----------------------
create table case_fields (
  id               uuid primary key default gen_random_uuid(),
  case_id          uuid        not null references cases (id) on delete cascade,
  field_key        text        not null,
  raw_value        text,
  normalized_value text,
  created_at       timestamptz not null default now(),
  unique (case_id, field_key)
);

-- 10. Selected line items (from the §6 item picker; free text in Tier 0) -----
create table case_items (
  id           uuid primary key default gen_random_uuid(),
  case_id      uuid        not null references cases (id) on delete cascade,
  line_item_id text        not null,                   -- real id (Tier 1+) or captured text (Tier 0)
  title        text,
  variant      text,
  qty          integer      not null default 1,
  created_at   timestamptz not null default now()
);

-- Foreign-key / lookup indexes ----------------------------------------------
create index idx_categories_merchant      on categories (merchant_id);
create index idx_subcategories_category   on subcategories (category_id);
create index idx_field_defs_category      on field_defs (category_id);
create index idx_routing_rules_category   on routing_rules (category_id);
create index idx_integrations_merchant    on integrations (merchant_id);
create index idx_cases_merchant           on cases (merchant_id);
create index idx_cases_category           on cases (category_id);
create index idx_case_fields_case         on case_fields (case_id);
create index idx_case_items_case          on case_items (case_id);
