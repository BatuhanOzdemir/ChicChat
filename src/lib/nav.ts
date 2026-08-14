/**
 * The operator application's top-level sections (SPEC §§7–9).
 *
 * Every operator surface is reachable from every other one — before this
 * existed each section was a dead end you could only leave with the browser's
 * back button, which is not navigation, it is a workaround.
 *
 * Pure by design (Handbook §2): the "which tab is highlighted" rule is a string
 * question, so it is answerable without a router, a request, or a DOM.
 */

export interface NavSection {
  /** Route the tab links to, and the prefix that marks it active. */
  href: string;
  label: string;
  /** Short "what is this for", shown as the link title. */
  hint: string;
  /**
   * The simulator is a development/demo surface and is absent in a production
   * deployment unless explicitly enabled, so its tab must be able to disappear.
   */
  simulatorOnly?: boolean;
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    href: "/console",
    label: "Console",
    hint: "Work queue: cases waiting for an agent",
  },
  {
    href: "/cases",
    label: "Cases",
    hint: "Every case, with filters and counters",
  },
  {
    href: "/config",
    label: "Configuration",
    hint: "Categories, fields, policies and routing rules",
  },
  {
    href: "/simulator",
    label: "Simulator",
    hint: "Drive a WhatsApp conversation by hand",
    simulatorOnly: true,
  },
];

/** The tabs to render. */
export function visibleSections(simulatorEnabled: boolean): NavSection[] {
  return NAV_SECTIONS.filter((s) => !s.simulatorOnly || simulatorEnabled);
}

/**
 * Which section owns this path, or null on a page outside the sections (the
 * landing page, `/login`). A detail page belongs to its section, so
 * `/console/<id>` keeps the Console tab lit.
 */
export function activeSection(pathname: string): string | null {
  const matches = NAV_SECTIONS.map((s) => s.href)
    // `startsWith(href)` alone would light Console on a hypothetical
    // `/consoles`; the trailing slash keeps the match on a path boundary.
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    // Longest first, so a nested section would win over its parent.
    .sort((a, b) => b.length - a.length);
  return matches[0] ?? null;
}
