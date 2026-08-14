# Deployment (v0.2 Step 7)

What a deployed ChicChat needs, in the order you need it. Written for Vercel +
hosted Supabase; anything that runs Next.js 16 and Postgres works, and the only
platform-specific piece is the cron entry in `vercel.json`.

Local development needs none of this — see `README.md`.

---

## 0. What you are deploying

| Surface | Path | Who reaches it |
|---|---|---|
| Merchant case views | `/cases` | operator, behind the passcode |
| Agent console | `/console` | operator, behind the passcode |
| Taxonomy editor | `/config` | operator, behind the passcode |
| Chat simulator | `/simulator` | passcode **and** `SIMULATOR_ENABLED=true` |
| WhatsApp webhook | `/api/whatsapp/webhook` | Meta — ungated, verifies its own signature |
| Inactivity job | `/api/maintenance/sessions` | scheduler — bearer secret |
| Health check | `/api/health` | uptime monitor — ungated, reports no detail |

**The console is protected by one shared passcode, not user accounts.** It shows
customer phone numbers and conversation transcripts (SPEC §12), so the app
**refuses to start** in production without `CONSOLE_PASSCODE`. Per-user accounts
and per-merchant permissions are v0.3.

---

## 1. Hosted Postgres (Supabase)

1. Create a project. Keep the database password — it is in the connection URI.

   **Pick the region nearest your merchants, and pick it correctly the first
   time** — Supabase cannot move a project between regions, so changing your
   mind means a new project, re-pushed migrations, a re-seed and a new
   `DATABASE_URL` everywhere. Measured from Turkey: `ap-south-1` (Mumbai)
   answers a trivial `select 1` in **~210 ms**, against ~2.5 ms for a local
   container. Every page in the console runs several queries, and an intake
   turn runs more, so the region is multiplied by every round trip.

2. Link this repo to it and push the migrations:

```bash
npx supabase link --project-ref <your-project-ref>
```

```bash
npm run db:push
```

3. Seed the taxonomy and the demo merchants:

```bash
DATABASE_URL='<pooler-uri>' npm run db:seed
```

Get `<pooler-uri>` from the **Connect** button in the dashboard's top bar (it is
not under Project Settings): choose the **Transaction pooler** entry, port
**6543**, and replace the `[YOUR-PASSWORD]` placeholder with the database
password. Use the pooler, not the direct 5432 URI — serverless functions open many
short-lived connections and would exhaust a direct connection limit.

**Append `?uselibpqcompat=true&sslmode=require` to the URI.** Two traps:

- Without SSL parameters the pooler happily accepts a **plaintext** connection,
  so the password and every customer message would cross the internet in the
  clear. Always verify: `client.connection.stream.encrypted` must be `true`.
- A bare `?sslmode=require` **fails** with this version of `pg`, which treats
  `require` as `verify-full` and then rejects Supabase's certificate chain. The
  `uselibpqcompat=true` prefix restores libpq's meaning: encrypt, do not verify
  the certificate authority.

That gives encryption against eavesdropping but not against an active
man-in-the-middle. To close that too, download the project's CA certificate from
the dashboard, ship it with the deployment, and use
`?sslmode=verify-full&sslrootcert=<path>`.

`db:seed` is idempotent — re-running it is safe, and it re-links each merchant's
WhatsApp number from the environment.

---

## 2. Environment variables

Set these on the host (Vercel → Settings → Environment Variables). `.env.example`
lists them all with comments; these are the ones a deployment cannot do without.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **yes** | Pooler URI + `?sslmode=require` |
| `CONSOLE_PASSCODE` | **yes** in production | ≥ 12 characters; the app will not boot without it |
| `MAINTENANCE_SECRET` | recommended | Lets you trigger the inactivity job by hand |
| `CRON_SECRET` | recommended | Vercel sends this automatically to cron invocations |
| `WHATSAPP_*` | Step 8 | Until Meta is wired up the console and simulator work without them |
| `WHATSAPP_APP_SECRET` | with Meta | **Signature verification is mandatory in production** — inbound is rejected without it |
| `SIMULATOR_ENABLED` | optional | `true` exposes `/simulator`; it writes real cases |

