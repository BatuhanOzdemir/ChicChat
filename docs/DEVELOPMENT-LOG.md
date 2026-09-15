# DEVELOPMENT LOG — ChicChat, from first commit to the close of v0.2

Historical record through August 2026. For subsequent reliability, privacy,
authentication and simulator repairs, see `REPAIR-REPORT.md`. Statements below
about shared passcodes, missing retention and pointer-only media describe the
August implementation, not the repaired code.

Written 2026-08-28, at the close of v0.2. This is the narrative record of how
the product was built: what shipped in each step, what each verification gate
actually caught, which decisions diverged from the spec and why, and what is
deliberately not here.

It complements rather than repeats the other documents:

| Document | Answers |
|---|---|
| `docs/SPEC.md` | **What** the product must do (source of truth for behaviour) |
| `docs/ENGINEERING-HANDBOOK.md` | **How** code must be written (lasting standards) |
| `CLAUDE.md` | The working agreement + the v0.2 build plan |
| `docs/RETROFIT.md` | The v0.1-vs-Handbook audit, and which step closed each finding |
| `docs/DEPLOYMENT.md` | The runbook for deploying and operating it |
| **this file** | What actually happened, in order, and why |

---

## 1. What ChicChat is

Customers struggle to articulate complaints and do not know a merchant's
internal procedures. Agents waste their time extracting basics — order numbers,
which item, a photo of the damage. ChicChat structures the customer *before* the
agent sees them.

It is a WhatsApp-native structured-intake and triage bot for apparel merchants.
A customer messages the merchant's WhatsApp number; ChicChat walks them through
a merchant-defined taxonomy using tappable list menus, normalizes and validates
what they give, applies the merchant's routing rules, and files a complete case
into an agent console. Phase 1 is a clean handoff to a human. Phase 2 —
autonomous resolution — is explicitly out of scope.

**Four personas** shaped every decision: the *customer* (vague, messy,
sometimes emotional), the *agent* (needs complete, normalized, routed cases),
the *merchant admin* (configures taxonomy and policy without touching code), and
the *developer* (needs a fast local loop that does not involve Meta).

That last persona is why the simulator exists, and the simulator turned out to
be the single most valuable thing in the build.

---

## 2. The shape of the project

| | |
|---|---|
| **Repository** | `BatuhanOzdemir/ChicChat` (private), single `main` branch |
| **First commit** | 2026-06-21 |
| **v0.2 closed** | 2026-08-28 (68 days) |
| **Commits** | 32, conventional, one or more per approved step |
| **Source** | 117 TypeScript/TSX files, ~13,600 lines |
| **Tests** | 304 passing — 168 DB-free unit, 136 integration |
| **Migrations** | 7, forward-only |
| **Tables** | 15 |
| **Tenants live** | 2 (one English, one Turkish taxonomy) |

### Stack

Next.js 16 (App Router) · TypeScript strict · Tailwind v4 · PostgreSQL via
Supabase · Vitest · ESLint + Prettier. Runtime dependencies are deliberately
four: `next`, `react`, `react-dom`, `pg`. No ORM, no state library, no
component library, no HTTP client — `fetch` and hand-written SQL throughout.

That restraint was a Handbook decision, not an accident. The domain logic is
small and precise; an ORM would have hidden exactly the transactional details
(see §7, Step 2) that turned out to matter most.

### Architecture

```
app  ──→  server  ──→  lib
(UI + API)  (orchestration)  (pure domain)
     │
     └──→  db  (persistence)
```

The rule that carried the most weight: **`src/lib` imports no framework, no
database, no environment, no `fetch`.** It is pure functions over plain data.
Everything that talks to the outside world lives in `server/` or `db/`, and
every one of those boundaries parses and validates its input rather than
trusting it inward.

The second rule that mattered: **discriminated results over thrown errors.**
Domain functions return `{ ok: true, value }` or `{ ok: false, error }`. Nothing
in `lib` throws for a condition the caller is expected to handle.

---

## 3. How the build was run

The working agreement in `CLAUDE.md` is unusual enough to be worth recording,
because the process is a large part of why the outcome is what it is.

1. Implement **exactly one** numbered step, then stop.
2. Every step has a written **verification gate**; run it and show the output.
3. Post a step report and **wait for explicit sign-off** before the next step.
4. Commit after each approved step (conventional commits).
5. No skipping ahead, no early scaffolding of future steps.
6. Ambiguity → ask one focused question, do not guess.
6b. **From Step 1 onward, every step with user-visible behaviour must be
    demonstrable in the simulator.** "Works but cannot be shown" fails the gate.
