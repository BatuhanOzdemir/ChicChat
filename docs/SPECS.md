# Fashion Returns & CS — Structured Intake Starter Pack (v1.1 Spec)

A build spec for a WhatsApp-native structured-intake and triage layer for apparel
merchants. Phase 1 turns a messy customer message into a clean, structured case for
a human agent. Phase 2 (later) reuses the same schema and integrations to resolve
cases autonomously.

This is the **opinionated default**. Every merchant can edit categories, fields,
and rules through the UI — but they start from this, not a blank canvas.

> **v1.1 change:** added §6, the conversation layer — WhatsApp Flows and the
> integrated order-item picker (the key Tier-1 upgrade for `item_ref`).

---

## 0. Design principles

1. **Configurable core, opinionated defaults.** The engine (flow, classification,
   rules, connectors) is hard-coded. The taxonomy and rules are merchant-editable.
2. **Integration is an enhancement tier, not a gate.** The bot delivers value at
   zero integration (structured intake → clean handoff) and gets better when a
   system is connected. Never require a connected store to function.
3. **Normalize on capture.** Order/item numbers are parsed and cleaned the moment
   they arrive, so the agent never cleans them and never re-asks.
4. **Ask only what's missing.** The classifier maps free text to a category and
   extracts whatever fields it can; the flow only asks for the gaps.
5. **Same schema bridges both phases.** A clean case for a human (Phase 1) is the
   exact input an autonomous resolver needs (Phase 2). Build once.

---

## 1. The taxonomy (opinionated default — 8 categories)

Each category lists: subcategories · required fields · computed fields (need
integration) · Phase-1 routing · Phase-2 auto-action (future).

### 1. Where is my order? (WISMO / delivery)
- **Subcategories:** not shipped yet · shipped, not arrived · marked delivered but not received · delayed past estimate
- **Required:** order_number
- **Computed (integration):** tracking_status, carrier, eta
- **Routing:** If connected → fetch live tracking, auto-reply status. "Marked delivered not received" → escalate to claims/carrier-dispute queue. Zero-integration → collect order_number + issue type, hand off.
- **Phase 2:** auto-reply ETA from tracking; open carrier claim for lost parcels.

### 2. Return request
- **Subcategories:** changed mind · doesn't fit · not as described · arrived too late · found it cheaper
- **Required:** order_number, item_ref(s) (multi-select from order — see §6), reason, condition (unworn / tags attached?)
- **Computed:** within_return_window (order_date + merchant.return_window_days)
- **Routing:** Within window + eligible reason → create return case (Phase 2: issue label). Outside window → escalate with policy-exception flag. "Not as described" → require photo.
- **Phase 2:** auto-issue return label / QR, auto-create RMA.

### 3. Exchange
- **Subcategories:** different size · different color · different item
- **Required:** order_number, item_ref (pick from order — see §6), desired_variant (size/color), reason
- **Computed:** variant_in_stock
- **Routing:** In stock + within window → create exchange. Out of stock → offer refund or waitlist (escalate).
- **Phase 2:** auto-reserve replacement, auto-create exchange order.

### 4. Refund not received
- **Subcategories:** not issued yet · issued but not in my account · partial refund · wrong amount
- **Required:** order_number, return_proof / return_tracking, refund_method, date_returned
- **Computed:** refund_status, days_since_return_received vs merchant.refund_sla_days
- **Routing:** System shows return received + past SLA → finance/refunds priority queue. Within SLA → auto-reply real expected timeline. Amount/method mismatch → escalate.
- **Phase 2:** check payment-processor status, auto-reply, trigger re-issue.

### 5. Wrong / damaged / missing item
- **Subcategories:** wrong item sent · wrong size sent · damaged · defective · item missing from order
- **Required:** order_number, item_ref (pick from order — see §6), **photo (required)**, description
- **Routing:** Photo + damaged/defective → priority queue, pre-approve replacement. Missing item → verify against order contents. No photo → bot requests it before handoff.
- **Phase 2:** auto-approve replacement/refund under merchant.auto_approve_threshold; auto-ship replacement.

### 6. Cancel or modify order
- **Subcategories:** cancel order · change size/variant · change shipping address · change payment
- **Required:** order_number, change_type, new_value (if modifying)
- **Computed:** order_status (shipped?)
- **Routing:** Not yet shipped → process / auto. Already shipped → convert to Return flow. Pre-dispatch address change → update.
- **Phase 2:** auto-cancel/modify when pre-dispatch.

### 7. Sizing & fit help (pre-purchase / pre-return)
- **Subcategories:** which size should I get · fit & measurements · fabric & care · is it in stock
- **Required:** product_ref (name or link), question
- **Computed:** stock_status
- **Routing:** Low-stakes → bot answers from size guide / KB (deflection, pre-empts a return). Complex → hand off.
- **Phase 2:** bot answers fully from product KB.

### 8. Other / talk to a human
- **Required:** description (free text, normalized), order_number (optional)
- **Routing:** Straight to human with whatever structured context was captured.
- **Purpose:** catch-all so nothing dead-ends; also a training signal for new categories.

---

