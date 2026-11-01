# PORT — moving ChicChat from TypeScript to Python

Written 2026-11-01, before any port work starts. This is the plan of record for
the port: what moves, in what order, how each step is proven, and what can go
wrong. Read it at the start of every port step. If reality disagrees with this
file, stop and update the file first — do not improvise around it.

**Why:** the owner reads Python and Java, not TypeScript, and has to be able to
understand and own the code as the product grows.

**The one rule above all others:** the port changes the *language*, not the
*product*. Every behaviour, message text, database row and HTTP response stays
the same. No new features, no "while we're here" fixes, no v0.3 work until the
port is finished and signed off. Bugs found in the TypeScript code are written
down (§9) and fixed in a separate, explicit change — never silently during the
port.

---

## 1. Decisions

Confirmed by the owner on 2026-11-01: D1 Python, D2 FastAPI (after comparing it
with Django), and the D9 hosting direction. The owner authorized running Port
Steps 0–6 without per-step sign-off; Port Step 7 needs sign-off.

| # | Decision | Proposal | Why |
|---|---|---|---|
| D1 | Language | **Python 3.13** ✓ confirmed | Owner reads it; strongest ecosystem for the v0.3 AI work. Java was considered: far more code for the same behaviour and slower iteration on a product still changing. |
| D2 | Web framework | **FastAPI** ✓ confirmed | Small, explicit, maps 1:1 onto today's routes. Django was considered: its ORM and migration system would fight our hand-written SQL and SQL migrations. |
| D3 | Web pages | **Server-rendered Jinja2 templates + HTMX**, plus one small, commented JavaScript file for the simulator chat | Owner can read the templates. The simulator's live chat and preset playback genuinely need a little browser code; everything else can be plain HTML forms. |
| D4 | Styling | Keep the existing **Tailwind** classes; build CSS with the Tailwind **standalone CLI** (one binary, no Node.js) | Pages keep their current look without a Node toolchain. |
| D5 | Database access | **psycopg 3** + **psycopg_pool**, **raw SQL copied verbatim** from the TypeScript files, synchronous code | Same queries, same behaviour; synchronous Python is easier to read than async. No ORM. |
| D6 | Database schema | **Unchanged.** Same PostgreSQL, same 12 files in `supabase/migrations`, same Supabase CLI for local DB | The data is language-independent; hosted data needs no migration. |
| D7 | Boundary validation | Port today's hand-written parsers as-is (functions returning ok/error results) rather than switching to Pydantic models | Exact parity of accepted input and error messages is far easier to prove. Pydantic can come later as a separate change. |
| D8 | Tooling | **uv** (environments + lockfile), **pytest**, **ruff** (lint + format), **mypy --strict** (type check), **import-linter** (architecture rule) | Direct equivalents of today's npm / Vitest / ESLint + Prettier / `tsc --noEmit`. |
| D9 | Hosting | Direction ✓ confirmed; provider chosen in Port Step 7. Leading option: a **long-running container host in an EU region near the Supabase database** (e.g. Render, Railway, Fly.io). Re-check Vercel's current Python support at that step before ruling it out. | Today's webhook acknowledges Meta and *then* processes the message (`after()` on Vercel). That post-response work must reliably run, or customers wait for the 5-minute maintenance job. A long-running server makes this simple. |
| D10 | Repository layout | Python lives beside TypeScript in the same repo (`python/`) until cutover; TypeScript is deleted only in the final step | Both can be run and compared at every step. |

---

## 2. What exists today (the inventory)

Measured at commit `09ec1ee` (main, 2026-11-01).

