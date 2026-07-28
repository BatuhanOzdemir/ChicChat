/**
 * Simulator endpoint (SPEC §7). Thin: validate the body at the boundary, then
 * delegate to the simulator service. No Meta credentials are read here.
 */
import { parseSimulatorRequest } from "@/lib/simulator/protocol";
import { getPool } from "@/db/client";
import { isSimulatorEnabled } from "@/server/simulator/enabled";
import { runSimulatorAction } from "@/server/simulator/service";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!isSimulatorEnabled()) {
    return Response.json({ error: "simulator disabled" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = parseSimulatorRequest(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const result = await runSimulatorAction(getPool(), parsed.value);
    return Response.json(result, { status: 200 });
  } catch (err) {
    // The simulator surfaces its own failures instead of hiding them.
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
