# ChicChat — Engineering Handbook

Lasting engineering standards, independent of any version's build plan.
Claude Code: read this once per session and apply it to everything.

---

## 1. Stack (the app shell — the domain core stays framework-agnostic)

The product's valuable center (`src/lib`: state machine, rules, normalization)
is framework-agnostic by rule §2 — it imports no framework and would port to
any server or even another language with contained effort. The stack below is
the shell that gives it HTTP, UI, and storage; the shell is replaceable
precisely because the core doesn't depend on it.

Next.js (App Router) + TypeScript (`strict: true`) · Tailwind · Supabase
(Postgres, SQL migrations in `supabase/migrations`) · Vitest (+ Playwright when
UI e2e is warranted) · ESLint + Prettier · conventional commits.

Required npm scripts, always working: `dev` · `test` · `test:watch` · `lint` ·
`typecheck` (`tsc --noEmit`) · `db:migrate` · `db:seed` (idempotent).

## 2. Architecture

```
app (UI, API routes)  →  server (orchestration)  →  lib (pure domain)
                                                 →  db (persistence)
```

- `src/lib` is pure: no React, no Next.js, no Supabase/pg, no fetch, no env
  access. Pure functions, immutable state, discriminated unions for variants.
- `db` may import types from `lib`; never the reverse. Any change making `lib`
  import `db` or a framework is wrong by definition.
- API routes orchestrate only. Business rules live in `lib`. UI is presentation.
- Dependencies are injected (the `Deps` pattern in handlers) so tests can pass
  fakes. New orchestration code follows the same pattern.
- State between messages lives in the database (sessions), never in process
  memory. The server must survive restart mid-conversation.

## 3. Code standards

- Functions ≲ 60 lines; components ≲ 200 lines (guideline; justify exceptions
  in the step report).
- No `any`. No duplicated logic. No commented-out code in commits. No empty
  `catch`. Every async path handles or propagates errors deliberately.
- Typed errors / discriminated result types in `lib` — never thrown strings.
- Naming: files kebab-case; types PascalCase; DB snake_case.

## 4. Testing

- Every exported function in `src/lib` has unit tests, colocated (`*.test.ts`).
- Orchestration gets integration tests with fake deps; DB layer gets tests
  against local Supabase where the step's gate calls for it.
- Tests are behaviour scripts: messy input in, correct outcome out. Prefer one
  scenario per test with a descriptive name.
- Given/When/Then only for genuinely tricky behaviour, not ceremony.

## 5. Security & privacy

- Validate and parse ALL external input at the boundary (webhooks, Flow
  payloads, UI forms, connector responses). Trust nothing.
- Verify webhook signatures (X-Hub-Signature-256). Process idempotently by
  message ID.
- Secrets only via env vars; `.env.example` maintained; nothing secret in
  commits or logs. Mask phone numbers to last 4 digits in logs.
- User-facing errors are generic; diagnostics go to structured logs.
- KVKK rules (SPEC §12) are product requirements, not optional polish.

## 6. Reliability

- Multi-record writes are transactional.
- Webhook/handler processing is idempotent end-to-end.
- Top-level catch at the handler boundary: no unhandled rejection may kill a
  conversation silently — errored sessions are marked and logged.

## 7. Performance

- Measure before optimizing. No accidental O(n²) in the per-message path;
  Map/Set over repeated array scans.
- The only hard latency budget: WhatsApp Flows data-exchange endpoint (Meta
  health checks). Cache the order at ORDER_NUMBER; keep the endpoint thin.

## 8. Observability

- Structured JSON logs, one line per event: webhook in, routing decision,
  validation failure, integration call/failure, case persisted, unexpected
  exception (with stack).
- Every line carries merchant_id + correlation id (message id). No PII beyond
  masked phone.

## 9. Review checklist (applied in every step report)

Correct · Tested · Typed · Secure · Idempotent-where-relevant · Performant
enough · Maintainable · Architecture-consistent (`lib` stays pure)
