# Additions to `CLAUDE.md`

Append to the end of the existing file. Where anything here conflicts with the
original CLAUDE.md, this file wins; where it conflicts with `docs/SPEC.md` on
product behaviour, the spec wins.

---

## Engineering standards

- Functions ≲ 60 lines; React components ≲ 200 lines (guideline, not dogma —
  justify exceptions in the step report).
- No `any`; prefer explicit types. No duplicated logic. No commented-out code
  in commits. No empty `catch` blocks; every async path handles or propagates
  errors deliberately.
- Prefer typed errors in `src/lib` (e.g. a small `IntakeError` hierarchy or
  discriminated result types) over throwing strings.

## Architecture rules (corrected dependency direction)

```
app (UI/routes)  →  server (orchestration)  →  lib (pure domain)
                                            →  db (persistence)
```

- `lib` imports **nothing** framework- or infrastructure-related: no React, no
  Next.js, no Supabase/pg, no fetch. Pure TypeScript in, pure TypeScript out.
- `db` may import types from `lib`, never the reverse.
- API routes orchestrate only; business rules live in `lib`; UI is presentation.
- This is the existing shape of the repo — preserve it. Any PR/step that makes
  `lib` import `db` is wrong by definition.

## Testing standards (Definition of Done, updated)

Per step: `npm run lint` ✓ · `npm run typecheck` ✓ (add this script: `tsc
--noEmit`) · `npm run test` ✓ · integration tests where the step's gate calls
for them · no new compiler warnings. Every exported function in `src/lib` has
unit tests.

Acceptance criteria in Given/When/Then form are **optional** — use them only
for genuinely tricky behaviour (e.g. session expiry edge cases), not as
ceremony for every feature.

## Performance

Measure before optimizing. Avoid accidental O(n²) in hot paths (per-message
processing); prefer Map/Set lookups over repeated array scans. The only hard
latency budget is the Flows data-exchange endpoint (see SPEC §10).

## Security & error handling

- Validate all external input at the boundary (webhook payloads, Flow payloads,
  merchant UI forms); parse, don't trust.
- Verify webhook signatures; process idempotently by message ID (SPEC §11).
- Never log secrets or unmasked phone numbers. Structured JSON logs per SPEC §15.
- User-facing failures are friendly and generic; diagnostics go to logs.

## Code review checklist (per step report)

Correct · Tested · Typed · Secure · Idempotent-where-relevant · Maintainable ·
Architecture-consistent (lib stays pure)

---

## Build plan changes

### Amend Step 8 gate (WhatsApp wiring)
Add to the gate: replaying the same webhook payload twice produces exactly one
session/message effect (idempotency proven by test), and the first message of a
new conversation includes the KVKK disclosure line (SPEC §12).

### NEW Step 8.5 — Hardening & deployment
- **Build:** implement SPEC §§10–15 across the existing code: idempotency store,
  transactional `persistCase`, session TTL + cleanup job (24h, abandoned-case
  persistence), structured logging, input validation at boundaries, `typecheck`
  script. Then deploy: Next.js app to a host (Vercel or equivalent), migrate
  from local Supabase to a hosted Supabase project, secrets via host env vars
  (never committed), point the Meta webhook at the permanent URL.
- **Gate:** all tests green in CI or locally against the hosted DB; a real
  WhatsApp message to the test number round-trips through the **deployed**
  app and persists a case in the hosted DB; duplicate-delivery test passes;
  a session artificially aged >24h is expired correctly by the cleanup job.

### NEW Step 9.5 — Multi-tenancy seam
- **Build:** replace the hard-coded demo merchant in the webhook path with real
  merchant resolution by `phone_number_id` (the seam already marked in
  `route.ts`). Merchant-scoped config loading everywhere; add an index on the
  lookup.
- **Gate:** two seeded merchants with different taxonomies; messages to each
  phone_number_id produce correctly-scoped sessions and cases with no
  cross-tenant leakage (asserted by test).

### Step 9 (İkas connector) — build against reality
- Use a **free İkas development store** (create via Partner panel) seeded with
  test orders.
- Target the **Private App** auth model first: OAuth2 client_credentials against
  `https://<store>.myikas.com/api/admin/oauth/token`; tokens expire in 14,400s
  (4h) — implement refresh/re-fetch with the token cached per merchant.
- GraphQL endpoint: `https://api.myikas.com/api/v1/admin/graphql`.
- Scopes (minimum): Read Orders, Read Products, Read Inventories, Read
  Customers. No write scopes in Phase B.
- **Gate (amended):** merchant UI accepts client_id/secret, token fetch +
  refresh proven by test (simulate expiry), `getOrder(order_number)` returns
  line items from the dev store, merchant `integration_tier` flips to 1, and
  an İkas-unavailable simulation degrades the conversation to Tier-0 per SPEC
  §13.
- Admin App / App Store packaging is explicitly **out of scope** until pilot
  merchants exist.
