import { notFound } from "next/navigation";
import { getPool } from "@/db/client";
import { listMerchants } from "@/db/config";
import { isSimulatorEnabled } from "@/server/simulator/enabled";
import { SimulatorClient } from "./simulator-client";

// Always reads the live DB.
export const dynamic = "force-dynamic";

export default async function SimulatorPage() {
  // Development/demo surface only (SPEC §7).
  if (!isSimulatorEnabled()) notFound();

  const merchants = await listMerchants(getPool());

  return (
    <main className="mx-auto max-w-6xl p-6 text-zinc-900 dark:text-zinc-100">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold">Chat simulator</h1>
        <p className="text-sm text-zinc-500">
          Synthetic messages are injected into the same parser and handler the
          real webhook uses — only the signature check is bypassed, and no Meta
          credentials are involved.
        </p>
      </header>

      {merchants.length === 0 ? (
        <p className="rounded border border-red-300 p-4 text-sm text-red-700">
          No merchants found. Run <code>npm run db:seed</code> first.
        </p>
      ) : (
        <SimulatorClient merchants={merchants} />
      )}
    </main>
  );
}
