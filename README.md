# ChicChat

WhatsApp support intake for fashion retailers: merchant-defined categories and
fields, durable conversation processing, rule-based routing, case history, and
an agent console. Python (FastAPI), PostgreSQL.

The application lives in [`python/`](python). The original TypeScript (Next.js)
version under `src/` is kept as the reference until the Python version has run
in production (see [the port plan](docs/PORT.md), Port Step 7); it is no longer
where changes are made.

## Local development

1. Install [uv](https://docs.astral.sh/uv/) and Docker.
2. Start PostgreSQL and create a database:

   ```bash
   docker run -d --name chicchat-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
   docker exec chicchat-db createdb -U postgres chicchat
   ```

3. In `python/`, install, migrate and seed (all commands below run in `python/`):

   ```bash
   cd python
   uv sync
   export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/chicchat
   uv run python -m chicchat.scripts.migrate
   uv run python -m chicchat.scripts.seed
   ```

4. Run the app in development mode and open <http://127.0.0.1:8000/simulator> to
   exercise intake without sending WhatsApp messages:

   ```bash
   CHICCHAT_ENV=development uv run python -m chicchat.web
   ```

`CHICCHAT_ENV=development` turns on the local conveniences: no login, optional
webhook signatures, the simulator. **Without it the app behaves as production**
(named accounts required, signatures mandatory). Set `CONSOLE_AUTH_REQUIRED=true`
to test login locally, and provision an account as described in
[Deployment](docs/DEPLOYMENT.md). Keep secrets out of Git.

## Verification

```bash
cd python
uv run ruff check . && uv run ruff format --check .   # lint and formatting
uv run mypy                                           # strict type checking
uv run lint-imports                                   # architecture rules
uv run pytest                                         # unit and HTTP tests (no database)
```

Database and browser tests need a disposable local database whose name ends in
`_test` (for example `chicchat_test`); the preparation script refuses anything
else, because the concurrency tests commit transactions:

```bash
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/chicchat_test
uv run python -m chicchat.scripts.prepare_test_db
uv run pytest -m db        # 150+ integration tests against PostgreSQL
uv run pytest -m browser   # the operator walkthrough in Chromium (Playwright)
```

CI runs all of the above on every push, with its own PostgreSQL 17 service.

## Project documents

- [Specification](docs/SPEC.md)
- [Development history, including the September 2026 repairs](docs/DEVELOPMENT-LOG.md)
- [Deployment and account provisioning](docs/DEPLOYMENT.md)
- [Python port plan and progress](docs/PORT.md)
- [Engineering handbook](docs/ENGINEERING-HANDBOOK.md)
- [Development conventions and roadmap](CLAUDE.md)
