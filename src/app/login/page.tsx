import { safeNextPath } from "@/lib/auth/gate";
import { signIn } from "./actions";

/**
 * The console's only unauthenticated page (Step 7). A shared passcode, not a
 * user account — see `lib/auth/gate` for why that is the v0.2 scope.
 */
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const pick = (name: string): string => {
    const raw = params[name];
    return String((Array.isArray(raw) ? raw[0] : raw) ?? "");
  };
  const next = safeNextPath(pick("next"));
  const failed = pick("error") !== "";

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-6 text-zinc-900 dark:text-zinc-100">
      <h1 className="text-2xl font-semibold">ChicChat</h1>
      <p className="mt-1 text-sm text-zinc-500">
        This console shows customer conversations, so it asks for the passcode.
      </p>

      {failed && (
        <p className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          That passcode did not match.
        </p>
      )}

      <form action={signIn} className="mt-4 flex flex-col gap-3">
        <input type="hidden" name="next" value={next} />
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Passcode
          <input
            className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            type="password"
            name="passcode"
            autoComplete="current-password"
            autoFocus
            required
          />
        </label>
        <button
          type="submit"
          className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Enter
        </button>
      </form>
    </main>
  );
}
