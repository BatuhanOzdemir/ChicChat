# ChicChat — Product Specification (v0.2)

WhatsApp-native structured-intake and triage for apparel merchants. The bot turns a
messy customer complaint into a clean, structured case; agents resolve cases faster;
merchants configure everything without code.

This file defines WHAT to build. `CLAUDE.md` defines how we work and the current
build plan. `ENGINEERING-HANDBOOK.md` defines lasting engineering standards.

---

## 1. Vision & thesis

Customers struggle to articulate complaints and don't know internal procedures.
Agents waste time extracting basics (order numbers, item identification, photos).
ChicChat structures the customer *before* the agent sees them. Phase 1: clean
handoff to humans. Phase 2 (future): autonomous resolution of routine cases.

## 2. Personas

- **Customer** — messages the merchant on WhatsApp; may be vague, messy, emotional.
- **Agent** — resolves cases; needs complete, normalized, routed cases.
- **Merchant admin** — configures taxonomy, policies, integrations; watches volume.
- **Developer (Batuhan + Claude Code)** — needs a fast local loop without Meta.

## 3. v0.2 scope at a glance

IN: chat simulator (dev/test UI) · merchant-defined taxonomy via UI (full CRUD) ·
hardened error handling (SPEC §13) · minimal agent case console · merchant case
views · basic analytics counters · KVKK basics · multi-tenancy seam.
OUT (deferred): LLM classify/extract (v0.3) · user-defined SLA engine (v0.4) ·
agent-to-customer messaging inside ChicChat · Admin App store packaging ·
autonomous resolution (Phase 2).

## 4. The taxonomy (opinionated default — 8 categories)

Shipped as editable seed data, not hardcoded. Categories: WISMO · Return request ·
Exchange · Refund not received · Wrong/damaged/missing item · Cancel or modify ·
Sizing & fit help · Other/human. Full definitions (subcategories, required fields,
computed fields, routing, Phase-2 actions) as previously specified — unchanged in
v0.2 except: **all of it must be merchant-editable through the UI** (create,
rename, disable, reorder categories/subcategories; add/remove/require fields;
edit routing rules) with the defaults pre-loaded per merchant at signup.

## 5. Field types & normalization

Field types: string · enum · media(photo) · ref(item) · computed. Normalization
runs on capture (core IP): order_number cleaning (strip `/ # spaces`, leading
zeros, uppercase, merchant regex validation; keep raw + normalized), enum
constraint, item fuzzy-match at Tier 0. **Enum fields must always render as
tappable lists/buttons, never free-text questions.**

## 6. Conversation layer

- Static List Messages: category/subcategory menus (≤10 rows).
- Dynamic WhatsApp Flow (data-exchange): order-item picker for categories 2/3/5,
  exchange variant picker, live refund status. RSA-2048 encryption; cache order at
  ORDER_NUMBER step; screens: ORDER_NUMBER → SELECT_ITEMS → REASON → [PHOTO] →
  REVIEW. Endpoint contract as previously specified.
- Agent/console-triggered picker: same Flow, fired manually from the case console
  within an open 24h service window. Never business-initiated cold sends without
  approved templates + opt-in.
- First message of any new conversation includes the KVKK disclosure line.

## 7. Chat simulator (NEW — the core of v0.2)

The permanent test bench for the whole product — not a single-scenario tool. It
removes Meta from the development loop entirely and remains part of the product:
every build step is demonstrated in it before sign-off, ad-hoc testing happens in
it at any time, and it doubles as the merchant sales demo. As later steps add
features (custom taxonomies, tiers, errored sessions, integrations), the
simulator gains whatever controls are needed to exercise them.

- Route: `/simulator` (excluded from production builds or auth-gated).
- Renders a WhatsApp-like chat; user picks a merchant + customer phone (fake).
- Scenario-agnostic: any category, any taxonomy (including merchant-created
  ones), Tier 0 and simulated Tier 1, error injection (force an exception, force
  integration-down), and time travel (age a session to trigger nudge/abandon).
- Preset scenarios loadable with one click (messy order number, photo flow,
  duplicate message replay) for quick regression checks.
- Messages POST to a simulator endpoint that injects synthetic inbound messages
  directly into the same handler the real webhook uses (bypasses signature only;
  everything downstream is identical, including sessions and persistence).
- Supports: text, tapping list options, simulated photo upload, simulated Flow
  submission payloads (so the item picker logic is testable without WhatsApp).
- Side panel shows live internals: current session state (status, collected
  fields), and on completion the persisted case JSON.
- Reset button: clears the session for that phone.
- This screen doubles as the merchant sales demo.

## 8. Merchant console

