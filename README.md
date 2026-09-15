# ChicChat

WhatsApp support intake for fashion retailers: merchant-defined categories and
fields, durable conversation processing, rule-based routing, case history, and
an agent console. Next.js, TypeScript, and PostgreSQL.

## Local development

1. Install Node.js 22 and Docker, then run `npm ci`.
2. Run `npm run db:start`, copy `.env.example` to `.env.local`, and set the local
   `DATABASE_URL` printed by Supabase. Keep secrets out of Git.
3. Run `npm run db:migrate` and `npm run db:seed`.
4. Run `npm run dev`; open `/simulator` to exercise intake without sending WhatsApp messages.

Local development bypasses login by default. Set `CONSOLE_AUTH_REQUIRED=true`
and provision an account as described in [Deployment](docs/DEPLOYMENT.md) to test
authentication. Production always requires named accounts.

## Verification

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

For database tests, explicitly set `DATABASE_URL` to a disposable local PostgreSQL
database named with an `_test` suffix (for example `chicchat_test`). Then run
`npm run test:db:prepare` and `npm run test:db`. The preparation script refuses
remote or non-test databases. Concurrency repair tests commit transactions and
must never run against customer data. CI provisions its own PostgreSQL 17 service.

## Project documents

- [Specification](docs/SPEC.md)
- [Development history](docs/DEVELOPMENT-LOG.md)
- [Repair plan](docs/REPAIR-PLAN.md) and [implementation report](docs/REPAIR-REPORT.md)
- [Deployment and account provisioning](docs/DEPLOYMENT.md)
- [Development conventions and roadmap](CLAUDE.md)