| Area | Path | Size | What it is |
|---|---|---|---|
| Pure domain | `src/lib` | ~2,800 lines, 25 files | Intake state machine, normalization, routing rules, case workflow/filters/analytics, config form parsers, WhatsApp message building/parsing/signature check, simulator protocol, log masking, auth gate decision |
| Database layer | `src/db` | ~2,200 lines, 18 files | Every SQL query: config, taxonomy CRUD, sessions, cases, console, transcript, inbox/outbox, privacy/retention, media, auth, merchants, conversation lock |
| Server orchestration | `src/server` | ~1,400 lines, 14 files | Message handler, inbox worker, outbox delivery, maintenance job, simulator service, Meta HTTP client + photo download, logger, env check, password hashing, current user/merchant |
| HTTP + pages | `src/app`, `middleware.ts`, `src/instrumentation.ts` | ~3,950 lines, 39 files | 5 API routes, login, cases list/detail, console queue/detail, configuration editor, simulator UI, auth middleware, boot check |
| Scripts | `scripts/` | 840 lines | `seed.mjs` (751 lines, idempotent demo data), `console-user.mjs` (account provisioning), `prepare-test-db.mjs` (applies migrations to a local `_test` DB) |
| Tests | `*.test.ts` | ~5,700 lines | **195 unit tests in 31 files** (175 domain, 20 server/route; no DB); **82 DB integration test blocks in 12 files** (153 executions at the last full run) |
| CI | `.github/workflows/` | 2 files | `verify.yml` (typecheck, lint, unit, DB tests on PostgreSQL 17, build); `maintenance.yml` (calls the maintenance endpoint every 5 minutes) |
| Schema | `supabase/migrations` | 12 SQL files | Unchanged by the port |

### HTTP surface that must behave identically

| Route | Methods | Auth | Notes |
|---|---|---|---|
| `/api/whatsapp/webhook` | GET, POST | Meta signature (POST), verify token (GET) | POST: verify signature over **raw body** → parse → resolve merchant by `phone_number_id` → commit to `message_inbox` → **200** → process after response. Storage failure → **503**. Malformed JSON → log, **200**. Bad signature → **401**. GET handshake → echo challenge or **403**. |
| `/api/maintenance/sessions` | GET, POST | `Authorization: Bearer <MAINTENANCE_SECRET or CRON_SECRET>`, constant-time compare | Runs retention → inbox → inactivity → reply retries; returns the JSON summary (`failed` must be a number; CI checks `.failed == 0`). |
| `/api/health` | GET | none | `{ok, database, warnings: <count>}`; 503 when DB is unreachable. Never reveals configuration detail. |
| `/api/simulator` | POST | console account with membership (or local dev bypass) | 404 when the simulator is disabled; 400 on invalid body; 403 on wrong merchant; sets the merchant cookie. |
| `/api/cases/{id}/media/{mediaId}` | GET | console account, merchant-scoped | Serves photo bytes with `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`. |
| `/login` (+ sign-in / sign-out) | GET, POST | open | Cookie `chicchat_console`: httpOnly, SameSite=Lax, Secure in production, 12 hours. |
| `/cases`, `/cases/{id}`, `/console`, `/console/{id}`, `/config`, `/simulator`, `/` | GET (+ form posts) | console account | Merchant chosen via the `chicchat_merchant` cookie, always re-checked against membership. |

Open (ungated) paths, exactly: `/api/whatsapp/webhook`, `/api/maintenance/sessions`,
`/api/health`, `/login`, static assets, favicon.

### Environment variables (names unchanged)

`DATABASE_URL` · `WHATSAPP_GRAPH_VERSION` · `WHATSAPP_PHONE_NUMBER_ID` ·
`WHATSAPP_BUSINESS_ACCOUNT_ID` · `WHATSAPP_ACCESS_TOKEN` · `WHATSAPP_VERIFY_TOKEN` ·
`WHATSAPP_APP_SECRET` · `SIMULATOR_ENABLED` · `CONSOLE_AUTH_REQUIRED` ·
`MAINTENANCE_SECRET` · `CRON_SECRET` · `CHICCHAT_USER_PASSWORD` (provisioning only).
One new variable replaces `NODE_ENV` — see pitfall P1.

---

## 3. Target layout

```
python/
  pyproject.toml          # dependencies, ruff, mypy, pytest, import-linter config
  uv.lock
  chicchat/
    domain/               # ← src/lib      pure: no fastapi, psycopg, httpx, os.environ
      intake/  normalize/  rules/  cases/  config/  whatsapp/  simulator/  logging/  auth/  nav.py
    db/                   # ← src/db       SQL, copied verbatim
    server/               # ← src/server   orchestration, injected dependencies
    web/                  # ← src/app + middleware + instrumentation
      routes/  templates/  static/
    scripts/              # ← scripts/*.mjs   seed, console_user, prepare_test_db
  tests/
    domain/  db/  server/  web/
    golden/               # JSON produced by the TypeScript code (§5)
```

