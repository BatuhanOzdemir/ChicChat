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
import { gateDecision, PASSCODE_COOKIE, safeNextPath } from "@/lib/auth/gate";

export function middleware(req: NextRequest): NextResponse {
  const decision = gateDecision({
    pathname: req.nextUrl.pathname,
    cookie: req.cookies.get(PASSCODE_COOKIE)?.value,
    passcode: process.env.CONSOLE_PASSCODE,
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
  // Everything except Next's own assets; the pure gate decides the rest, so the
  // open-path list has exactly one home.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