7. Definition of Done: gate ✓ · lint ✓ · typecheck ✓ · tests ✓ · Handbook
   standards respected · committed · report posted · sign-off received.

Rule 6b is the one that repeatedly paid for itself. A passing test suite proves
that the thing you wrote does what you thought; operating the product proves
whether what you thought was the right thing. §9 catalogues what the difference
found.

---

## 4. Data model

Seven forward-only migrations, in order:

| Migration | Adds |
|---|---|
| `init_schema` | merchants, merchant_config, categories, subcategories, field_defs, routing_rules, integrations, cases, case_fields, case_items |
| `intake_sessions` | the in-flight conversation state |
| `hardening` | processed_messages (idempotency ledger), session lifecycle columns |
| `taxonomy_editor` | `sort_order` on field_defs, KVKK URL + `retention_months` policy columns |
| `case_views` | indexes and columns for filtering and analytics |
| `agent_console` | case_events (status changes, notes, routing), conversation_messages (transcript) |
| `multi_tenancy` | whatsapp_channels — maps a `phone_number_id` to a merchant |

Two schema decisions are worth calling out because they were both learned the
hard way rather than designed up front:

**Append-only tables use `clock_timestamp()`, not `now()`.** PostgreSQL freezes
`now()` for the duration of a transaction, so rows written together in one
transaction all share a timestamp and `order by created_at` is not a stable
order. This bit twice in Step 5 — once in the event/transcript ordering, once in
routing-rule precedence, which was silently being decided by uuid comparison.
Routing rules now carry an explicit `sort_order`.

**Subcategories are their own table**, not a self-reference on `categories`.
`cases.subcategory_id` does not join to `categories` — a detail that has caused
at least one wrong ad-hoc query during this build.

---

## 5. v0.1 — the prototype (June 21 – July 7)

Nine steps, built before the v0.2 discipline existed, ending at commit
`5faa804`. It is worth recording because v0.2 is largely a rewrite of its
edges rather than its core — the domain logic here survived.

| Step | Commit | Delivered |
|---|---|---|
| 0 | `69bf01d` | Scaffold: Next.js + TS + Tailwind, Vitest, ESLint/Prettier, Supabase config, npm scripts |
| 1 | `e86476c` | Core schema migration + schema integration test |
| 2 | `149c8ed` | Idempotent seed of the opinionated default taxonomy |
| 3 | `128985d` | Order-number normalization + enum constraining |
| 4 | `9ed2654` | Rule engine — `evaluate(condition, context)` |
| 5 | `07c048b` | Taxonomy-driven intake state machine + a local simulator |
| 6 | `a23518e` | Case persistence + the agent handoff package |
| 7 | `831a68d` | Merchant config UI + a config→intake bridge |
| 8 | `5faa804` | WhatsApp webhook + List Messages + inbound→intake→case |

By the end of v0.1 the product worked end to end against a real WhatsApp test
number. It was also, as the audit then established, not safe to run.

---

## 6. The retrofit audit

v0.2 opened by auditing v0.1 against the newly written Engineering Handbook and
producing `docs/RETROFIT.md` — **22 numbered findings, no fixes**. Writing the
findings down before fixing any of them meant each subsequent step could be
scoped against a list rather than against a feeling.

Severity distribution: **6 HIGH**, and the HIGH ones are instructive:

| | Finding |
|---|---|
| R8 | Webhook signature verification was **optional** |
| R9 | **No idempotency** — a redelivered message created a second case |
| R11 | Unstructured logging that could leak an **unmasked phone number** |
| R14 | `persistCase` was **not transactional** — a crash mid-write left a partial case |
| R17 | No structured logging at all |
| R18 | Enum fields were asked as **free text**, so nothing constrained the answer |

Every one of those is a correctness or privacy defect in code that passed its
tests and demonstrably worked. The audit is the reason v0.2 had a plan instead
of a backlog.

R18 is worth noting twice: it was marked resolved in Step 3, and **it came back
in Step 8** in a different form — two fields declared as enums with no values
configured, which degraded silently to free text. See §7 Step 8.

---

## 7. v0.2, step by step

### Step 0 — Docs restructure & retrofit audit
*`9e9b2b6`, `c5454bb` — 2026-07-24*

Installed the v0.2 `SPEC.md` and `ENGINEERING-HANDBOOK.md` into `docs/`,
replaced the old `CLAUDE.md` with the working agreement, deleted superseded
drafts, added `npm run typecheck`, and produced `docs/RETROFIT.md`.

