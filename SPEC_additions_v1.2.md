# Additions to `docs/SPEC.md` (v1.2)

Append to the end of the existing specification.

---

## 10. Non-functional requirements

- **Webhook acknowledgement:** the WhatsApp webhook route returns `200` immediately
  after signature verification; processing happens after acknowledgement. Meta
  retries slow/failed deliveries, so slowness here creates duplicates.
- **Flow endpoint latency (the one hard latency requirement):** the WhatsApp Flows
  data-exchange endpoint must respond fast enough to pass Meta's health checks —
  unhealthy endpoints get throttled (10 msgs/hr) or blocked. Mitigation stays as
  specced in §6.3: fetch and cache the order at the `ORDER_NUMBER` step so
  `SELECT_ITEMS` renders from cache.
- Avoid unnecessary DB round trips in the per-message path (session load → advance
  → session save should be a small, fixed number of queries).

## 11. Reliability

- **Idempotent webhook processing.** Every inbound WhatsApp message carries a
  message ID; store processed IDs and skip duplicates. Duplicate deliveries must
  never create duplicate sessions, duplicate case field writes, or duplicate cases.
- **Transactional multi-record writes.** `persistCase` (case + case_fields +
  case_items) executes in a single DB transaction — a crash mid-write must never
  leave a partial case.
- **Session TTL: 24 hours** (aligned with the WhatsApp service window). A session
  with no activity for 24h is expired by a cleanup job. Expired sessions with ≥1
  captured field are persisted as `cases.status = 'abandoned'` (useful signal for
  the merchant); empty sessions are deleted.

## 12. Security & privacy

- Verify the Meta webhook signature (`X-Hub-Signature-256`) on every request;
  reject on mismatch. Validate/parse all inbound payloads before use — malformed
  input gets logged and dropped, never processed.
- Never log secrets, tokens, or full customer phone numbers (mask to last 4
  digits in logs). Never expose internal error details to WhatsApp replies.
- **KVKK / data protection (required before any real customer traffic):**
  - The bot's first message in every new conversation includes a short disclosure
    line with a link to the merchant's aydınlatma metni (the LCW pattern).
  - Data retention: closed cases and their photos are retained for a
    merchant-configurable period (default 12 months), then hard-deleted.
  - Deletion capability: a merchant (or data subject via the merchant) can request
    deletion of all cases/sessions for a given phone number; provide an internal
    admin operation for this from day one.
  - Media (photos) are stored in private buckets, never publicly listable.

## 13. Failure scenarios (defined behaviour)

| Scenario | Behaviour |
|---|---|
| Invalid/malformed payload | Log (structured), drop, still return 200 to Meta |
| Bad signature | Return 401, log warning |
| Order number not found (Tier 1) | Tell customer, offer retry once, then continue in Tier-0 mode (capture as text) |
| Multiple matching orders | Ask customer to disambiguate by order date (list message of matches, max 10) |
| Integration (İkas/Shopify) unavailable | Degrade to Tier-0 for this conversation; flag `integration_tier=0` on the case; log integration failure |
| Database unavailable | Webhook still returns 200; message processing fails into structured error log; customer receives a "try again shortly" message if send is possible |
| Duplicate webhook delivery | Detected via message-ID idempotency; skipped silently |
| Flow endpoint timeout | Cached-order design prevents most; on cache miss failure, Flow shows error screen with retry |
| Customer abandons mid-intake | Session TTL rules (§11) |
| Retry after partial failure | Safe because writes are transactional + idempotent |

## 14. Scalability assumptions (v1 — keep it short)

Single-digit merchants, low thousands of conversations/month, one region.
Postgres and one Next.js deployment are ample. Revisit only when a merchant's
volume or merchant count makes any assumption false.

## 15. Observability

Structured (JSON) logs, one line per event, for: inbound webhook received,
message routed (session id, category, step), validation failure, integration
call + failure, case persisted, unexpected exception (with stack). Include
merchant_id and a correlation id (message id) on every line. No PII beyond
masked phone.

## 16. Maintainability

Business logic stays in `src/lib` (framework-free, no React/Next/DB imports) —
this is what keeps the engine testable and portable. Framework and I/O layers
stay thin.
