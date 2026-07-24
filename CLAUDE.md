# CLAUDE.md — Working Agreement & v0.2 Build Plan

`docs/SPEC.md` = WHAT to build (source of truth for product behaviour).
`docs/ENGINEERING-HANDBOOK.md` = lasting engineering standards.
This file = HOW we work + the CURRENT build plan. Conflicts: SPEC wins on
product behaviour; the Handbook wins on engineering standards.

---

## How we work (unchanged, and non-negotiable)

1. Implement exactly ONE numbered step, then STOP.
2. Every step has a verification gate; run it and show the output.
3. Post the step report (template below) and WAIT for my sign-off ("approved" /
   "next") before starting the next step. Fixes happen within the current step.
4. Commit after each approved step (conventional commits).
5. No skipping ahead, no early scaffolding of future steps.
6. Ambiguity → ask me one focused question, don't guess.
6b. The simulator is the standing test bench: from Step 1 onward, every step
   with user-visible behaviour must be demonstrable in the simulator, and each
   step extends the simulator with whatever controls its features need
   (SPEC §7). "Works but can't be shown in the simulator" fails the gate.
7. Definition of Done per step: gate ✓ · lint ✓ · typecheck ✓ · tests ✓ ·
   Handbook standards respected · committed · report posted · sign-off received.

### Step report template
```
## Step N — <title>  ✅ gate passed
- What I built: <1–3 lines>
- Files added/changed: <list>
- Verification: <command> → <result>
- Notes / decisions / assumptions: <flag anything I chose>
Awaiting sign-off for Step N+1.
```

---

## v0.2 build plan

### Step 0 — Docs restructure & retrofit audit
- **Build:** move new SPEC.md and ENGINEERING-HANDBOOK.md into `docs/`; replace
  old CLAUDE.md with this file; delete superseded addition files. Add
  `npm run typecheck` (`tsc --noEmit`). Audit existing code against the
  Handbook; produce `docs/RETROFIT.md` listing every violation (no fixes yet).
- **Gate:** three docs in place; typecheck script runs; RETROFIT.md lists
  findings with file references.

### Step 1 — Chat simulator (SPEC §7)
- **Build:** `/simulator` route (dev-only or auth-gated): WhatsApp-like chat UI;
  merchant + fake-phone selector; injects synthetic messages into the real
  handler (signature bypass only); supports text, list taps, fake photo, fake
  Flow payloads; side panel with live session state and final case JSON; reset;
  preset scenarios; error injection and session time-travel hooks (SPEC §7) —
  this is the permanent test bench all later gates run on.
- **Gate:** intakes for at least three different categories completed entirely
  in the simulator, including the messy-order-number preset; case JSON visible
  and correct each time; no Meta credentials configured anywhere.

### Step 2 — Hardening & unexpected-error handling (SPEC §§10–13)
- **Build:** idempotency by message ID; transactional persistCase; session
  inactivity handling per SPEC §11 — nudge at `nudge_after_minutes` (default 5),
  abandon at `abandon_after_hours` (default 24), both merchant-configurable,
  progress never discarded early; cleanup job; boundary validation; structured
  JSON logging; top-level handler catch → generic customer message, `errored`
  session state, correlated log (SPEC §13 last row).
- **Gate:** tests prove: duplicate replay = single effect; kill-mid-persist
  leaves no partial case; simulator time-travel shows the nudge at 5 min, a
  post-nudge reply resuming with all fields intact, and abandonment at the
  configured horizon; a thrown error inside the machine produces the generic
  reply + errored session + one structured log line.

### Step 3 — Merchant taxonomy editor, full CRUD (SPEC §8)
- **Build:** upgrade config UI from toggles to full CRUD: categories,
  subcategories, fields (incl. required + enum values), routing rules; policy
  settings incl. KVKK URL + retention. Defaults pre-loaded per merchant.
- **Gate:** in the simulator, create a brand-new custom category with a custom
  enum field via the UI and complete an intake using it end-to-end; disable a
  default category and verify it disappears from the menu.

### Step 4 — Case persistence upgrade & merchant case views (SPEC §8)
- **Build:** case list (filters: status/category/date/order number), case detail
  (raw+normalized fields, items, photos, timeline, abandoned + errored states),
  basic analytics counters (by category/status/day, median intake time,
  abandonment rate).
- **Gate:** cases generated via simulator appear correctly in list, filters,
  detail, and counters; an abandoned and an errored session both surface.

### Step 5 — Agent case console (SPEC §9, minimal)
- **Build:** queue view (priority/age, queue/category filters); case detail with
  handoff package + read-only transcript; status transitions; internal notes.
- **Gate:** simulator-generated case flows open → in_progress → resolved with a
  note; routing rules land cases in the right queues.

### Step 6 — Multi-tenancy seam
- **Build:** merchant resolution by phone_number_id (replace demo hardcode);
  merchant-scoped everything; simulator gains merchant switching.
- **Gate:** two merchants with different taxonomies; interleaved simulator
  conversations produce correctly scoped sessions/cases; cross-tenant leakage
  test passes.

### Step 7 — Deployment
- **Build:** deploy to Vercel (or equivalent) + hosted Supabase; env-var
  secrets; migrations against hosted DB; simulator auth-gated in prod.
- **Gate:** deployed simulator completes a full intake against the hosted DB;
  tests green against hosted config.

### Step 8 — Meta re-wiring (staging)
- **Build:** point Meta test-number webhook at the deployed URL; KVKK line on
  first message; verify signature path in production mode.
- **Gate:** real WhatsApp message to the test number round-trips through the
  deployed app; duplicate-delivery replay test passes in deployed environment.

### Step 9 — İkas connector (SPEC §14)
- **Build:** private-app credential entry in merchant console; client_credentials
  token fetch + 4h refresh (cached per merchant); getOrder via GraphQL against a
  free İkas dev store; tier flip to 1; Tier-0 degradation on unavailability.
- **Gate:** token expiry simulation passes; dev-store order returns line items;
  integration-down simulation degrades per SPEC §13.

### Step 10 — Item-picker Flow (SPEC §6)
- **Build:** data-exchange endpoint (RSA-2048), order caching at ORDER_NUMBER,
  SELECT_ITEMS from live İkas dev-store order, selections → case_items. Simulator
  fake-Flow payloads already cover the logic; this step is the real Meta wiring.
- **Gate:** in WhatsApp (test number), a customer picks real items from a real
  dev-store order; case records correct line-item ids.

**→ v0.2 complete. v0.3 (LLM classify/extract) begins only after sign-off and a
demo session with at least one real merchant.**
