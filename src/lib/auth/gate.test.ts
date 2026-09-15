import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  gateDecision,
  isOpenPath,
  safeNextPath,
} from "./gate";

function decide(overrides: Partial<Parameters<typeof gateDecision>[0]> = {}) {
  return gateDecision({
    pathname: "/cases",
    authenticated: false,
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
  it("requires a verified session in production", () => {
    expect(decide().kind).toBe("login");
    expect(decide({ authenticated: true }).kind).toBe("allow");
    expect(decide({ allowDevelopmentAccess: true }).kind).toBe("login");
  });
  it("allows explicitly enabled development access only outside production", () => {
    expect(
      decide({ isProduction: false, allowDevelopmentAccess: true }).kind,
    ).toBe("allow");
    expect(
      decide({ isProduction: false, allowDevelopmentAccess: false }).kind,
    ).toBe("login");
  });
  it("does not allow paths merely sharing an open endpoint prefix", () => {
    expect(isOpenPath("/login-secret")).toBe(false);
    expect(isOpenPath("/api/whatsapp/webhook-admin")).toBe(false);
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