Naming: modules and functions `snake_case`, classes `PascalCase`, database
`snake_case` (unchanged). **JSON stored in the database keeps its current
camelCase keys** (pitfall P3).

How TypeScript ideas map to Python, so the code reads consistently:

| TypeScript | Python |
|---|---|
| `interface` / object type | `@dataclass(frozen=True)` for domain values; `TypedDict` for JSON shapes |
| discriminated union (`kind: "a" \| "b"`) | separate dataclasses + `Literal` tag, handled with `match` |
| result type `{ok: true, value} \| {ok: false, error}` | `Ok` / `Err` dataclasses — never raise for expected failures in `domain` |
| `Deps` objects (injected `db`, `send`, `logger`) | same: a dataclass of callables passed in |
| `Queryable` / `Database` with `transaction()` | `Protocol` classes; `transaction()` is a context manager |
| `undefined` / optional field | `None`, **but omitted from JSON** where TypeScript omitted it (P3) |

---

## 4. The steps

Same working agreement as `CLAUDE.md`: one step, run its gate, report, wait
for sign-off, commit. Each step ports **tests together with code**.

### Port Step 0 — Decisions and skeleton
- **Build:** owner confirms D1–D3, D9 direction. Create `python/` with
  `pyproject.toml`, uv lockfile, ruff, mypy strict, pytest, import-linter (rule:
  `chicchat.domain` imports nothing from `db`, `server`, `web`, or any of
  fastapi / psycopg / httpx / os.environ). Add a `python` job to `verify.yml`
  next to the existing TypeScript job. Write the golden-file exporter (§5).
- **Gate:** CI runs both jobs green; an empty pytest suite passes; import-linter
  fails on a deliberately bad import (then the bad import is removed).

### Port Step 1 — Pure domain (`src/lib` → `chicchat/domain`)
- **Order:** normalize → rules → intake (types, machine, inactivity) → cases
  (routing, workflow, filters, analytics, date) → config (forms, keys) →
  whatsapp (types, verify, inbound, messages) → simulator (protocol, envelope)
  → logging mask → auth gate → nav.
- **Build:** each module plus its unit tests; golden-file comparison per module.
- **Gate:** all 175 domain unit tests (24 files) are ported and pass; golden
  outputs match the TypeScript outputs exactly; mypy strict and ruff clean.

### Port Step 2 — Database layer (`src/db` → `chicchat/db`)
- **Build:** connection pool + `Database` / transaction / savepoint helpers;
  every query file; the conversation lock; the test-isolation helper; port
  `prepare-test-db.mjs`.
- **Gate:** all 12 integration test files ported; the same number of test
  executions as the TypeScript suite, all passing against a local `chicchat_test`
  database; concurrency tests use real separate connections.

### Port Step 3 — Server orchestration (`src/server` → `chicchat/server`)
- **Build:** logger, env check, password/token hashing, WhatsApp client (httpx),
  photo download, handler, inbox, outbox, maintenance, simulator service,
  current user / merchant resolution.
- **Gate:** server unit tests and the repair/concurrency integration tests pass;
  a password hash created by the TypeScript code verifies in Python and vice
  versa (P5); log lines are byte-for-byte the same shape as today's.

### Port Step 4 — HTTP API and authentication
- **Build:** FastAPI app; the five API routes; auth gate middleware; login /
  sign-out; boot-time environment check (fails startup on missing required
  config); background processing after the webhook response.
- **Gate:** route tests ported (webhook, simulator) plus new ones for every row
  of the HTTP table in §2, including status codes, headers and the open-path
  list; a webhook signed by a real Meta-style HMAC is accepted, a tampered one
  rejected.

