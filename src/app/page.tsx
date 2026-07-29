import Link from "next/link";

const button =
  "rounded-full px-5 py-2 text-sm font-medium text-white hover:opacity-90";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 p-8 dark:bg-black">
      <main className="flex w-full max-w-xl flex-col gap-3 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">ChicChat</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          WhatsApp-native structured intake &amp; triage for fashion retailers.
        </p>
        <p className="text-sm text-zinc-500">
          See <code>CLAUDE.md</code> for the build plan.
        </p>
        <div className="mx-auto mt-2 flex flex-wrap justify-center gap-2">
          <Link href="/console" className={`${button} bg-violet-700`}>
            Agent console →
          </Link>
          <Link href="/cases" className={`${button} bg-sky-700`}>
            Cases →
          </Link>
          <Link href="/simulator" className={`${button} bg-emerald-700`}>
            Chat simulator →
          </Link>
          <Link
            href="/config"
            className={`${button} bg-zinc-900 dark:bg-zinc-700`}
          >
            Merchant configuration →
          </Link>
        </div>
      </main>
    </div>
  );
}
