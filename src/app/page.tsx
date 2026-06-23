export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 p-8 dark:bg-black">
      <main className="flex w-full max-w-xl flex-col gap-3 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">ChicChat</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          WhatsApp-native structured intake &amp; triage for fashion retailers.
        </p>
        <p className="text-sm text-zinc-500">
          Scaffold ready (Step 0). See <code>CLAUDE.md</code> for the build
          plan.
        </p>
      </main>
    </div>
  );
}