**Gate:** three docs in place; typecheck script runs; findings listed with
file:line references. **Resolved:** R1.

### Step 1 — Chat simulator
*`47275a2` — 2026-07-28*

`/simulator`: a WhatsApp-like chat UI that injects synthetic messages into the
**real** handler — the only bypass is the signature check. Merchant and
fake-phone selectors, text / list-tap / fake-photo / fake-Flow inputs, a live
side panel showing session state and the final case JSON, reset, preset
scenarios, error injection, and session time-travel.

**Gate:** intakes for three different categories completed entirely in the
simulator including the messy-order-number preset; case JSON correct each time;
no Meta credentials configured anywhere. **Resolved:** R5, R6b.

This step is the reason every later step could be verified at all. It is not a
test harness that was thrown away — it is part of the product, used for
development, for ad-hoc testing, and as the merchant sales demo.

### Step 2 — Hardening & unexpected-error handling
*`866d4ed` — 2026-07-28*

The largest single step, closing eleven findings: idempotency keyed on the
WhatsApp message id via a `processed_messages` ledger with a partial unique
index; `persistCase` made transactional; the session inactivity lifecycle
(nudge at a merchant-configured 5 minutes, abandon at 24 hours, progress never
discarded early); a cleanup job; declarative boundary validation; structured
JSON logging with phone numbers masked to the last four digits; and a top-level
handler catch that produces a generic customer message, an `errored` session
state, and one correlated log line.

**Gate:** duplicate replay produces a single effect; a kill mid-persist leaves
no partial case; simulator time-travel shows the nudge at 5 minutes, a
post-nudge reply resuming with all fields intact, and abandonment at the
configured horizon; a thrown error inside the machine produces the generic reply
plus an errored session plus exactly one log line.
**Resolved:** R3, R4, R8, R9, R11, R12, R14, R15, R16, R17, R19.

### Step 3 — Merchant taxonomy editor
*`1f4c52b` — 2026-07-28*

`/config` upgraded from toggles to full CRUD: categories, subcategories, fields
(including required flags and enum values), routing rules, and policy settings
including the KVKK URL and retention horizon. Defaults pre-load per merchant.

**Gate:** create a brand-new custom category with a custom enum field through
the UI and complete an intake using it end to end in the simulator; disable a
default category and watch it disappear from the menu.
**Resolved:** R6, R10, R18, R21.

### Step 4 — Case views & analytics
*`ec2a2f7` — 2026-07-29*

Case list with filters (status, category, date, order number); case detail
showing raw and normalized values side by side, items, photos, timeline, and
both abandoned and errored states; analytics counters by category, status and
day, plus median intake time and abandonment rate.

**Gate:** simulator-generated cases appear correctly in list, filters, detail
and counters; an abandoned and an errored session both surface. A deliberate
refinement landed here: the analytics distinguish "no data" from a genuine zero.

### Step 5 — Agent case console
*`a941770` — 2026-07-29*

`/console`: a queue ordered by the merchant's routing rules with priority and
age, case detail carrying the handoff package and a read-only transcript, status
transitions, and internal notes.

**Gate:** a simulator-generated case flows open → in_progress → resolved with a
note; routing rules land cases in the right queues.

**Two defects found while building it**, both timestamp-related and both
described in §4: routing-rule precedence was effectively random, and append-only
logs tied on `now()` inside a transaction.

### Step 6 — Multi-tenancy seam
*`8b4910f` — 2026-07-29*

The demo-merchant hardcode removed everywhere. The webhook resolves its tenant
from the inbound `phone_number_id` via `whatsapp_channels`; the console resolves
it from a cookie-backed merchant switcher; every read and write path is scoped.
A second tenant, "Butik Moda", with an entirely Turkish taxonomy, exists
specifically so leakage has something to leak *into*.

**Gate:** two merchants with different taxonomies; interleaved simulator
conversations produce correctly scoped sessions and cases; the cross-tenant
leakage test passes. **Resolved:** R20, and R6b for the second time.

### Step 7 — Deployment
*`30080a3`, `e4ff16b`, `b7dfda2`, `b6855cc`, `374953a`, `a3e877b`, `42e865d` — 2026-07-29 → 2026-08-16*