### Port Step 5 — Web pages
- **Build:** templates for login, cases list + detail (filters, analytics,
  evidence photos), console queue + detail (status changes, notes), the
  configuration editor (categories, subcategories, fields, rules, policy,
  privacy erasure, merchant switcher), and the simulator (chat, controls,
  inspector, presets with Stop, time travel, error injection, retry delivery).
  CSRF protection on every form (P13).
- **Gate:** a browser walk-through, recorded with screenshots, of: intakes in
  three categories including the messy-order-number preset; the photo preset
  with evidence visible; a delivery-failure injection and retry; aging a
  session to nudge then abandon; creating a custom category with a choice field
  and completing an intake with it; case filters and console status changes;
  logged-out access redirected to login; another merchant's case and photo
  refused.

### Port Step 6 — Scripts, CI and docs
- **Build:** `seed` (idempotent, same fixed UUIDs), `console_user`, Python-only
  CI (Postgres service, ruff, mypy, pytest unit + DB, template smoke test);
  README, DEPLOYMENT, Handbook §1/§3/§4 and `CLAUDE.md` Definition-of-Done
  commands updated to the Python equivalents.
- **Gate:** a fresh clone can follow README from zero to a working simulator
  using only Python tooling + Docker; seeding twice produces identical rows.

### Port Step 7 — Side-by-side check, staging, cutover, removal
- **Build:** run the TypeScript and Python apps against the same local database
  and replay the full scenario list from Step 5 through both, comparing case
  JSON, transcripts and outbox payloads. Choose the host (D9). Deploy Python to
  staging; run DEPLOYMENT §5 checks. Cut over (§8). After one quiet week in
  production, delete the TypeScript code, `package.json` and Node CI; write
  the dev log entry.
- **Gate:** side-by-side comparison shows no differences (or each difference is
  explained and signed off); staging checklist passes; production webhook and
  maintenance run on Python with zero `failed` in the maintenance summaries.

**→ Port complete. Then v0.3 resumes at its Step 1, written in Python.**

---

## 5. Safety nets

1. **Golden files (the most important one).** Before porting a domain module,
   a small Node script runs the *TypeScript* functions over a list of inputs —
   every input from the existing tests plus extra edge cases (Turkish letters
   `İıŞşĞğÇçÖöÜü`, emoji, Arabic-Indic digits `٠١٢`, full-width digits,
   leading/trailing whitespace, empty strings, very long strings, invalid
   regexes) — and writes the outputs to `python/tests/golden/*.json`. The Python
   tests load those files and must produce identical output. This catches the
   language differences in §6 that hand-written tests miss. Golden files are
   generated while the TypeScript code still exists, so Step 1 must do this
   first.
2. **Port the tests, don't rewrite them.** Each TypeScript test becomes a Python
   test with the same name and the same inputs/expectations. Keep a checklist
   (test file → Python file, count before → count after). A test is never
   dropped or loosened to make it pass.
3. **Same SQL.** Queries are copied character-for-character. Any SQL change is
   a separate, explained change.
4. **Side-by-side replay** (Step 7) against one database before cutover.
5. **Hosted data is never touched by tests.** The test-DB preparation script's
   refusal of non-local or non-`_test` databases is ported unchanged.

---

## 6. Pitfalls and dangers

Ranked roughly by how much damage each would do. Every port step's report must
say which of these it touched and how it was checked.

### Critical — security or data loss

**P1. Production must be the safe default.** Today Next.js sets
`NODE_ENV=production` automatically on `next build`/`next start`. Several
decisions hang on it: the login bypass for local development, the simulator
being on, signature verification being optional, the maintenance endpoint
working without a secret, the `Secure` cookie flag. Python sets nothing
automatically. If the port read "is it production?" from an unset variable,
a forgotten setting would ship an **open console with no login and an
unsigned webhook**. Rule: introduce `CHICCHAT_ENV`; anything other than an
explicit `development` behaves as production. Test both directions.

**P2. The webhook signature is over the raw bytes.** Verify the HMAC on the
exact request body bytes (`await request.body()`), before any JSON parsing —
never on re-serialized JSON. Use `hmac.compare_digest`. Edge case: Node's
`Buffer.from(x, "hex")` silently ignores bad hex, while Python's
`bytes.fromhex` raises — a malformed header must return **401**, not crash
with 500. Missing app secret in production → reject.

