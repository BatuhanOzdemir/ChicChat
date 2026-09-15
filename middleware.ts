/**
 * The deployed instance's front door (Step 7).
 *
 * A thin adapter: every rule lives in the pure `lib/auth/gate`, and this only
 * translates a decision into a response. The WhatsApp webhook and the
 * maintenance job are deliberately not gated here — each authenticates itself
 * (signature and bearer secret respectively), and gating them would break
 * inbound conversations.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  gateDecision,
  PASSCODE_COOKIE,
  safeNextPath,
  isOpenPath,
} from "@/lib/auth/gate";

import { getDatabase } from "@/db/client";
import { sessionPrincipal } from "@/db/auth";

export async function middleware(req: NextRequest): Promise<NextResponse> {
  if (isOpenPath(req.nextUrl.pathname)) return NextResponse.next();
  let authenticated = false;
  try {
    authenticated = !!(await sessionPrincipal(
      getDatabase(),
      req.cookies.get(PASSCODE_COOKIE)?.value,
    ));
  } catch {
    return new NextResponse("Authentication temporarily unavailable", {
      status: 503,
    });
  }
  const decision = gateDecision({
    pathname: req.nextUrl.pathname,
    authenticated,
    allowDevelopmentAccess: process.env.CONSOLE_AUTH_REQUIRED !== "true",
    isProduction: process.env.NODE_ENV === "production",
  });

  if (decision.kind === "allow") return NextResponse.next();

  if (decision.kind === "unavailable") {
    // A misconfigured deployment says so plainly rather than leaking data.
    return new NextResponse(`ChicChat is not configured: ${decision.reason}`, {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const login = new URL("/login", req.url);
  login.searchParams.set("next", safeNextPath(decision.next));
  return NextResponse.redirect(login);
}

export const config = {
  runtime: "nodejs",
  // Everything except Next's own assets; the pure gate decides the rest, so the
  // open-path list has exactly one home.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
