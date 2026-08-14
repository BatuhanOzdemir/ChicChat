import { describe, expect, it } from "vitest";
import { activeSection, NAV_SECTIONS, visibleSections } from "./nav";

describe("activeSection", () => {
  it("lights the tab for its own page", () => {
    expect(activeSection("/console")).toBe("/console");
    expect(activeSection("/cases")).toBe("/cases");
    expect(activeSection("/config")).toBe("/config");
    expect(activeSection("/simulator")).toBe("/simulator");
  });

  it("keeps the section lit on its detail pages", () => {
    expect(activeSection("/console/8f3c2a10-0000-4000-8000-000000000000")).toBe(
      "/console",
    );
    expect(activeSection("/cases/8f3c2a10-0000-4000-8000-000000000000")).toBe(
      "/cases",
    );
  });

  it("does not match a path that merely starts with a section name", () => {
    expect(activeSection("/consoles")).toBeNull();
    expect(activeSection("/configuration")).toBeNull();
  });

  it("has no active section outside the application", () => {
    expect(activeSection("/")).toBeNull();
    expect(activeSection("/login")).toBeNull();
  });
});

describe("visibleSections", () => {
  it("hides the simulator when it is not enabled", () => {
    const hrefs = visibleSections(false).map((s) => s.href);
    expect(hrefs).not.toContain("/simulator");
    // Everything else still reachable, so the bar never strands an operator.
    expect(hrefs).toEqual(["/console", "/cases", "/config"]);
  });

  it("shows the simulator when it is enabled", () => {
    expect(visibleSections(true).map((s) => s.href)).toContain("/simulator");
  });
});

describe("NAV_SECTIONS", () => {
  it("describes every section it links to", () => {
    for (const section of NAV_SECTIONS) {
      expect(section.href.startsWith("/")).toBe(true);
      expect(section.label).not.toBe("");
      expect(section.hint).not.toBe("");
    }
  });
});