By far the longest step, and the one that found the most. Deployed to Vercel
against hosted Supabase, with console authentication (deferred here from Step 5)
as a shared passcode over every operator surface, failing closed in production;
boot-time environment checks that refuse to start on missing required
configuration; an ungated `/api/health`; and the inactivity sweep scheduled from
GitHub Actions rather than Vercel.

**Gate:** the deployed simulator completes a full intake against the hosted
database; the suite runs green against hosted config.

**Four defects, none of which any test could have caught:**

1. **The Supabase pooler accepted a plaintext connection** when the URI carried
   no SSL parameters — silently, with no warning on either end. And a bare
   `?sslmode=require` *fails*, because this `pg` reads it as `verify-full` and
   rejects Supabase's chain. The correct form is
   `?uselibpqcompat=true&sslmode=require`, verifiable via
   `client.connection.stream.encrypted`.
2. **The scheduled maintenance job had never run.** Its workflow was taking a
   "not configured yet — nothing to do" branch and exiting zero, so a long
   history of green checkmarks in Actions meant nothing at all.
3. **Every operator surface was a navigational dead end** — no link home, none
   sideways. Found by a person clicking around the deployed app. Fixed with one
   shared nav bar over an `(app)` route group, driven by a pure `src/lib/nav.ts`
   so the active-section logic is unit-testable.
4. **One merchant's expired WhatsApp token aborted the entire inactivity
   sweep** for every merchant. Now isolated per session with a `failed` count in
   the summary.

**And R6b a third time** — this one only a hosted database could have exposed.
`begin`/`rollback` makes integration tests independent of each other but **not**
of what is already committed. A leftover session on a fixed fake phone number
made the first message *resume* rather than start fresh; every scripted answer
then landed one step early, no field was captured, and the sweep deleted an
empty session instead of filing an abandoned case. The test failed while the
application was behaving correctly. Fixed with `forgetFakeConversations()` in
`src/db/test-isolation.ts`, called inside each `beforeEach` transaction and
scoped to the `90555%` fake-phone range — never truncating, so it cannot touch a
real deployment's conversations.

**The region migration.** The hosted database was originally created in Mumbai.
Measured from Turkey that cost 210 ms per query; the integration suite took
16 minutes and tripped the default 30-second per-test timeout. Supabase cannot
move a project between regions, so the fix was a new project in Frankfurt
(`eu-central-1`) and a re-push. Result: **44 ms per query, suite down to
4 minutes**, comfortably inside the default timeout. Region choice is free on
every Supabase plan. The Mumbai project was deleted.

### Step 8 — Meta re-wiring
*`9a193db`, `71a6d8d`, `d24ab0d`, `fd2d23e` — 2026-08-16 → 2026-08-28*

Pointed the Meta test-number webhook at the deployed URL, implemented the KVKK
disclosure on the first message of every new conversation, and verified the
signature path in production mode.

**Gate:** a real WhatsApp message from a real phone round-tripped through the
deployed app into a real case — return / doesnt_fit, four fields captured, a
fourteen-row transcript. Three identical signed deliveries produced exactly one
effect. Unsigned, wrong-key and tampered payloads were all rejected with 401.

**What live traffic exposed:**

- The webhook was still pointed at a **`trycloudflare` tunnel that had been dead
  for weeks**.
- `WHATSAPP_APP_SECRET` existed on Vercel as an **empty key** — the variable
  name was present, so every check that looked at names rather than values had
  been passing. Signature verification could not have worked.
- The **KVKK URL had been storable and editable since Step 3 but never left the
  database.** Customers were told nothing. Fixed by attaching the disclosure to
  the opening prompt only — `startIntake` adds it, nothing else does, so a
  re-ask after unrecognized input does not repeat it.
- **R18 returned.** `return.reason` and `exchange.reason` were declared
  `type: enum` with `enum_values: null`, so the machine degraded them to
  free-text questions and stored prose ("Doesnt fit", "too small") in fields the
  schema calls enums. No routing rule matching a reason value could fire
  reliably. Fixed at sign-off by giving both fields values; labels derive
  automatically from the keys, so this was a pure data change with no code and
  no deploy.

`exchange.desired_variant` deliberately keeps `enum_values: null` — it is
catalog-driven and was to be filled by the Step 9 connector. With Step 9
deferred, it remains a free-text question. That is a known gap, not a defect.

---

## 8. Steps 9 and 10 — deferred, not dropped

**Step 9 — İkas connector.** Private-app credential entry in the merchant
console; `client_credentials` token fetch with 4-hour refresh cached per
merchant; `getOrder` over GraphQL against a free İkas dev store; tier flip from
0 to 1; Tier-0 degradation when the integration is unavailable. Deferred on
2026-08-28 for want of a store to connect to.

