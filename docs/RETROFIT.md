# RETROFIT — v0.1 code audited against the Engineering Handbook

Audit performed at v0.2 Step 0 against commit `5faa804` (end of v0.1).
**No fixes are applied in this document** — it is the findings list. Each item
records the Handbook/SPEC rule, evidence (file:line), severity, and the v0.2
step that is scheduled to resolve it.

### Progress

| Step | Resolved findings |
|---|---|
| Step 0 | R1 (typecheck script) |
| Step 1 | R5 (dead `health.ts`), R6b (seed-test isolation) |
| Step 2 | **R3, R4, R8, R9, R11, R12, R14, R15, R16, R17, R19** — all six HIGH boundary/reliability findings plus the medium ones in scope |
| Step 3 | **R6** (config actions now validated + covered), **R10** (config boundary), **R18** (enum fields render as tappable lists), **R21** (field ordering via `sort_order`) |
| Step 4 | **R6** (case views), **R10**, **R18**, **R21** — see the Step 4 report; intake duration recorded, analytics distinguish "no data" from zero |
| Step 5 | **R22 (partly)** — agent console shipped, so §9 is no longer missing. Two defects found and fixed while building it: routing-rule precedence was decided by a random uuid (rules written in one transaction share `now()`), now an explicit `sort_order`; and append-only logs ordered by `now()` tie inside a transaction, now `clock_timestamp()` |

| Step 6 | **R20** — the demo-merchant hardcode is gone: the webhook resolves its tenant from `phone_number_id`, the console from a merchant switcher, and every read/write path is scoped and tested against a second merchant. **R6b again**: the inactivity assertions scoped to their own conversation, since the sweep spans a merchant's whole session set |

Still open: R2 (`node:crypto` in `lib` — a decision, not a defect), R7 (fixture
in `lib`), R13 (KVKK — settings and disclosure URL exist as of Step 3; retention
enforcement and per-phone deletion remain, and the transcript added in Step 5
falls under the same retention policy), R22 (remaining v0.2 scope: connector,
Flow).

Deferred deliberately, with the reason: per-merchant WhatsApp **access tokens**
(the environment still holds one token; the number to send *from* is already
per-merchant) — deployment secrets, Step 7. Console **authentication**: the
merchant switcher is a cookie, so anyone reaching the console can act as any
tenant — also Step 7, and the reason the switcher validates its input against
the real merchant list rather than trusting it.

Severity: **HIGH** = correctness/security risk in production · **MED** =
standards violation with real consequences · **LOW** = hygiene.

---

## Already compliant (verified, not assumed)

| Rule | Evidence |
|---|---|
| H§2 `src/lib` purity | grep for `react`/`next`/`pg`/`@supabase`/`process.env`/`fetch(` in `src/lib` → no matches |
| H§2 `db` never imported by `lib` | no `../../db` imports in `src/lib` |
| H§2 Deps injection | `src/server/whatsapp/handler.ts:17` (`IntakeDeps` with `db` + `send`) |
| H§2 session state in DB, not memory | `src/db/sessions.ts`, `supabase/migrations/20260622130000_intake_sessions.sql` |
| H§3 no `any` | grep `: any`/`as any`/`<any>` across `src` → no matches |
| H§3 naming | files kebab-case (`order-number.ts`), types PascalCase, DB snake_case |
| H§4 lib unit tests | every exported function in `src/lib` has a colocated `*.test.ts` (17 files checked; only `index.ts`/`types.ts`/`fixtures.ts` have no functions) |
| H§5 secrets | `.env.example` maintained; only `.env.example` tracked by git; `.env.local` ignored |

---

## H§1 — Stack & scripts

**R1 · `typecheck` script missing — RESOLVED IN THIS STEP.**
`package.json` had no `typecheck`. Added `"typecheck": "tsc --noEmit"`.
Also bumped `version` to `0.2.0`.

---

## H§2 — Architecture

**R2 · LOW · `node:crypto` imported inside pure `lib`.**
`src/lib/whatsapp/verify.ts:6` imports `createHmac`, `timingSafeEqual`. The
Handbook bans frameworks/DB/env/fetch but is silent on Node builtins, so this is
not strictly a violation — flagging it as a decision: either state explicitly in
the Handbook that Node builtins are allowed in `lib`, or move signature
verification to `src/server` (it is transport security, not domain logic).
*Needs your call; no behaviour change either way.*

---

## H§3 — Code standards

**R3 · MED · Functions exceed the ≲60-line guideline.**
`src/lib/intake/machine.ts` — `advance()` is **75 lines** (from :185),
`proceed()` is **62 lines** (from :110). Both are dispatch-shaped and will grow
in v0.2 (enum prompts, nudge/abandon, errored state), so they need splitting
before that. *Target: Step 2 (touching the machine anyway).*

