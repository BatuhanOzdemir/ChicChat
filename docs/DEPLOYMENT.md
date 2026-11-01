# Deployment

ChicChat runs as a Python web server (FastAPI under uvicorn) with PostgreSQL and
a recurring HTTP job. This guide describes the Python application in `python/`.

**Until the cutover in Port Step 7** ([PORT.md](PORT.md) §8), production still
runs the TypeScript version on Vercel. Do not point Meta or the maintenance job
at a Python deployment before that step is signed off.

## 1. Database and migrations

The schema is unchanged by the port: the same SQL files in `supabase/migrations`.
Back up an existing database and verify the migration sequence in staging first.
Apply pending files with the Supabase CLI (standalone binary; link the intended
project, then `supabase db push`). The September files are:

- `20260909120000_case_history.sql`: snapshots and historical metadata backfill.
- `20260909130000_reliable_delivery.sql`: durable inbox/outbox and delivery channels.
- `20260909140000_console_identity.sql`: accounts, memberships, sessions, login throttling.
- `20260909150000_private_media.sql`: private image storage.
- `20260909160000_private_tables.sql`: RLS on all application tables.

The application never migrates a database at startup. `python -m
chicchat.scripts.migrate` exists for **local** development only and refuses
remote hosts.

The application uses server-side SQL. Configure `DATABASE_URL` with a trusted
backend role that can access these tables (for example the database owner).
RLS has no anonymous/authenticated Data API policies; never expose SQL
credentials to clients. Supabase's transaction-mode pooler (port 6543) works:
the app disables server-side prepared statements for it. Use verified TLS with
the provider's CA configuration, and keep the database near the app's region.

For a fresh demo database, run `uv run python -m chicchat.scripts.seed` with its
explicit `DATABASE_URL`. Do not seed demo merchants into an established customer
database by accident.

## 2. Provision accounts before deploying

Set `DATABASE_URL` and `CHICCHAT_USER_PASSWORD` in your shell or secret runner.
The password must contain 12–1024 characters. Then, in `python/`:

```bash
uv run python -m chicchat.scripts.console_user operator-name merchant-uuid [another-merchant-uuid]
```

Replace the UUIDs with the merchants that this person may access. Re-running
the command replaces that account's password and memberships and revokes
previous sessions. Use a unique account per person. Remove the password
environment variable after provisioning. The script does not load `.env` files.

Accounts and password hashes are shared with the TypeScript version: an account
provisioned by either works in both, and existing sessions survive the cutover.

Production always requires authentication, regardless of `CONSOLE_AUTH_REQUIRED`.
Sessions expire after 12 hours, sign-out revokes the session, and
membership/enabled status is checked on every request. Console audit events
record the account username. All members currently have full
console/configuration access to their assigned merchants; fine-grained roles
are a future change.

## 3. Configure and run the app

| Setting | Purpose |
|---|---|
| `DATABASE_URL` | Required server-side PostgreSQL connection |
| `CHICCHAT_ENV` | Leave unset (or anything but `development`) in every deployment. Unset means production |
| `WHATSAPP_ACCESS_TOKEN` | Meta system-user token for sending and private media retrieval |
| `WHATSAPP_APP_SECRET` | Required to verify production webhook signatures |
| `WHATSAPP_VERIFY_TOKEN` | Verification handshake secret configured in Meta |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_GRAPH_VERSION` | Meta connection configuration; merchant number mappings live in `whatsapp_channels` |
| `MAINTENANCE_SECRET` or `CRON_SECRET` | Bearer credential for maintenance |
| `SIMULATOR_ENABLED=true` | Optional production simulator, protected by account memberships |
| `HOST`, `PORT`, `WEB_CONCURRENCY` | Listen address, port and worker processes (defaults `127.0.0.1`, `8000`, `1`) |
| `FORWARDED_ALLOW_IPS` | Address of the TLS-terminating proxy, so client details are trusted from it only |
| `DATABASE_POOL_SIZE` | Connections per worker (default 10); keep within the database's limit |

Install and start (the host needs Python 3.13 and uv; `tzdata` is a dependency,
so slim images without a time-zone database work):

```bash
cd python
uv sync --locked --no-dev
HOST=0.0.0.0 uv run python -m chicchat.web
```

The app refuses to start without `DATABASE_URL` and logs any configuration
warnings at startup. Use a host that keeps the process running (a container
service rather than short-lived functions): the webhook acknowledges Meta first
and processes the message right after the response, inside the same process.

The access log is off on purpose: it would print full URLs, including the
webhook's query parameters. The app writes one structured JSON line per event
to stdout (errors to stderr), with phone numbers masked.

Webhook processing persists messages before acknowledging them. A failed
database acceptance returns 503 for provider retry. Processing that is
interrupted is recovered by maintenance. Replies are durable and retried in
conversation order with exponential backoff. External delivery remains
at-least-once.

New image evidence is downloaded to private PostgreSQL storage and served only
through merchant-scoped authenticated routes, with no-store caching. Existing
expired Meta-only image references remain unavailable. Include this storage in
capacity planning and backup lifecycle management.

Rebuilding the stylesheet is only needed after changing templates; the built
`python/chicchat/web/static/app.css` is committed. Use the Tailwind standalone
CLI v4.3.1: `tailwindcss -i chicchat/web/styles.css -o chicchat/web/static/app.css --minify`.

## 4. Enable maintenance

Review merchant retention settings before enabling this job: it permanently
deletes expired cases, transcripts, photos, queued messages and sessions. The
default is 12 months. Configuration also exposes explicit per-customer erasure.

The endpoint `/api/maintenance/sessions` accepts GET or POST with
`Authorization: Bearer <secret>`. It runs retention, pending inbox processing,
inactivity handling, and outbound retries. Invoke it every five minutes or more
frequently according to operational requirements.

The included `.github/workflows/maintenance.yml` uses repository secrets:

- `MAINTENANCE_URL`: the deployed endpoint URL.
- `MAINTENANCE_SECRET`: the same secret as the app.

Missing secrets, HTTP failures, and nonzero `failed` summaries fail the
workflow. Configure notifications for those failures. Bounded batches resume on
subsequent runs; monitor queue backlog as traffic grows.

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
The concurrency tests intentionally commit transactions and refuse to run
unless the database is local and named with an `_test` suffix.

## Rollback

Keep backups until staging and production checks pass. The Python and
TypeScript versions share the same database and schema, so rolling back is
pointing the Meta webhook URL and `MAINTENANCE_URL` back to the previous
deployment; no data moves. Run only one version's workers at a time. Do not
remove inbox/outbox/media tables to roll back: that would lose queued work and
evidence. Prefer fixing forward, or temporarily stop incoming traffic and
workers while choosing a version.
