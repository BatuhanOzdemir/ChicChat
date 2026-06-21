# CLAUDE.md — Build Plan & Working Agreement

This file is the **execution plan**. The full product spec lives in `docs/SPEC.md`
(the "Fashion Returns & CS — Structured Intake Starter Pack" v1.1). `docs/SPEC.md`
is the **source of truth** for *what* to build; this file governs *how* we build it.

If anything here conflicts with `docs/SPEC.md`, the spec wins on product behavior —
ask before diverging.

---

## What we're building

A WhatsApp-native structured-intake and triage layer for apparel merchants. Phase 1
turns a messy customer message into a clean, structured case for a human agent.
Phase 2 (later) resolves cases autonomously. See `docs/SPEC.md` for the taxonomy,
data model, rules, connectors, and the WhatsApp Flow item-picker.

---

## How we work (read this first — it is the most important section)

1. **One step at a time.** Implement exactly ONE numbered step from the build plan
   below, then STOP.
2. **Every step has a verification gate.** A step is not done until its gate passes
   (tests green / the stated check succeeds). Run the gate and show me the output.
3. **Stop and wait for my sign-off.** After a step's gate passes, post the step
   report (template below) and wait. Do **not** start the next step until I reply
   "approved" / "next". If I ask for changes, fix within the current step.
4. **Commit after each approved step** using a conventional-commit message, e.g.
   `feat(step-3): order-number normalization layer + tests`.
5. **Do not skip ahead or scaffold future steps early.** No stubs for later steps
   unless a step explicitly calls for them.
6. **Ask when ambiguous.** If the spec is unclear or a decision has trade-offs,
   ask me a single focused question instead of guessing.
7. **No external credentials until Phase B.** Phase A (Steps 0–7) must build and
   pass entirely locally with no Meta/İkas/Shopify accounts. Do not add code that
   requires real API keys before Phase B, and never hardcode secrets — use
   `.env.local` and commit a `.env.example`.

### Step report template (post this after each step)
```
## Step N — <title>  ✅ gate passed
- What I built: <1–3 lines>
- Files added/changed: <list>
- Verification: <command run> → <result / test summary>
- Notes / decisions: <anything you chose; flag assumptions>
Awaiting your sign-off to proceed to Step N+1.
```

---

## Tech stack & conventions

- **Framework:** Next.js (App Router) + TypeScript (`strict: true`).
- **Styling:** Tailwind CSS.
- **DB:** Supabase (Postgres). Use SQL migrations checked into `supabase/migrations`.
- **Tests:** Vitest for unit/integration; Playwright for any UI e2e (optional early).
- **Lint/format:** ESLint + Prettier.
- **Structure:** keep the engine modules (normalization, rules, intake state
  machine) as **pure, framework-free TypeScript** under `src/lib/` so they are
  unit-testable without Next.js or the DB. UI and DB are thin layers on top.
- **Tests live next to code** (`*.test.ts`). Prefer small modules and pure functions.
- Conventional commits. Small, reviewable diffs.

### Commands (you will create these in Step 0; keep them working)
- `npm run dev` — start Next.js
- `npm run test` / `npm run test:watch` — Vitest
- `npm run lint` — ESLint
- `npm run db:migrate` — apply migrations to local Supabase
- `npm run db:seed` — load demo data (idempotent)

---

## Build plan

### Phase A — Local core (no external accounts)

#### Step 0 — Scaffold & tooling
- **Build:** Next.js + TS + Tailwind app; local Supabase; Vitest; ESLint/Prettier;
  the npm scripts above; `.env.example`; `docs/SPEC.md` present.
- **Gate:** `npm run dev` boots with no errors; `npm run test` runs (a trivial
  passing test is fine); `npm run lint` passes.

#### Step 1 — Database schema & migrations
- **Build:** Migrations for every table in `docs/SPEC.md` §4 (merchants,
  merchant_config, categories, subcategories, field_defs, routing_rules,
  integrations, cases, case_fields, case_items).
- **Gate:** `npm run db:migrate` applies cleanly to a fresh local DB; a schema test
  asserts all tables/columns exist.

#### Step 2 — Seed the opinionated default
- **Build:** Idempotent seed: one demo merchant + merchant_config; the 8 categories
  from §1 with their subcategories, field_defs (required flags), and the default
  routing_rules; one demo order with 2–3 line items.
- **Gate:** `npm run db:seed` runs twice without duplicating rows; a query returns
  the full taxonomy and the demo order's line items.

#### Step 3 — Normalization layer (`src/lib/normalize`)
- **Build:** Pure module implementing §2 normalization, especially `order_number`
  (strip `/`, spaces, `#`, leading zeros; uppercase; validate against a configurable
  regex) and enum constraining.
- **Gate:** Unit tests cover the messy cases — `"  12/3 4-5 "`, `"#00420"`, invalid
  ids — and pass.

#### Step 4 — Rule engine (`src/lib/rules`)
- **Build:** Pure `evaluate(conditionJson, context) → action` per §3.
- **Gate:** Unit tests for the spec's example rules pass: refund received + past SLA
  → finance queue; subcategory "not as described"/"damaged" → require photo;
  within-window check.

#### Step 5 — Intake state machine (`src/lib/intake`)
- **Build:** Taxonomy-driven machine: category → subcategory → required fields →
  case assembly, Tier-0 mode (no integration; item_ref captured as text per §6.4).
  Include a **local message simulator** so it can be driven without WhatsApp.
- **Gate:** Tests feed several messy sample inputs and assert a correct, complete
  structured case is produced, asking only for missing fields.

#### Step 6 — Case persistence & handoff package
- **Build:** Persist cases/case_fields/case_items; produce the clean "agent handoff"
  JSON (category, subcategory, normalized fields, selected items, photo refs).
- **Gate:** An integration test runs a full Tier-0 intake via the simulator, writes
  the case, reads it back, and asserts the handoff JSON matches.

#### Step 7 — Merchant config UI
- **Build:** UI to toggle categories, edit labels/required fields, and set
  return_window_days / refund_sla_days. Respect locale/RTL flag.
- **Gate:** Changes persist and visibly change what the intake simulator asks for;
  basic component/e2e test or a clear manual walkthrough.

**→ Phase A complete. Stop. Do not begin Phase B until I confirm and provide
credentials.**

### Phase B — Integrations (needs external accounts; gated)

#### Step 8 — WhatsApp Business API wiring
- **Build:** Webhook receive; send static **List Messages** for category/subcategory
  (the "Listeyi Gör" pattern); map real inbound messages into the Step 5 machine.
- **Gate:** A real message in the Meta WABA sandbox drives a category selection and
  produces a Tier-0 case.

#### Step 9 — First connector (İkas or Shopify)
- **Build:** OAuth "connect store" in the merchant UI; read an order + its line items
  by order_number. Per §5, own-store platform, self-serve connect.
- **Gate:** Connect flow completes; `getOrder(order_number)` returns real line items;
  `integration_tier` for the merchant flips to 1.

#### Step 10 — Dynamic item-picker Flow (§6)
- **Build:** Data-exchange endpoint (RSA-2048 encryption, hosted by us); cache the
  order at the `ORDER_NUMBER` screen; `SELECT_ITEMS` CheckboxGroup populated from the
  live order; selected ids → `case_items`.
- **Gate:** In WhatsApp, the customer picks real items from a real order and the case
  records the correct line-item ids.

---

## Definition of done (per step)
Gate passes • tests green • lint clean • committed • step report posted • my sign-off
received. Only then move on.
EOF