## 2. Field types & the normalization layer

The normalization layer is core product IP, not config. It runs on every captured field.

| Field | Type | Normalization / handling |
|---|---|---|
| order_number | string | Strip `/`, spaces, `#`, leading zeros per merchant pattern; uppercase; validate against merchant order-id regex |
| item_ref | ref / string | **Tier 1+:** picked from the order via the item-picker Flow (§6), so it carries a real line-item id. **Tier 0:** free text + fuzzy match to catalog |
| photo | media | WhatsApp media id → stored blob → attached to case |
| subcategory / reason / condition | enum | Constrained to merchant's configured values |
| desired_variant | enum | Validated against catalog variants when connected |
| within_return_window | computed bool | order_date + return_window_days vs now |
| refund_status / tracking_status / stock_status | computed | From integration; absent in zero-integration mode |

**Degradation rule:** any computed field simply becomes "unknown" without an
integration — the case still forms and routes; it just carries less context.

---

## 3. Routing & rules model

A rule is: **condition(s) → action**.

- **Conditions** reference captured fields, computed fields, and merchant config
  (return_window_days, refund_sla_days, auto_approve_threshold, vip flags).
- **Actions:** route to queue · auto-reply (template) · request more info ·
  escalate with flag · auto-resolve (Phase 2 only).
- Rules are merchant-editable in the UI. Ship the defaults above pre-loaded.

Example (Refund not received):
`refund_status == "received" AND days_since_return_received > refund_sla_days`
→ `route: finance_refunds_queue, priority: high`

---

## 4. Suggested data model (Supabase / Postgres)

Sketch, not final DDL — enough to scaffold.

```
merchants
  id, name, locale, rtl (bool), currency, created_at

merchant_config
  merchant_id, return_window_days, refund_sla_days,
  auto_approve_threshold, order_id_regex

categories
  id, merchant_id, key, label, sort_order, enabled (bool)

subcategories
  id, category_id, key, label, sort_order

field_defs
  id, category_id, key, type, required (bool),
  enum_values (jsonb), normalize_rule (text)

routing_rules
  id, category_id, condition (jsonb), action_type,
  target_queue, priority, auto_resolve (bool)

integrations
  id, merchant_id, platform, status, oauth_token_ref, connected_at

cases
  id, merchant_id, customer_wa_id, category_id, subcategory_id,
  status, integration_tier (0|1|2), created_at

case_fields
  id, case_id, field_key, raw_value, normalized_value

case_items                       -- selected line items (from §6 picker)
  id, case_id, line_item_id, title, variant, qty
```

Labels live on `categories`/`subcategories` so the same taxonomy serves multiple
languages (one row set per locale, or a translations table) — needed for TR / PT /
AR / ID / EN.

---

## 5. Connector strategy (by market)

**Principle:** connect own-store SaaS platforms (clean OAuth/app APIs) for
one-click self-serve. Defer marketplaces (gated seller APIs, they own the returns
flow). Always support zero-integration mode.

### Build tiers
- **Tier 1 — cross-market, build first:** Shopify, WooCommerce. Present in every
  target market; one connector each covers a slice everywhere.
- **Tier 2 — regional own-store leaders:**
  - Turkey: **İkas** (SMB-fashion-skewed), then Ticimax / Ideasoft
  - LATAM: **Nuvemshop / Tiendanube**, then Tray, Loja Integrada
  - MENA / Gulf: **Salla**, **Zid** (both RTL-native, have dev APIs)
  - India: Dukaan / Shopnix / Shop2Host (India-built SaaS)
- **Tier 3 — defer (marketplaces, hard APIs):** Trendyol, Mercado Livre,
  Shopee, Tokopedia, Noon, Amazon. Support via manual order-number entry for now.

### Market notes
- **Turkey** — marketplace-heavy (Trendyol ~45% value share). Own-store v1 set:
  İkas + WooCommerce + Shopify; Trendyol as manual fallback.
- **LATAM / Brazil** — Nuvemshop dominates SMB own-stores; many merchants graduate
  to a store *from informal WhatsApp selling* — exactly the ICP.
- **MENA / Gulf** — Salla + Zid lead own-stores and are **Arabic / RTL-native**;
  the bot's flows must support RTL. Marketplaces (Noon, Amazon.sa) deferred.
- **SEA / Indonesia** — most SMBs are **marketplace-native** (Shopee + Tokopedia
  ~71% GMV). Own-store layer is thin → lean hardest on **zero-integration mode**
  here.
- **India** — WhatsApp is *already the customer-support channel*; UPI + COD
  dominant. Strong validation of the premise.

### Recommended v1 (Turkey-first)
İkas + WooCommerce + Shopify connectors, zero-integration fallback, Trendyol manual.

---

## 6. The conversation layer (WhatsApp Flows & the item picker)

How the structured intake is actually rendered inside WhatsApp. Two primitives:

- **Static List Messages** — for the category and subcategory menus (this is the
  "Listeyi Gör" pattern). Content is fixed; no server call. Cheap, ~minutes to
  build. Cap of ~10 rows per list, which is fine for the 8 categories and their
  subcategories.
