# September 2026 repair plan

The user authorized implementation of this repair sequence on 2026-09-09.
This authorization supersedes the old per-step sign-off pauses for this batch.
No hosted migrations, real customer erasure, or deployment is part of local verification.

| Phase | Work | Verification gate |
|---|---|---|
| 1 | Redact diagnostics; validate condition trees at form and evaluation boundaries | Synthetic phone/secret regression tests; malformed and excessive-depth rules rejected |
| 2 | Snapshot case taxonomy and field metadata; preserve deleted-category history | Delete taxonomy after intake; list, detail, queue, filters and evidence still work |
| 3 | Transaction-level conversation locks; one nudge; atomic abandonment | Independent PostgreSQL connections race safely; resumed sessions never re-nudge |
| 4 | Durable inbox before acknowledgement; transactional outbox; retry worker | Fail delivery then retry without advancing intake twice; workers serialize |
| 5 | Customer erasure and retention; scoped console sessions | Erasure removes transcripts and queued payloads; another merchant remains untouched; forged access refused |
| 6 | Simulator recovery controls, regression suite and documentation | Unit/integration tests, lint, typecheck, production build; record external limitations |

The deferred Ikas connector and Meta Flow are separate milestones. Product-pilot
measurements require real merchants. Media persistence and customer-language UX
will be addressed within the repaired intake path where feasible and explicitly
reported if any external setup remains.

Delivery semantics: PostgreSQL can guarantee one state transition per inbound
message. External WhatsApp sends cannot be made exactly-once across a network
failure after Meta accepts a request; retries are at-least-once. Preserve this
distinction in tests and operating documentation.
