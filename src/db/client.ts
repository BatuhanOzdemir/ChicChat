/**
 * Server-side Postgres pool for the app (Next.js server components / actions).
 * A lazily-created singleton so dev hot-reload doesn't open a pool per request.
 * Reads DATABASE_URL (see .env.example); falls back to the local Supabase URL.
 */
import { Pool } from "pg";

const LOCAL_DEFAULT = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Reuse the pool across hot-reloads in dev.
const globalForPg = globalThis as unknown as { chicchatPgPool?: Pool };

export function getPool(): Pool {
  if (!globalForPg.chicchatPgPool) {
    globalForPg.chicchatPgPool = new Pool({
      connectionString: process.env.DATABASE_URL ?? LOCAL_DEFAULT,
    });
  }
  return globalForPg.chicchatPgPool;
}
