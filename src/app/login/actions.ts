"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PASSCODE_COOKIE, safeNextPath } from "@/lib/auth/gate";
import { getDatabase } from "@/db/client";
import { login } from "@/db/auth";
import { tokenHash } from "@/server/auth/credentials";

export async function signIn(formData: FormData): Promise<void> {
  const next = safeNextPath(String(formData.get("next") ?? ""));
  const token = await login(
    getDatabase(),
    String(formData.get("username") ?? ""),
    String(formData.get("passcode") ?? ""),
  );
  if (!token) redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  (await cookies()).set(PASSCODE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 43200,
  });
  redirect(next);
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(PASSCODE_COOKIE)?.value;
  if (token)
    await getDatabase().query(
      "delete from console_sessions where token_hash=$1",
      [tokenHash(token)],
    );
  jar.delete(PASSCODE_COOKIE);
  redirect("/login");
}