- **Dynamic WhatsApp Flow (data-exchange mode)** — for anything that depends on
  the customer's actual order: the **item picker**, the **exchange variant
  picker**, and live **refund/tracking status**. The Flow calls *your* endpoint at
  runtime to populate the screen.

### 6.1 The item-picker screen sequence (Return / categories 2, 3, 5)

```
[entry] category + subcategory already chosen via static List Messages
   │
   ▼
ORDER_NUMBER        static input screen → customer types order number
   │                (normalized immediately per §2)
   ▼  data_exchange (send order_number to endpoint; fetch + cache the order)
SELECT_ITEMS        dynamic: CheckboxGroup populated with the order's line items
   │                (title = product + variant, description = SKU · qty)
   │                multi-select → one or many items in question
   ▼
REASON              dynamic or static: reason enum (+ condition for returns)
   │
   ▼  (conditional) if subcategory ∈ {damaged, defective, wrong, not as described}
PHOTO               PhotoPicker screen → required image
   │
   ▼
REVIEW → complete   summary screen; on submit, Flow returns the final payload
                    (nfm_reply) → build the structured case
```

For **Exchange**, `SELECT_ITEMS` is single-select and is followed by a
`SELECT_VARIANT` screen whose options (sizes/colors in stock) are also fetched
from the endpoint. For **Refund not received**, the dynamic screen shows the live
`refund_status` instead of asking the customer to guess.

### 6.2 The endpoint contract (data exchange)

WhatsApp calls your hosted endpoint on each dynamic screen transition. Decrypted,
the request looks like:

```json
{
  "version": "3.0",
  "action": "data_exchange",
  "screen": "ORDER_NUMBER",
  "flow_token": "<per-session token>",
  "data": { "order_number": "TR-100432" }
}
```

Your endpoint resolves the order against the merchant integration, caches it, and
returns the next screen plus its data:

```json
{
  "version": "3.0",
  "screen": "SELECT_ITEMS",
  "data": {
    "items": [
      { "id": "li_8841", "title": "Slim Fit Shirt — Blue / M", "description": "SKU 4827-BL-M · Qty 1" },
      { "id": "li_8842", "title": "Chino Trousers — Beige / 32", "description": "SKU 5591-BG-32 · Qty 2" }
    ]
  }
}
```

`items` binds to the CheckboxGroup's `data-source` in the Flow JSON. On submit, the
final `nfm_reply` payload carries the selected `id`s, which map straight to
`case_items` (§4).

### 6.3 Build & operational notes (be realistic)

- **Encryption is mandatory** for dynamic Flows: generate a 2048-bit RSA key pair,
  upload the public key to Meta, decrypt requests / re-encrypt responses with the
  private key on your server.
- **Host the endpoint yourself** (not a third party); it sees order data.
- **Latency matters.** Fetch and **cache the order at the `ORDER_NUMBER` step** so
  `SELECT_ITEMS` renders instantly. If WhatsApp's health checks find the endpoint
  slow/unreliable it throttles the Flow (10 msgs/hr) and can block it.
- **Payload values are strings** — serialize accordingly.
- **Effort:** a static Flow is ~an hour; a dynamic data-exchange Flow is roughly
  1–2 weeks of work for the first one, then cheap to extend.

### 6.4 Tier gating & fallback

- **Tier 1+ (store connected):** full item picker — customer taps real items.
- **Tier 0 (no integration):** skip the dynamic screens; ask for the item as text
  and fuzzy-match (§2). Case still forms; it just lacks line-item ids.

The item picker is the most visible reward for connecting a store — it is the
carrot that drives merchants up the integration tiers.

---

## 7. Graceful degradation tiers

- **Tier 0 — no integration:** structured intake → clean case to human. Works
  everywhere, including SEA marketplace-only merchants. This is the floor and the
  reason the product is universal.
- **Tier 1 — read access:** order / tracking / refund / stock lookup → validated
  fields, the item picker (§6), and richer auto-replies.
- **Tier 2 — write access (Phase 2):** autonomous actions — issue return label,
  process refund, create exchange.

---

## 8. Hard-coded vs configurable

**Hard-coded (the product):** normalization layer · WhatsApp flow engine (static
lists + dynamic Flows + endpoint) · classification + extraction model · rule
engine · platform connectors.

**Configurable per merchant (UI):** which categories are enabled · labels &
language · subcategories · required fields · routing rules & thresholds ·
return window · refund SLA · locale / RTL.

---

## 9. Suggested build order

1. Zero-integration intake for categories 1–5 (the highest-volume apparel cases):
   static List Messages + order-number normalization + required-photo flow for
   damaged/wrong items. (Tier 0 — works with no integration.)
2. Merchant UI to toggle categories, edit labels/fields, set window & SLA.
3. Shopify + WooCommerce read connectors (Tier 1 lookup).
4. İkas connector (Turkey wedge).
5. **Dynamic item-picker Flow (§6)** on top of the first working connector — the
   "magic" upgrade that makes item_ref a tap instead of a typed guess.
6. Routing/queue + agent handoff package.
7. (Phase 2) write actions on the strongest connector first.