**R4 · MED · `lib` throws instead of returning typed results.**
`src/lib/intake/machine.ts:30` — `throw new Error(\`unknown category: …\`)`.
Handbook §3 requires typed errors / discriminated result types in `lib`. This
throw currently propagates to the webhook boundary and, per R11, results in the
customer receiving *nothing*. *Target: Step 2.*

**R5 · LOW · Dead scaffolding still shipped.**
`src/lib/health.ts` + `src/lib/health.test.ts` — the trivial `ping()` smoke
module from v0.1 Step 0. Referenced only by its own test. *Delete; target: Step 1.*

---

## H§4 — Testing

**R6 · MED · Untested orchestration logic.**
`src/app/config/actions.ts` (`saveConfig`) parses form data and performs
per-category/per-field writes with no tests. `src/db/client.ts` (`getPool`) is
also untested. Handbook §4 requires orchestration integration tests with fake
deps. *Target: Step 3 (the taxonomy editor rewrites this action).*

**R6b · MED · Seed test is not isolated from real data (currently failing).**
`src/db/seed.integration.test.ts:18-28` — `EXPECTED_COUNTS` asserts
`cases: 1`, i.e. a **global** count of every case belonging to the demo
merchant, rather than only the seeded demo case (`CASE_ID`). Any real case makes
it fail: the local DB now holds 3 cases (the seeded one plus two created by the
v0.1 live WhatsApp tests), so `test:db` reports **83/84 passing, 1 failing**.
The other 8 counted tables are correctly scoped; only `cases` is not.
Discovered by running the suite in this step — it is a pre-existing test defect,
not a Step 0 regression. Fix by scoping the count to `CASE_ID` (or asserting
`>= 1`); do **not** "fix" it by deleting the live cases, which are the evidence
of the v0.1 milestone. *Target: Step 1.*

**R7 · LOW · Test fixture lives in production `lib`.**
`src/lib/intake/fixtures.ts` (`demoIntakeConfig`) is test data inside the
shipped domain tree. Move under a test-only path. *Target: Step 1.*

---

## H§5 — Security & privacy

**R8 · HIGH · Webhook signature verification is optional.**
`src/app/api/whatsapp/webhook/route.ts:47` — `if (cfg.appSecret) { … }`. With
`WHATSAPP_APP_SECRET` unset (its current state), **every unsigned POST is
accepted and processed**. Handbook §5 and SPEC §12 require verification.
Must be mandatory outside the simulator path. *Target: Step 2 (enforced in Step 8
for the deployed environment).*

**R9 · HIGH · No idempotency by message ID.**
`src/lib/whatsapp/inbound.ts:44` parses `messageId`, and it is never persisted
or checked anywhere (grep: only the parse site and the type). Meta retries
deliveries, so a duplicate advances the state machine twice and can produce
duplicate cases. Handbook §5/§6, SPEC §11. *Target: Step 2.*

**R10 · MED · No declarative validation at boundaries.**
`parseInbound` reads shapes defensively by hand; `src/app/config/actions.ts`
only coerces integers (`toInt`). Handbook §5 requires all external input to be
validated and parsed at the boundary (webhooks, forms, and — new in v0.2 — Flow
payloads and connector responses). *Target: Step 2.*

**R11 · HIGH · Unstructured logging that can leak an unmasked phone number.**
`src/app/api/whatsapp/webhook/route.ts:68` —
`console.error("[whatsapp] handleInbound failed:", err)`. The error message
embeds the Graph API response body, which contains the **full recipient phone
number** (observed live in v0.1: the `131030` error text included it). No
masking helper exists anywhere in `src`. Handbook §5 requires masking to the
last 4 digits and no secrets/PII in logs. *Target: Step 2.*

**R12 · MED · Customer gets no message when processing fails.**
Same catch block: the exception is logged and swallowed, so the customer is left
with silence. SPEC §13 requires a generic "something went wrong, an agent will
follow up". *Target: Step 2.*

**R13 · SPEC §12 · KVKK not implemented (new scope, not a regression).**
No disclosure line on first message, no retention config or hard delete, no
per-phone deletion operation, and photos are stored only as WhatsApp media ids
(no private bucket). *Target: Steps 2–4.*

---

## H§6 — Reliability

