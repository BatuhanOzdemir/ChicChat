import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PASSCODE_COOKIE } from "@/lib/auth/gate";
import { sessionPrincipal, type Principal } from "@/db/auth";
import type { Queryable } from "@/db/database";

export function developmentAccess(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.CONSOLE_AUTH_REQUIRED !== "true"
  );
}

export async function currentPrincipal(
  db: Queryable,
): Promise<Principal | null> {
  return sessionPrincipal(db, (await cookies()).get(PASSCODE_COOKIE)?.value);
}

export async function requirePrincipal(
  db: Queryable,
): Promise<Principal | null> {
  const principal = await currentPrincipal(db);
  if (!principal && !developmentAccess()) redirect("/login");
  return principal;
}
