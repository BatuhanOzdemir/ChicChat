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

Take `<pooler-uri>` from Supabase → Project Settings → Database → Connection
string → **Connection pooling** (port 6543), and append `?sslmode=require`. Use
the pooler, not the direct 5432 URI: serverless functions open many short-lived
connections and will exhaust a direct connection limit.

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

Vercel detects Next.js; no build configuration is needed. `vercel.json` adds one
scheduled job:

```
*/5 * * * *  ->  /api/maintenance/sessions
```

Five minutes matches the default `nudge_after_minutes`, because a nudge can never
fire sooner than the sweep interval.

> **Vercel Hobby plans only run crons once a day**, which effectively disables
> the nudge (SPEC §11). Either use a paid plan or point any external scheduler at
> the endpoint instead:
>
> ```bash
> curl -X POST -H "Authorization: Bearer $MAINTENANCE_SECRET" https://<host>/api/maintenance/sessions
> ```
>
> The endpoint accepts `GET` too, since most schedulers only send GET.

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
DATABASE_URL='<pooler-uri>' npm run test:db
```

It seeds before running. Never point it at a database serving real merchants.

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
