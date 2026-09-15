# Deployment

ChicChat requires a Node.js Next.js host, PostgreSQL, and a recurring HTTP job.
The September repairs introduce required migrations and replace shared-passcode
access with named accounts. Apply the sequence below before serving traffic.

## 1. Database and migrations

Back up an existing database and verify the migration sequence in staging first.
Apply all pending files in `supabase/migrations` using your normal migration runner
(or link the intended Supabase project and run `npm run db:push`). The new files are:

- `20260909120000_case_history.sql`: snapshots and historical metadata backfill.
- `20260909130000_reliable_delivery.sql`: durable inbox/outbox and delivery channels.
- `20260909140000_console_identity.sql`: accounts, memberships, sessions, login throttling.
- `20260909150000_private_media.sql`: private image storage.
- `20260909160000_private_tables.sql`: RLS on all application tables.

The application uses server-side SQL. Configure `DATABASE_URL` with a trusted
backend role that can access these tables (for example the database owner).
RLS has no anonymous/authenticated Data API policies; do not expose SQL credentials
to clients. Use the provider's connection pooler for serverless deployments and
verified TLS with the provider's CA configuration. Keep the database near the app
region to reduce transaction latency.

For a fresh demo database, run `npm run db:seed` with its explicit `DATABASE_URL`.
Do not seed demo merchants into an established customer database by accident.

## 2. Provision accounts before deploying

Set `DATABASE_URL` and `CHICCHAT_USER_PASSWORD` in your shell or secret runner.
The password must contain 12–1024 characters. Then run:

```bash
npm run console:user -- operator-name merchant-uuid [another-merchant-uuid]
```

Replace the UUIDs with the merchants that this person may access. Re-running the
command replaces that account's password and memberships and revokes previous
sessions. Use a unique account per person. Remove the password environment variable
after provisioning. The script does not implicitly load `.env.local`.

Production always requires authentication, regardless of `CONSOLE_AUTH_REQUIRED`.
`CONSOLE_PASSCODE` is retired and old shared-secret cookies are rejected. Sessions
expire after 12 hours, sign-out revokes the session, and membership/enabled status
is checked on requests. Console audit events record the account username. All
members currently have full console/configuration access to their assigned merchants;
fine-grained roles are a future change.

For local authentication checks, set `CONSOLE_AUTH_REQUIRED=true`. Otherwise local
`next dev` permits development access without an account. Never expose that dev
server publicly.

## 3. Configure and deploy the app

| Setting | Purpose |
|---|---|
| `DATABASE_URL` | Required server-side PostgreSQL connection |
| `WHATSAPP_ACCESS_TOKEN` | Meta system-user token for sending and private media retrieval |
| `WHATSAPP_APP_SECRET` | Required to verify production webhook signatures |
| `WHATSAPP_VERIFY_TOKEN` | Verification handshake secret configured in Meta |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_GRAPH_VERSION` | Meta connection configuration; merchant number mappings live in `whatsapp_channels` |
| `MAINTENANCE_SECRET` or `CRON_SECRET` | Bearer credential for maintenance |
| `SIMULATOR_ENABLED=true` | Optional production simulator, protected by account memberships |

Run `npm ci`, `npm run build`, and deploy with your host's normal process. Ensure
Node.js middleware is supported, and allow the maintenance route's configured
execution duration. Do not run a hosted migration implicitly at application startup.

Webhook processing persists messages before acknowledging them. A failed database
acceptance returns 503 for provider retry. Processing runs after the response and
is recovered by maintenance if interrupted. Replies are durable and retried in
conversation order with exponential backoff. External delivery remains at-least-once.

New image evidence is downloaded to private PostgreSQL storage and served only
through merchant-scoped authenticated routes, with no-store caching. Existing
expired Meta-only image references remain unavailable. Include this storage in
capacity planning and backup lifecycle management.

## 4. Enable maintenance

Review merchant retention settings before enabling this job: it permanently deletes
expired cases, transcripts, photos, queued messages and sessions. The default is
12 months. Configuration also exposes explicit per-customer erasure.

The endpoint `/api/maintenance/sessions` accepts GET or POST with
`Authorization: Bearer <secret>`. It runs retention, pending inbox processing,
inactivity handling, and outbound retries. Invoke it every five minutes or more
frequently according to operational requirements.

The included `.github/workflows/maintenance.yml` uses repository secrets:

- `MAINTENANCE_URL`: the deployed endpoint URL.
- `MAINTENANCE_SECRET`: the same secret as the app.

Missing secrets, HTTP failures, and nonzero `failed` summaries fail the workflow.
Configure notifications for those failures. A scheduler with stricter timing may
be needed for precise nudge delivery. Bounded batches resume on subsequent runs;
monitor queue backlog as traffic grows. Do not rely solely on post-response work.

## 5. Verify in staging

1. Check `/api/health` and inspect startup warnings.
2. Confirm logged-out `/cases`, `/console`, `/config`, and `/simulator` require login.
3. Sign in with an account assigned to one merchant; confirm no other merchant's
   cases, simulator actions or private photos can be accessed.
4. Run a simulated photo intake, open its case and evidence, inject a delivery
   failure, and retry the pending reply.
5. Run maintenance on synthetic due sessions and inspect its JSON summary.
6. Verify a signed Meta webhook and an actual reply using a designated test number.
7. Verify sign-out revokes access, then enable production traffic and monitoring.

Use a disposable local database for automated tests. See [README](../README.md).
The concurrency repair tests intentionally commit transactions and refuse to run
unless the database is local and named with an `_test` suffix.

## Rollback

Keep backups until staging and production checks pass. The migrations are additive,
but a rollback to the old application restores its old authentication and delivery
semantics. Do not remove inbox/outbox/media tables to roll back the app: that would
lose queued work and evidence. Prefer fixing forward, or temporarily stop incoming
traffic and workers while choosing a compatible application version.