**R14 · HIGH · `persistCase` is not transactional.**
`src/db/cases.ts:65` writes `cases`, then loops `case_fields`, then loops
`case_items` — multiple statements, no transaction of its own (the doc comment
defers it to the caller). The only production caller,
`src/server/whatsapp/handler.ts:41`, does **not** open one (grep for `begin`
outside tests: only `scripts/seed.mjs:525`). A failure mid-write leaves a case
row with partial fields/items. Handbook §6 requires transactional multi-record
writes; SPEC §11 names `persistCase` explicitly. *Target: Step 2.*

**R15 · MED · No `errored` (or `abandoned`) session state.**
`intake_sessions` has no status column (`supabase/migrations/20260622130000_intake_sessions.sql`)
and nothing marks a session errored; `cases.status` allows
`open|needs_info|handed_off|escalated|resolved` but not `abandoned`
(`20260622120000_init_schema.sql:97`). Handbook §6 and SPEC §§11/13 both need
these states, plus merchant-console surfacing. *Target: Step 2 (schema) / Step 4 (views).*

---

## H§7 — Performance

**R16 · MED-HIGH · Per-message query count grows with taxonomy size.**
`src/db/config.ts` — `loadMerchantConfig` issues `3 + 2N` queries (merchant,
settings, categories, then subcategories + field_defs **inside a loop per
category**). `buildIntakeConfig` wraps it and `handleInbound` calls it on
**every inbound message** → ~19 queries per message for the default 8-category
taxonomy, before `loadSession`/`saveSession`. SPEC §10 requires a small *fixed*
number of DB queries per message. Fix with a single joined query (or a
short-lived per-merchant cache). *Target: Step 2.*

---

## H§8 — Observability

**R17 · HIGH · No structured logging.**
Exactly one log statement exists in the app (`route.ts:68`, plain
`console.error`). None of the six required events (webhook in, routing decision,
validation failure, integration call/failure, case persisted, unexpected
exception) are logged, and no line carries `merchant_id` or a correlation id.
Handbook §8, SPEC §16. *Target: Step 2.*

---

## SPEC-level gaps (product behaviour, scheduled by the v0.2 plan)

**R18 · HIGH (UX) · Enum fields are asked as free text.**
`src/lib/whatsapp/messages.ts:85-92` renders every non-media field as
"Please share your `<key>`", so enum fields never show their allowed values.
`src/lib/intake/types.ts:72-80` has no enum-selection `Prompt` variant. This is
the concrete failure hit live in v0.1 (`refund_method` — the user could not know
to type `bank_transfer`). SPEC §5 requires enum fields to **always** render as
tappable lists/buttons. *Target: Step 1 (simulator must show it) / Step 2.*

**R19 · MED · Webhook acknowledges only after full processing.**
`route.ts:64-72` awaits `handleInbound` for every message before returning 200.
SPEC §10 requires 200 immediately after the signature check, with processing
after acknowledgement. *Target: Step 2.*

**R20 · MED · Single-tenant hardcode.**
`route.ts:24` — `resolveMerchantId()` ignores `phone_number_id` and returns
`DEMO_MERCHANT_ID`; `src/app/config/page.tsx:14` and
`src/app/config/actions.ts:22` hardcode the same constant. *Target: Step 6.*

**R21 · LOW · Field ask-order is alphabetical.**
`field_defs` has no `sort_order` column, and `loadMerchantConfig` orders fields
`by key`, so intake asks `description` before `order_number`. Observed live in
v0.1. *Target: Step 3 (taxonomy editor should own ordering).*

**R22 · Known-missing v0.2 scope (not regressions).**
No simulator (SPEC §7 → Step 1); config UI is toggles only, no CRUD (SPEC §8 →
Step 3); no case list/detail/analytics (→ Step 4); no agent console (SPEC §9 →
Step 5); no session nudge/abandon or cleanup job (SPEC §11 → Step 2); no İkas
connector (SPEC §14 → Step 9); no Flow item picker (SPEC §6 → Step 10).

---

## Summary

| Severity | Count | Items |
|---|---|---|
| HIGH | 6 | R8, R9, R11, R14, R17, R18 |
| MED | 11 | R3, R4, R6, R6b, R10, R12, R15, R16, R19, R20, R13* |
| LOW | 5 | R2, R5, R7, R21, and R22 (scope, not defect) |

\* R13 (KVKK) is new scope rather than a regression, but carries legal weight.

**Load-bearing conclusion:** the v0.1 domain core (`src/lib`) is architecturally
sound — pure, typed, fully unit-tested, correctly separated. Every HIGH finding
sits in the **boundary and reliability layers** (webhook auth, idempotency,
transactionality, logging) plus one conversation-rendering gap (enum prompts).
That is exactly what v0.2 Step 2 is scoped to fix, with the enum gap surfacing
in Step 1's simulator.
