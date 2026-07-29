import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  gateDecision,
  isOpenPath,
  MIN_PASSCODE_LENGTH,
  safeNextPath,
} from "./gate";

const PASSCODE = "a-long-enough-passcode";

function decide(overrides: Partial<Parameters<typeof gateDecision>[0]> = {}) {
  return gateDecision({
    pathname: "/cases",
    cookie: undefined,
    passcode: PASSCODE,
    isProduction: true,
    ...overrides,
  });
}

describe("open paths", () => {
  it("never gates the WhatsApp webhook — Meta cannot log in", () => {
    expect(isOpenPath("/api/whatsapp/webhook")).toBe(true);
    expect(decide({ pathname: "/api/whatsapp/webhook" })).toEqual({
      kind: "allow",
    });
  });

  it("never gates the maintenance job, which carries its own secret", () => {
    expect(decide({ pathname: "/api/maintenance/sessions" })).toEqual({
      kind: "allow",
    });
  });

  it("leaves the login page reachable, or nobody could get in", () => {
    expect(decide({ pathname: "/login" })).toEqual({ kind: "allow" });
  });

  it("leaves the health check reachable for uptime monitors", () => {
    expect(decide({ pathname: "/api/health" })).toEqual({ kind: "allow" });
  });

  it("gates the console, the config editor and the simulator API", () => {
    for (const path of [
      "/",
      "/cases",
      "/cases/abc",
      "/console",
      "/config",
      "/simulator",
      "/api/simulator",
    ]) {
      expect(isOpenPath(path)).toBe(false);
      expect(decide({ pathname: path }).kind).toBe("login");
    }
  });
});

describe("gateDecision", () => {
  it("allows a request carrying the right passcode", () => {
    expect(decide({ cookie: PASSCODE })).toEqual({ kind: "allow" });
  });

  it("sends a wrong or missing cookie to the login page, remembering the path", () => {
    expect(decide({ pathname: "/console/xyz", cookie: "nope" })).toEqual({
      kind: "login",
      next: "/console/xyz",
    });
  });

  it("refuses to serve anything in production without a passcode", () => {
    const decision = decide({ passcode: undefined });
    expect(decision.kind).toBe("unavailable");
    if (decision.kind === "unavailable") {
      expect(decision.reason).toContain("CONSOLE_PASSCODE");
    }
    // Fails closed for blank and whitespace-only values too.
    expect(decide({ passcode: "   " }).kind).toBe("unavailable");
  });

  it("does not get in the way of local development", () => {
    expect(decide({ passcode: undefined, isProduction: false })).toEqual({
      kind: "allow",
    });
  });

  it("rejects a passcode too short to be worth having", () => {
    const decision = decide({ passcode: "short", cookie: "short" });
    expect(decision.kind).toBe("unavailable");
    if (decision.kind === "unavailable") {
      expect(decision.reason).toContain(String(MIN_PASSCODE_LENGTH));
    }
  });
});

describe("constantTimeEqual", () => {
  it("matches identical strings and rejects everything else", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("safeNextPath", () => {
  it("keeps same-site paths", () => {
    expect(safeNextPath("/console/abc?x=1")).toBe("/console/abc?x=1");
  });

  it("refuses to bounce the visitor off-site", () => {
    expect(safeNextPath("https://evil.example/x")).toBe("/cases");
    expect(safeNextPath("//evil.example")).toBe("/cases");
    expect(safeNextPath(null)).toBe("/cases");
  });
});