- Taxonomy editor (full CRUD per §4).
- Policy settings: return_window_days, refund_sla_days, locale/RTL, KVKK
  aydınlatma metni URL, retention period.
- Integration connect: İkas private-app credentials (client_id/secret) v0.2;
  Shopify/Woo next.
- **Case views:** list of all cases (filter by status/category/date/order number),
  case detail (all fields raw+normalized, items, photos, timeline), including
  `abandoned` cases.
- Basic analytics: counts by category/status/day; median time-to-complete intake;
  abandonment rate. (SLA engine deferred.)

## 9. Agent case console (minimal by design)

- Case queue: open cases, sorted by priority/age; filter by queue/category.
- Case detail: the handoff package — category, subcategory, normalized fields,
  selected order items, photos, routing flags, conversation transcript (read-only).
- Actions: change status (open → in_progress → resolved/closed), add internal
  note, fire the item-picker Flow into an open conversation.
- Explicit non-goals in v0.2: replying to customers from ChicChat, assignment
  rules, notifications.

## 10. Non-functional requirements

Webhook route returns 200 immediately after signature check; processing after
acknowledgement. Flow data-exchange endpoint is the one hard latency budget
(Meta health checks throttle/block slow endpoints) — mitigate via order caching.
Small fixed number of DB queries per message.

## 11. Reliability

Idempotent processing by WhatsApp message ID (dupes never create dupes).
`persistCase` transactional.

**Session inactivity (nudge, then abandon — both merchant-configurable):**
- After `nudge_after_minutes` (default **5**) of customer silence mid-intake, the
  bot sends one gentle resume prompt ("Devam etmek ister misiniz? Kaldığınız
  yerden sürdürebiliriz."). One nudge per session, free within the service window.
- Progress is NEVER discarded early — a returning customer always resumes from
  where they left off. (Rationale: WhatsApp is asynchronous; discarding partial
  progress forces a restart, the exact frustration this product removes.)
- After `abandon_after_hours` (default **24**, aligned with the service window),
  the cleanup job marks sessions with ≥1 captured field as
  `cases.status='abandoned'` and deletes empty ones.

## 12. Security & privacy (KVKK)

Verify X-Hub-Signature-256; validate all payloads at boundaries; never log
secrets or unmasked phones (mask to last 4); generic user-facing errors.
KVKK: disclosure line at conversation start; merchant-configurable retention
(default 12 months) with hard delete; per-phone-number deletion operation;
photos in private buckets.

## 13. Failure scenarios (defined behaviour)

| Scenario | Behaviour |
|---|---|
| Malformed payload | Log, drop, return 200 |
| Bad signature | 401 + warning log |
| Order not found (Tier 1) | Inform, one retry, then continue Tier-0 |
| Multiple matching orders | Disambiguate by order date (list, ≤10) |
| Integration down | Degrade conversation to Tier-0; flag on case; log |
| DB down | 200 to Meta; error log; "try again shortly" if send possible |
| Duplicate webhook | Idempotency skip |
| Flow endpoint failure | Error screen with retry; cache minimizes |
| Unknown/unexpected exception | Catch at handler boundary; log with stack + correlation id; send generic "something went wrong, an agent will follow up"; mark session `errored`; surface in merchant console |
| Abandoned conversation | TTL rules (§11) |

## 14. Integrations

Tier model: 0 none (always works) · 1 read (lookups + item picker) · 2 write
(Phase 2). İkas first: Private App, client_credentials at
`https://<store>.myikas.com/api/admin/oauth/token`, 4h token expiry with
refresh, GraphQL at `api.myikas.com/api/v1/admin/graphql`, scopes Read
Orders/Products/Inventories/Customers. Dev store for testing. Shopify/Woo
follow. Marketplaces deferred.

## 15. Scalability assumptions

Single-digit merchants, low thousands of conversations/month, one region, one
Postgres + one Next.js deployment. Revisit when false.

## 16. Observability

Structured JSON logs with merchant_id + correlation id for: webhook in, routing
decision, validation failure, integration call/failure, case persisted,
unexpected exception. Errored sessions visible in merchant console (§13).

## 17. Future (explicitly deferred)

- **v0.3 — LLM classify/extract:** on first free-text message, a lightweight LLM
  proposes {category, subcategory, extracted fields} with confidence; high
  confidence skips answered questions, low confidence falls back to menus.
  Deterministic flow remains the always-available fallback. Testable entirely in
  the simulator.
- **v0.4 — SLA engine:** user-defined SLAs with breach alerts on the dashboard.
- Agent replies from ChicChat; Admin App store listing; Phase 2 write actions.
