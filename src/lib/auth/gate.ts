/**
 * Who may reach the console in a deployed instance (Step 7) — pure, so the
 * rules are unit-testable and the middleware stays a thin adapter.
 *
 * The caller verifies an opaque session token against the database. Production
 * always requires authentication; server pages/actions additionally check tenant
 * membership. The historical cookie name is retained, but shared secrets are invalid.
 */

export const PASSCODE_COOKIE = "chicchat_console";

/** The minimum that is worth calling a secret. */
export const MIN_PASSCODE_LENGTH = 12;

/**
 * Paths that must never be gated:
 *  - the WhatsApp webhook, which Meta calls and which verifies its own
 *    signature (SPEC §10) — gating it would break every conversation;
 *  - the maintenance job, which carries its own bearer secret;
 *  - the login page and its assets, or there would be no way in.
 */
const OPEN_PREFIXES = [
  "/api/whatsapp/webhook",
  "/api/maintenance/sessions",
  // Reachable by uptime monitors; reports no configuration detail (Step 7).
  "/api/health",
  "/login",
  "/_next/",
  "/favicon",
];

export function isOpenPath(pathname: string): boolean {
  return OPEN_PREFIXES.some(
    (prefix) =>
      pathname === prefix ||
      (prefix.endsWith("/") && pathname.startsWith(prefix)),
  );
}

/**
 * Compare without leaking which character differed. Not `===`, because the
 * passcode arrives from a form and a timing signal is free to measure.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export type GateDecision =
  /** Serve the request. */
  | { kind: "allow" }
  /** Send the visitor to the login page, returning to `next` afterwards. */
  | { kind: "login"; next: string }
  /** Refuse outright: misconfigured deployment, nothing to log in with. */
  | { kind: "unavailable"; reason: string };

export interface GateInput {
  pathname: string;
  /** Whether the server verified a live session and enabled account. */
  authenticated: boolean;
  /** Explicit local-development bypass; ignored in production. */
  allowDevelopmentAccess?: boolean;
  /** Production deployments must be gated; local development need not be. */
  isProduction: boolean;
}

export function gateDecision(input: GateInput): GateDecision {
  if (isOpenPath(input.pathname)) return { kind: "allow" };

  if (
    input.authenticated ||
    (!input.isProduction && input.allowDevelopmentAccess)
  )
    return { kind: "allow" };
  return { kind: "login", next: input.pathname };
}

/** Where to send someone after login: same-site paths only. */
export function safeNextPath(raw: string | null | undefined): string {
  const value = raw ?? "";
  return /^\/(?!\/)[\w\-/[\]?=&%.]*$/.test(value) ? value : "/cases";
}
