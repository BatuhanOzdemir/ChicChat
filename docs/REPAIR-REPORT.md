# September 2026 repair report

Implemented locally on 2026-09-09 against the sequence in [REPAIR-PLAN.md](REPAIR-PLAN.md).
No hosted database migrations, real WhatsApp sends, customer erasure, or deployment
were performed during verification.

## Results

| Review issue | Implemented correction |
|---|---|
| Phones and secrets leaked through correlation IDs and exception text | Recursive diagnostic redaction; sanitized transport failures; opaque session correlation IDs |
| Concurrent answers could overwrite session progress | Transaction-scoped PostgreSQL advisory locks per merchant and customer, including first contact |
| Acknowledged webhooks could disappear before processing | Commit an inbox record before HTTP 200; return 503 on failed durable acceptance; scheduled recovery |
| Failed replies were lost or replaced by contradictory generic errors | Queue replies in the intake transaction; deliver after commit; ordered retries with backoff and console visibility |
| Deleted taxonomy hid historical cases | Immutable category and field snapshots; case lists, details, queues and filters use snapshots |
| Invalid rule JSON could crash intake | Bounded recursive validation at configuration and evaluation boundaries; simple field/operator/value input alongside advanced JSON |
| Resumed sessions could receive another nudge | Persist one nudge marker for the lifetime of the session; queue the nudge atomically |
| Abandonment could duplicate or partially persist a case | Conversation lock plus one transaction for case creation and session removal |
| Shared access lacked accountable tenant isolation | Named accounts, salted scrypt hashes, opaque revocable sessions, login throttling, explicit memberships and named console audit events |
| Erasure/retention and private evidence were incomplete | Merchant-scoped erasure, scheduled retention across payloads and cases, private photo persistence and authenticated evidence routes |
| Simulator recovery and customer language were incomplete | One-shot failure injection, pending-delivery retry, protection against simulated actions on real conversations, English/Turkish prompts and selected-merchant continuity |
| Automation could silently skip failed work | CI runs checks with disposable PostgreSQL; maintenance workflow fails on missing secrets or nonzero failure summaries |

## Verification

- 185 unit tests passed across 28 files.
- 146 database integration tests passed across 12 files on local PostgreSQL 17.
- Final targeted checks passed with two additional database regressions (12 repair
  tests total) and one additional API regression (3 simulator API tests total).
- Lint, TypeScript checking, and a clean production build passed.
- Independent database connections exercise concurrent intake, duplicate workers,
  nudge races, abandonment rollback, deletion, retention, account revocation,
  and merchant-scoped media access.
- Browser simulation verified a failed Turkish reply can be retried without
  restarting intake, and an English photo intake completes with routing and evidence.
- The production build's browser check confirmed named-account login, a merchant
  selector restricted to the account's membership, and successful private image loading.

The test database and all verification accounts/messages were synthetic. Meta
media retrieval is tested with mocked HTTP responses; live Meta delivery remains
an external deployment check.

## Rollout and limitations

Apply the five additive migrations dated `20260909` before running the new app,
then provision named accounts and merchant memberships. Follow [DEPLOYMENT.md](DEPLOYMENT.md)
for the deployment sequence. Existing shared-passcode cookies are invalid.

All application tables have RLS enabled without public API policies. Server SQL
must use a trusted backend database role with the required access; browsers must
never receive that credential. Tenant isolation is also enforced in server code.

Private image bytes currently live in PostgreSQL (JPEG/PNG/WebP, maximum 10 MB each).
This is a deliberate implementation choice instead of a separate storage bucket;
object storage can replace it when media volume warrants that work. Previously
expired Meta-only references cannot be recovered. Previously deleted taxonomy
without remaining metadata is shown with a placeholder, not reconstructed.

Retention permanently removes expired records when the maintenance endpoint runs.
Review each merchant's retention configuration before enabling the scheduler on
existing data. Database backup expiry and external provider copies remain operational
responsibilities outside the application's deletion transaction.

Inbound processing has one committed state transition per message ID. WhatsApp
delivery is **at-least-once**: if Meta accepts a send but the connection or final
database commit fails, retrying can send the same reply again. A database outbox
cannot guarantee exactly-once effects in another service. Workers are bounded
batches and require a functioning scheduler to drain persistent work.

Ikas integration, Meta Flow, granular account roles, and real-merchant pilot
measurements remain separate roadmap work. The privacy controls here implement
application behavior; they do not establish a legal-compliance certification.