The app checks all of this at boot (`src/instrumentation.ts`) and either lists
what is missing and refuses to start, or logs warnings and continues. After
deploying, `GET /api/health` returns `{"ok":true,"database":"up","warnings":N}`.

---

## 3. Deploy

```bash
npx vercel deploy --prod
```

Vercel detects Next.js; no build configuration is needed.

## 3a. Scheduling the inactivity job

The nudge fires after `nudge_after_minutes` (default 5), so the sweep must run at
least that often. **A free Vercel plan only runs crons once a day**, which would
effectively disable the nudge — so the schedule lives outside Vercel:

`.github/workflows/maintenance.yml` calls the endpoint every 5 minutes. Add two
repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `MAINTENANCE_URL` | `https://<host>/api/maintenance/sessions` |
| `MAINTENANCE_SECRET` | the same value as the deployment's `MAINTENANCE_SECRET` |

Without them the workflow exits successfully without calling anything. Any other
scheduler works the same way — cron-job.org, an uptime monitor, a server crontab:

```bash
curl -fsS -X POST -H "Authorization: Bearer $MAINTENANCE_SECRET" https://<host>/api/maintenance/sessions
```

The endpoint also accepts `GET`, since many schedulers only send GET. It is
idempotent: a late or doubled run cannot double-nudge, because the session is
marked before the message is sent.

<details>
<summary>On a paid Vercel plan you can use its own cron instead</summary>

Add `vercel.json`:

```json
{
  "crons": [{ "path": "/api/maintenance/sessions", "schedule": "*/5 * * * *" }]
}
```

Vercel supplies `CRON_SECRET` automatically; set it as an environment variable
and the endpoint accepts it. Then delete the GitHub workflow so the job is not
swept twice.

</details>

---

## 4. Verify the deployment

```bash
curl -s https://<host>/api/health
```

Then, in a browser:

1. `/cases` redirects to `/login`; the passcode gets you in.
2. The merchant switcher lists both seeded merchants and switching changes the data.
3. With `SIMULATOR_ENABLED=true`, `/simulator` completes an intake and the case
   appears in `/cases` and `/console` — this is the Step 7 gate.
4. `/api/whatsapp/webhook` is reachable without the passcode and answers `403`
   to a wrong verify token.

Wiring the real Meta number at the deployed URL is **Step 8**, not this step.

---

## 5. Running the tests against hosted config

The integration suite writes and rolls back real transactions, so point it at a
database you do not mind touching — a second Supabase project, or a branch:

```bash
DATABASE_URL='<pooler-uri>' npx vitest run --config vitest.integration.config.ts --testTimeout=180000
```

It seeds before running. Never point it at a database serving real merchants.

Two things differ from a local run, both caused by distance:

- **Raise the timeout.** The default is 30 s per test, which is generous when a
  query costs 2 ms and far too tight when it costs 210 ms. The heaviest tests
  drive two complete intakes — well over a hundred sequential round trips — and
  time out against a distant database while being perfectly correct. The
  default is left alone so that a genuinely hung local test still fails fast.
- **Expect it to take ~15–20 minutes** rather than ~30 seconds.

`npm run test:db` keeps the 30 s default and is the right command locally.

---

## What is deliberately not here

- **Per-merchant WhatsApp access tokens.** One Meta app's system-user token can
  send from every number in its WABAs, and the number to send *from* is already
  per-merchant (`whatsapp_channels`). Storing a token per merchant only becomes
  necessary when merchants bring their own Meta apps.
- **Per-user authentication and audit.** Console actions are attributed to
  `agent`; the schema has the column, and identity fills it in v0.3.
- **Media storage.** Photos are WhatsApp media ids; downloading them into a
  private bucket lands with KVKK retention (docs/RETROFIT.md R13).
