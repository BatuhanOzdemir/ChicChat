# ChicChat — Product Specification (v0.3)

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

## 3. Scope at a glance

DELIVERED (v0.2): chat simulator (dev/test UI) · merchant-defined taxonomy via UI
(full CRUD) · hardened error handling (§13) · minimal agent case console ·
merchant case views · basic analytics counters · KVKK basics · multi-tenancy seam.
IN (v0.3): AI-assisted intake (§17) — first-message classification and
free-text-to-choice mapping, both confirmed by the customer · masking before
any AI call · per-merchant on/off switch · test set and accuracy scoring.
OUT: İkas and other commerce integrations, and the live item-picker Flow
(dropped for now, November 2026 — §§6, 14) · new Meta work beyond keeping the
existing integration running · user-defined SLA engine (v0.4) ·
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
tappable lists/buttons, never free-text questions.** A customer who types an
answer instead of tapping may be offered the closest listed value to confirm
(§17); the list itself is always shown.

## 6. Conversation layer

- Static List Messages: category/subcategory menus (≤10 rows).
- *Not in current scope (needs an order integration, §14): the two Flow items
  below. Simulated Flow payloads remain in the simulator.*
- Dynamic WhatsApp Flow (data-exchange): order-item picker for categories 2/3/5,
  exchange variant picker, live refund status. RSA-2048 encryption; cache order at
  ORDER_NUMBER step; screens: ORDER_NUMBER → SELECT_ITEMS → REASON → [PHOTO] →
  REVIEW. Endpoint contract as previously specified.
- Agent/console-triggered picker: same Flow, fired manually from the case console
  within an open 24h service window. Never business-initiated cold sends without
  approved templates + opt-in.
- First message of any new conversation includes the KVKK disclosure line.

## 7. Chat simulator (introduced in v0.2)

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
  fields), and on completion the persisted case JSON; with AI-assisted intake
  (§17), the model's proposal and confidence.
- AI controls (§17): force the AI to time out or fail, to show the menu fallback.
- Reset button: clears the session for that phone.
- This screen doubles as the merchant sales demo.

## 8. Merchant console

- Taxonomy editor (full CRUD per §4).
- Policy settings: return_window_days, refund_sla_days, locale/RTL, KVKK
  aydınlatma metni URL, retention period.
- AI-assisted intake on/off (§17), off by default.
- Integration connect (İkas private-app credentials; Shopify/Woo next) — not in
  current scope (§14).
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
  note. (Firing the item-picker Flow is not in current scope, §6.)
- Explicit non-goals (v0.2 and v0.3): replying to customers from ChicChat,
  assignment rules, notifications.

## 10. Non-functional requirements

Webhook route verifies the signature, durably stores accepted messages, then
returns 200; intake processing happens after acknowledgement. If durable
acceptance fails, return 503 so Meta retries rather than silently losing work.
Flow data-exchange endpoint is the one hard latency budget
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
photos in private storage. The September repair uses private PostgreSQL bytea
storage (10 MB per photo) and authenticated merchant-scoped image routes;
there are no public media URLs. Existing expired Meta-only references cannot
be recovered retroactively.

Console access uses named accounts, salted password hashes, expiring opaque
sessions, and explicit merchant memberships. Every member can operate the
console for their assigned merchants. Finer admin/agent roles remain future work.

## 13. Failure scenarios (defined behaviour)

| Scenario | Behaviour |
|---|---|
| Malformed payload | Log, drop, return 200 |
| Bad signature | 401 + warning log |
| Order not found (Tier 1) | Inform, one retry, then continue Tier-0 |
| Multiple matching orders | Disambiguate by order date (list, ≤10) |
| Integration down | Degrade conversation to Tier-0; flag on case; log |
| DB down before durable acceptance | 503 to Meta for retry; sanitized error log |
| Processing fails after acceptance | Keep inbox work for retry; preserve/mark errored session; queue one generic reply |
| Reply delivery fails | Preserve the outgoing reply; retry with backoff; show pending delivery in the console |
| Duplicate webhook | One intake effect; already-persisted pending replies remain retryable |
| Flow endpoint failure | Error screen with retry; cache minimizes |
| Unknown/unexpected exception | Catch at handler boundary; log with stack + correlation id; send generic "something went wrong, an agent will follow up"; mark session `errored`; surface in merchant console |
| Abandoned conversation | TTL rules (§11) |
| AI provider slow, failing or returning invalid output | Continue with the normal menus; one structured log line; no customer-visible error (§17) |
| Customer rejects an AI suggestion | Normal menus or the full choice list; nothing from the rejected suggestion is kept |

## 14. Integrations

*Not in current scope: integrations were dropped for now in November 2026 and
Tier 0 is the only tier. The design below is kept for when they return.*

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

## 17. AI-assisted intake (v0.3)

A small, fast language model helps the customer skip questions they have already
answered. It only ever **proposes**; the customer confirms. The deterministic
menu flow remains the always-available fallback, and everything is testable in
the simulator.

- **Per-merchant switch**, off by default. Off means behaviour identical to v0.2.
- **First message only:** the first free-text message of a new conversation is
  classified into {category, subcategory, extracted fields} with a confidence.
  Confident → one Yes/No confirmation summarising the understanding; Yes fills
  the confirmed values and skips those questions; No or low confidence → the
  normal category menu. Later messages are never re-classified.
- **Free-text answers to choice fields:** when a typed answer matches no listed
  value, the model proposes the closest listed value as a Yes/No confirmation;
  No re-shows the list. A proposal is always one of the merchant's listed values.
- **Masking:** phone numbers and order numbers are replaced with placeholders
  before any text leaves the server. Order numbers are still extracted locally
  by the existing normalizer (§5), so the model never sees them.
- **Languages:** Turkish, English and mixed messages.
- **Transparency:** case detail and console mark values the AI proposed and the
  customer confirmed; analytics report the acceptance rate.
- **Quality:** a versioned test set of example messages with expected answers,
  and a scoring script; accuracy is measured, not judged by eye.
- **Failure:** see §13 — the conversation always continues on the menus.
- **KVKK:** sending customer text to an AI provider needs fuller legal treatment
  (disclosure wording, cross-border transfer); masking and the merchant switch
  are the v0.3 baseline, the rest is a later stage.

## 18. Future (explicitly deferred)

- **v0.4 — SLA engine:** user-defined SLAs with breach alerts on the dashboard.
- Agent replies from ChicChat; Admin App store listing; Phase 2 write actions.