**P3. JSON already stored in the database must round-trip exactly.**
Production rows were written by TypeScript and in-flight conversations will
be resumed by Python after cutover:
- `intake_sessions.state` — keys `status`, `categoryKey`, `subcategoryKey`,
  `pendingFieldKey`, `fields` (`raw`, `normalized`, `valid`), `pendingInitial`.
- `message_inbox.payload` — `phoneNumberId`, `from`, `messageId`, `kind`,
  `reply`, optional `mediaId`, `flowResponse`.
- `message_outbox.payload` — the outbound WhatsApp message.
- `routing_rules.condition`, `field_defs.enum_values`.

Keep camelCase keys in JSON even though Python variables are snake_case.
TypeScript **omits** an `undefined` key; Python would write `null` — the
reader code must accept both, and the writer must omit keys exactly where
TypeScript did. Test: load a set of real-shaped rows produced by the
TypeScript code, advance them in Python, compare.

**P4. Cross-site request forgery.** Next.js server actions check the request
origin automatically. Plain HTML forms in FastAPI do not. Without explicit
CSRF protection, a malicious page could make a logged-in operator's browser
delete a category or erase a customer. Add a CSRF token to every form plus an
Origin check on every state-changing request.

**P5. Existing passwords and sessions must keep working.** Hashes are
`scrypt:<salt>:<hash>` from Node's `scrypt` with defaults **N=16384, r=8,
p=1, 64-byte key**, and — the trap — the salt is the **32-character hex
string used as text**, not the 16 bytes it encodes. Python equivalent:
`hashlib.scrypt(password.encode("utf-8"), salt=salt_hex.encode("ascii"),
n=16384, r=8, p=1, dklen=64)`. Session cookies store a random token; the DB
stores the SHA-256 **hex of the token text**. Keep the cookie name
`chicchat_console`, the 12-hour expiry, the login throttle (10 attempts / 15
minutes, including unknown usernames, with a dummy hash to equalize timing)
and constant-time comparison. Test with a hash generated by
`scripts/console-user.mjs`.

**P6. Never acknowledge before the message is stored; never lose work after.**
The order is: verify → commit to inbox → 200 → process. If processing after
the response is lost (process restart, platform freezing the function), the
maintenance job must still recover it — so the inbox `processed_at` /
`next_attempt_at` logic is ported verbatim, and exceptions inside background
work must be **logged**, because Python silently drops errors raised in
fire-and-forget tasks.

**P7. Template escaping.** React escapes everything by default. Jinja2 only
does when autoescape is on — ensure it is for every template and never mark
merchant-entered labels, customer messages or transcript text as `|safe`.
Customer messages are untrusted input rendered inside an operator's
authenticated session.

**P8. Production may not match the code.** Dev log §16 found the hosted app
still running the pre-September version. Before cutover, check which
migrations the hosted database actually has and which application version is
live. Never assume.

### High — wrong behaviour that tests can miss

**P9. Regular expressions behave differently.**
- Python `\d`, `\w`, `\s` match **all Unicode** digits/letters/spaces; JavaScript's
  `\d` and `\w` are ASCII-only. Without care, `"٤٥٦"` (Arabic-Indic digits)
  would count as an order number or phone digits. Use `re.ASCII` wherever the
  TypeScript regex relied on ASCII meaning.
- JavaScript `regex.test(s)` **searches anywhere**; Python `re.match` only
  matches at the start. Use `re.search` to reproduce `.test()`.
- Python `$` also matches before a trailing newline; use `\Z` or `fullmatch`
  where the TypeScript code anchored with `$`.
- **Merchant-entered patterns** (`order_id_regex`, e.g. `^[A-Z0-9]{4,}$`) are
  stored in JavaScript syntax. Most are identical in Python, but not all
  (named groups `(?<name>…)` vs `(?P<name>…)`, some escapes, flags). Invalid
  or incompatible patterns must fail validation in the editor, never crash
  intake. Check every pattern in the hosted database before cutover.

