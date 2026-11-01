# ChicChat — Engineering Handbook

Lasting engineering standards, independent of any version's build plan.
Claude Code: read this once per session and apply it to everything.

---

## 1. Stack (the app shell — the domain core stays framework-agnostic)

The product's valuable center (`python/chicchat/domain`: state machine, rules,
normalization) is framework-agnostic by rule §2 — it imports no framework,
database driver, HTTP client or environment access. The stack below is the
shell that gives it HTTP, UI, and storage; the shell is replaceable precisely
because the core doesn't depend on it (the TypeScript → Python port of
November 2026 relied on exactly this, see `docs/PORT.md`).

Python 3.13 · FastAPI + Jinja2 templates (autoescaping on) · Tailwind CSS
(prebuilt, standalone CLI) · PostgreSQL via psycopg 3 with hand-written SQL
(migrations in `supabase/migrations`) · pytest (+ Playwright for the browser
walkthrough) · ruff (lint + format) · mypy `--strict` · import-linter ·
uv for environments · conventional commits.

Required commands, always working (run in `python/`): `uv run pytest` ·
`uv run pytest -m db` · `uv run pytest -m browser` · `uv run ruff check .` ·
`uv run ruff format --check .` · `uv run mypy` · `uv run lint-imports` ·
`uv run python -m chicchat.scripts.migrate` (local) ·
`uv run python -m chicchat.scripts.seed` (idempotent).

## 2. Architecture

```
web (routes, templates)  →  server (orchestration)  →  db (persistence)  →  domain (pure)
```

- `chicchat/domain` is pure: no FastAPI, no psycopg, no httpx, no `os`
  environment access. Pure functions, values that are never mutated, and
  `Literal`-tagged variants. import-linter enforces this in CI.
- The layers only import downwards (web → server → db → domain); import-linter
  enforces this too. Any change making `domain` import `db` or a framework is
  wrong by definition.
- Routes orchestrate only. Business rules live in `domain`. Templates are
  presentation; the two small scripts (`static/config.js`, `static/simulator.js`)
  hold no business logic.
- Dependencies are injected (the `Deps` dataclasses in the server layer) so
  tests can pass fakes. New orchestration code follows the same pattern.
- State between messages lives in the database (sessions), never in process
  memory. The server must survive restart mid-conversation; several worker
  processes and threads may serve requests at once.
- JSON stored in the database or sent over the wire keeps its established
  keys (camelCase where the TypeScript wrote camelCase) and is modelled as
  `TypedDict`s; internal values are frozen dataclasses.

## 3. Code standards

- Functions ≲ 60 lines; templates ≲ 200 lines per block (guideline; justify
  exceptions in the step report).
- mypy `--strict` clean. `Any` only at untrusted JSON boundaries, and narrowed
  immediately. No duplicated logic. No commented-out code in commits. No bare
  `except: pass`; every failure path handles or propagates deliberately, and
  background work always logs its exceptions.
- Expected failures in `domain` return `Ok`/`Err` results (`domain/result.py`)
  — never raised for control flow.
- Where behaviour depended on JavaScript semantics (whitespace, rounding,
  regex syntax, `===`, JSON parsing), use `domain/jscompat.py` rather than the
  Python built-in, so stored data and merchant patterns keep their meaning.
- Naming: modules and functions `snake_case`, classes `PascalCase`, database
  `snake_case`.

## 4. Testing

- Every public function in `chicchat/domain` has unit tests in
  `python/tests/domain`, mirroring the package layout.
- Orchestration gets tests with fake deps; the db layer gets tests against a
  local `_test` PostgreSQL (`pytest -m db`); every operator page is exercised in
  a real browser (`pytest -m browser`).
- Tests are behaviour scripts: messy input in, correct outcome out. One
  scenario per test with a descriptive name.
- Golden files (`python/tests/golden`) pin domain behaviour recorded from the
  TypeScript implementation; a change to them is a behaviour change and needs
  saying so in the step report.
- Given/When/Then only for genuinely tricky behaviour, not ceremony.

## 5. Security & privacy

- Validate and parse ALL external input at the boundary (webhooks, Flow
  payloads, UI forms, connector responses). Trust nothing.
- Every state-changing route carries CSRF protection (form token + Origin
  check); a test fails if a new POST route forgets it.
- Production is the default: only an explicit `CHICCHAT_ENV=development`
  enables local conveniences (login bypass, unsigned webhooks).
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
enough · Maintainable · Architecture-consistent (`domain` stays pure)
