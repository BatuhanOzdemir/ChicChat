/**
 * Health check (Step 7): is this deployment actually able to work?
 *
 * Ungated, so an uptime monitor can reach it, and therefore deliberately
 * uninformative: it reports *whether* the database answers and *how many*
 * configuration warnings there are, never which variables or values. Missing
 * required configuration cannot be reported here at all — the app refuses to
 * boot in that case (src/instrumentation.ts), which is the louder signal.
 */
import { getDatabase } from "@/db/client";
import { checkEnvironment } from "@/server/env";
import { logger } from "@/server/logging/logger";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { warnings } = checkEnvironment();

  try {
    await getDatabase().query("select 1");
  } catch (err) {
    logger.error("unexpected_exception", err, { during: "health_check" });
    return Response.json(
      { ok: false, database: "unreachable", warnings: warnings.length },
      { status: 503 },
    );
  }

  return Response.json(
    { ok: true, database: "up", warnings: warnings.length },
    { status: 200 },
  );
}