**P10. Empty values are truthy/falsy differently.** In JavaScript an empty
list `[]` and empty object `{}` are **true**; in Python they are **false**.
And `x ?? default` keeps `0` and `""`, while Python's `x or default` replaces
them. A merchant who sets a value to `0` would silently get the default. Port
`??` as `default if x is None else x`, never as `or`.

**P11. Rounding.** `Math.round(2.5)` is 3; Python `round(2.5)` is **2**
(bankers' rounding). Affects median intake time and abandonment percentage in
analytics. Use `math.floor(x + 0.5)` to match.

**P12. Database values come back as different types.** node-pg returns
`bigint` and `count(*)` as **strings**, `numeric` as strings, `uuid` as
strings, timestamps as `Date`. psycopg returns `int`, `Decimal`,
`uuid.UUID` and timezone-aware `datetime`. Code that compares a UUID with a
string, or formats a timestamp for the simulator's JSON, will silently
differ. Decide once: convert UUIDs to `str` at the database boundary;
serialize timestamps the way the TypeScript JSON did
(`2026-11-01T12:34:56.789Z`, milliseconds, `Z`), because the simulator UI and
golden files depend on it.

**P13. Connection pooler and prepared statements.** Production uses the
Supabase pooler in transaction mode (port 6543). psycopg 3 switches to
server-side prepared statements after a query runs 5 times, which **breaks
under a transaction-mode pooler**. Set `prepare_threshold=None`. Size the
pool for the chosen host; keep TLS (`sslmode=require` or stricter).

**P14. Transactions and locks.** psycopg opens a transaction implicitly on
the first query unless told otherwise. Plain queries must run in autocommit;
`transaction()` must be explicit and roll back on any exception. The
conversation lock (`pg_advisory_xact_lock(hashtextextended('<merchant>:<phone>', 0))`)
only holds inside a transaction, and the key text must be identical —
lowercase UUID, colon, phone — or Python and TypeScript would lock different
keys during the side-by-side phase. Keep computing the hash in SQL. The
savepoint-based nested transaction used in tests is ported as is.

**P15. Threads instead of one event loop.** Node runs one thing at a time per
process; a Python web server runs requests on several threads. Module-level
mutable state (the savepoint counter, the per-run sender cache) must be
thread-safe or per-request. Database correctness already relies on Postgres
locks, not on process memory — keep it that way (Handbook §2).

**P16. String length and case.** JavaScript `.length` counts UTF-16 units,
Python `len` counts characters: emoji count 2 in TypeScript, 1 in Python.
WhatsApp list titles are truncated at 24 characters, so truncation can differ
on emoji. `.trim()` and `str.strip()` strip slightly different character
sets; `\s+` collapsing differs per P9. Upper/lower-casing of Turkish
letters (`İ`, `ı`) must be checked by golden files, not assumed.

**P17. Dates and time zones.** Operator timestamps are DD/MM/YYYY 24-hour in
`Europe/Istanbul` (from `Intl.DateTimeFormat("en-GB")`). Python needs
`zoneinfo` **and the `tzdata` package** (slim containers have no time-zone
database). Deadlines inside workers used `Date.now()`; use
`time.monotonic()` so clock adjustments cannot stretch or cut a batch.

**P18. Outbound HTTP.** The Meta client uses a 15-second timeout; photo
download refuses redirects, checks the host allow-list (`facebook.com`,
`fbcdn.net`, `fbsbx.com`, HTTPS, port 443, no credentials in the URL), accepts
only JPEG/PNG/WebP and **stops reading at 10 MB while streaming**. httpx
follows no redirects by default, but a 3xx must be treated as an error, the
size limit enforced during the stream, and timeouts set explicitly.

**P19. Logs must stay safe and identical in shape.** One JSON line per event,
errors to stderr, keys `ts`, `level`, `event`, `merchant_id`,
`correlation_id`, masked `phone`, plus redaction of secrets, tokens, URLs with
credentials and phone-like numbers. Python's `logging` module and the web
server's **access log** add their own lines — the access log prints full
URLs, including the webhook's `hub.verify_token` query parameter. Disable or
sanitize it.

### Medium — operational

**P20. Cutover with conversations in flight.** Sessions, inbox and outbox rows
carry over (P3). Run only one application's workers at a time; switch Meta's
webhook URL and the maintenance URL together; keep the TypeScript deployment
ready to switch back until the Python one has run cleanly (§8).

**P21. Tooling gaps.** The Supabase CLI is installed through npm today;
install the standalone binary instead. Python Playwright, if used for browser
checks, must use the pre-installed Chromium (`/opt/pw-browsers/chromium`) in
cloud sessions, not download another.

**P22. The simulator needs some JavaScript.** Live chat bubbles, preset
playback and the Stop button cannot be pure server-rendered HTML. Keep that
JavaScript in one small, commented file, calling the same `/api/simulator`
JSON endpoint as today.

**P23. Scope creep.** The biggest schedule risk. Anything that is not
"identical behaviour in Python" goes on the follow-up list (§9), including
improvements that look trivial.

**P24. Losing the TypeScript reference too early.** Golden files, side-by-side
replay and rollback all need the TypeScript code. It is deleted only after one
quiet week of Python in production.

---

## 7. Things that must stay exactly the same

- Every customer-facing message, in English and Turkish, character for character
  (including the KVKK disclosure, nudge text, generic error text, list button
  labels "View options" / "Seçenekleri gör").
- WhatsApp limits: 10 list rows; title 24, description 72, button 20, header 60.
- Order-number normalization: uppercase, drop non `A–Z0–9`, strip leading
  zeros (keep a single `0`), validate with the merchant pattern by **search**.
- Retry backoff: `min(3600, 30 × 2^min(attempts, 7))` seconds for both inbox
  and outbox; worker deadline 40 s per run; batch limits (100 conversations,
  20 messages per conversation, 50 replies, 500 sessions, 200 retention groups).
- Idempotency keys: inbound message id; reply keys `<messageId>`,
  `error:<messageId>`, `nudge:<sessionId>`.
- One nudge per session; abandonment creates a case only when at least one
  valid field and a category exist.
- Erasure order and table list in `db/privacy.ts`; retention default 12 months.
- Login: username rule `^[a-z0-9_.@-]{1,100}$` after trim + lowercase; password
  at most 1024 characters at login, 12–1024 at provisioning.
- `safeNextPath` rule and the `/cases` fallback.
- The simulator refuses phone numbers with real WhatsApp activity.

---

## 8. Cutover plan (Port Step 7)

1. Confirm hosted schema and app version (P8). Back up the database.
2. Deploy Python to staging against a **copy** of production data; run
   DEPLOYMENT §5; verify an old password and an in-flight session (P3, P5).
3. Choose a quiet hour. Pause the GitHub maintenance workflow.
4. Deploy Python to production with the same environment variables (+
   `CHICCHAT_ENV=production`, P1).
5. Point Meta's webhook URL and `MAINTENANCE_URL` at the Python host. Re-enable
   maintenance. Meta retries failed deliveries, and messages already in the
   inbox are picked up by maintenance, so nothing is lost in the switch.
6. Watch logs and maintenance summaries for an hour; send real test messages.
7. **Rollback:** point the webhook and maintenance URL back to the TypeScript
   deployment. Both share the same database and schema, so no data moves.
8. After one quiet week: delete TypeScript, update docs, dev log entry.

---

## 9. Follow-up list (found during the port, not fixed in it)

Add items here as they are found; each becomes its own change after the port.

- User-visible text "replying from ChicChat is not in v0.2" in the console
  detail page, and similar "v0.2" comments (noted in v0.3 Step 0).
- Comment in `supabase/migrations/20260729120000_agent_console.sql` still points
  to the deleted `docs/RETROFIT.md` (migrations are not edited).

---

## 10. Progress log

Updated at the end of every port step, so work can resume from here.

| Step | Status | Notes |
|---|---|---|
| Baseline | ✓ | TypeScript: 195 unit tests, 153 DB tests pass on local PostgreSQL 16 (2026-11-01) |
| Port Step 0 | ✓ | `python/` skeleton (uv, ruff, mypy strict, pytest, import-linter contracts for domain purity and layers), Python CI job, golden exporter (`scripts/golden/`) and comparison helper (`python/tests/golden.py`) |