To resume, six things are needed: a free İkas dev store; a Private App created
in it; that app's client id and secret; scopes for Read Orders / Products /
Inventories / Customers; the store subdomain (the token endpoint is
`https://<store>.myikas.com/api/admin/oauth/token`); and at least one test order
with several line items. Credentials belong per-merchant in the database via a
console screen, not in environment variables — and should be encrypted at rest
before a real secret is stored.

**Step 10 — Item-picker Flow.** The data-exchange endpoint (RSA-2048), order
caching at the ORDER_NUMBER step, `SELECT_ITEMS` from a live dev-store order,
selections written to `case_items`. Its gate requires a customer picking real
line items out of a real order, so it **inherits Step 9's dependency**; it is
additionally blocked while Meta returns an app-level `API access blocked`.

Neither is abandoned. Everything they would have delivered remains listed under
R22 in the retrofit audit, so it cannot quietly vanish from the record.

---

## 9. What operating the product found that testing did not

This is the most transferable lesson in the build, so it gets its own section.

| Defect | Would a passing test have caught it? |
|---|---|
| Plaintext database connection accepted | No — tests connected the same wrong way |
| Scheduler had never actually run | No — the workflow exited 0 |
| Every screen a navigational dead end | No — no test asserts "can a human get back" |
| One expired token aborted the whole sweep | No — no test had two merchants with one broken |
| Webhook pointed at a dead tunnel | No — configuration lives outside the repo |
| App secret present but empty | No — the name existed |
| KVKK URL never delivered to customers | No — it was stored and read correctly |
| Enum fields silently degraded to free text | No — the free-text path is legitimate |

Eight defects; none catchable by the suite. Four of them required *hosted*
infrastructure, not merely a running app. Three were configuration rather than
code, which is precisely the class of problem a repository cannot test.

The counterweight: the suite caught a great deal during development that
operating never would have, and the two are not substitutes. What the build
demonstrates is that a gate written as *"do the thing and show me"* finds a
different and largely disjoint set of problems from a gate written as
*"the tests pass"*.

---

## 10. Testing strategy

Two tiers, deliberately separated:

```bash
npm run test      # 168 tests, DB-free, ~6s
npm run test:db   # 136 tests, real Postgres, ~33s local
```

Unit tests cover `src/lib` — pure functions, no database, no framework.
Integration tests are `*.integration.test.ts` under `src/db`, run through
`vitest.integration.config.ts`, serialized, each wrapped in `begin` /
`rollback`.

**The isolation lesson, restated because it cost the most time:** `begin` /
`rollback` isolates tests from *each other*, not from *committed state*. Against
a fresh local database that distinction never surfaces. Against a hosted
database that has ever been used, it does — and it surfaces as a test failure
that looks like an application bug. `forgetFakeConversations()` closes it.

A related trap: piping vitest into `tail` means the pipeline's exit status is
`tail`'s, not vitest's. A run that ended `exit: 0` had four genuine failures in
it. Read the output, not the status.

---

## 11. Deployment & operations

Production runs on Vercel against Supabase Postgres in Frankfurt, with the
console behind a shared passcode.

- **Deploys are manual.** Vercel's GitHub app is not installed on the private
  repo, so pushing does *not* deploy. `npx vercel deploy --prod --yes` does. A
  first "Not authorized" can be transient — retry.
- **Health** is at `/api/health`, ungated so an uptime monitor can reach it, and
  deliberately uninformative: it reports whether the database answers and *how
  many* configuration warnings exist, never which ones. Missing *required*
  configuration is not reported there at all, because the app refuses to boot in
  that case — a louder signal.
- **The inactivity sweep** runs from GitHub Actions on a schedule, calling the
  maintenance endpoint with a shared secret. GitHub delays scheduled runs
  considerably — observed every 20–30 minutes against a requested 5.
- **A sweep reporting `failed: N`** means an expired Meta token: the nudge send
  throws. Note the session is marked nudged *before* the send, so a failed send
  loses that nudge permanently.
- **All secrets live only in gitignored `.env.local` and on Vercel.** Nine
  variables. The lesson from Step 8: check values, not names.

Two environment gotchas that recur:

- **Do not `source .env.local` from bash.** Values contain `&`, so sourcing
  aborts partway and later variables come back empty with no error. Use
  `node --env-file=.env.local`.
- **Local dev must be opened at `localhost:3000`, not `127.0.0.1:3000`** — Next
  16 blocks cross-origin dev resources from the latter, so pages render but
  never hydrate.

---

## 12. Decisions and divergences worth knowing

**Photos are never downloaded.** The spec calls for photos in private buckets.
The implementation stores Meta's media identifier and nothing else, so no
customer photograph has ever been written to the database. For data protection
that is the better design — but it happened by omission rather than decision,
and those identifiers expire at Meta, so an agent opening a month-old damage
claim will find the evidence gone. The spec and the code currently disagree;
they should be reconciled deliberately.

**Enum labels are derived, not stored.** `optionForValue` turns `wrong_size`
into "Wrong size". Adding values to an enum field is therefore a pure data
change — no code, no migration, no deploy.

**Per-merchant WhatsApp access tokens are deferred.** The number to send *from*
is already per-merchant; the token is still one environment variable. This only
becomes necessary when merchants bring their own WABAs.

**Console authentication is a shared passcode.** It keeps case data off the open
internet but does **not** separate operators — every console action is
attributed to `agent`, every automatic one to `system`. Real user accounts are a
later concern.

---

## 13. KVKK status at close

Of the spec's seven privacy requirements, five are met: signature verification,
boundary validation, phone masking in logs, generic customer-facing errors, and
disclosure at conversation start.

**Two are not, and they are the two a customer can invoke against you.**

1. **Retention is configured but never enforced.** `retention_months` is stored,
   validated, editable and defaults to 12. Nothing reads it. No record has ever
   been deleted by age.
2. **There is no per-phone deletion operation** anywhere in the product. An
   erasure request today would be served by hand-written SQL against production.

**The structural finding, which any deletion work must start from:**
`conversation_messages.case_id` is `on delete set null`, and `intake_sessions`
and `processed_messages` are keyed by phone independently of cases. **Deleting a
case therefore leaves the transcript, the in-flight session and the message
identifiers behind — still carrying the phone number and every word the customer
typed.** The obvious implementation of erasure would miss the most sensitive
table and look like it had worked. Erasure must be phone-scoped across five
tables in one transaction, never case-scoped.

Recommended order of work: build that phone-scoped primitive first, then the
console action that calls it, then extend the existing maintenance sweep to call
it by age. One primitive, two callers.

Two further points recorded for whoever picks this up: the disclosure is
*optional* (a merchant who leaves the URL blank silently discloses nothing) and
is *worded as consent*, which is likely the wrong lawful basis for a returns
intake; and the move to Frankfurt turned cross-border transfer into a live legal
question that needs counsel, not engineering.

The merchant is the data controller; ChicChat is the processor. Until items 1
and 2 exist, a merchant using ChicChat cannot comply even if they want to,
because the product gives them no mechanism.

---

## 14. Open items at close of v0.2

| Item | Status |
|---|---|
| **R13** — KVKK retention enforcement + per-phone deletion | Open, not blocked by anything external. The highest-value remaining work |
| **R22** — İkas connector (Step 9), Flow item picker (Step 10) | Deferred; need a dev store and Meta access |
| **R7** — a test fixture lives in `src/lib` | Open, cosmetic, contradicts the architecture rule |
| **R2** — `node:crypto` imported inside `lib` | Open by decision, not a defect |
| `exchange.desired_variant` has no enum values | Intentional until the connector lands |
| Meta app returns `API access blocked` | External; needs the App Dashboard |
| Photos: spec says buckets, code stores pointers | Needs a deliberate decision either way |

Two test cases created while verifying the deployment (fake phones ending 0098
and 0099) remain in the production console and can be removed at any time.

---

## 15. Appendix — commands

```bash
npm run dev            # local app (open at localhost:3000)
npm run test           # 168 unit tests, no database
npm run test:db        # 136 integration tests, real Postgres
npm run typecheck      # tsc --noEmit
npm run lint
npm run db:start       # local Supabase (Docker Desktop must be running)
npm run db:seed        # loads .env.local, so it links the real phone_number_id
npx vercel deploy --prod --yes
```

Local Supabase notes: verify `docker info` first — Docker Desktop is usually
just not started. If the analytics container is unhealthy and the CLI rolls the
whole stack back, `--ignore-health-check` gets the database up; never exclude
`kong`. After moving route files, stale `.next/types` break `tsc` — `rm -rf
.next` first. `next build` can fail fetching Google Fonts; that is transient.

---

*End of log. v0.2 closed 2026-08-28 at commit `fd2d23e`.*
