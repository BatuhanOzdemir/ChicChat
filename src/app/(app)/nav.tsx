"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeSection, visibleSections } from "@/lib/nav";

/**
 * The operator application's top bar. A client component only because
 * highlighting the current tab needs the live pathname; the decision itself is
 * pure and lives in `@/lib/nav`.
 */
export function AppNav({ simulatorEnabled }: { simulatorEnabled: boolean }) {
  const pathname = usePathname();
  const active = activeSection(pathname);
  const sections = visibleSections(simulatorEnabled);

  return (
    <nav
      aria-label="Sections"
      className="sticky top-0 z-20 border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-1 gap-y-2 px-6 py-2">
        <Link
          href="/"
          className="mr-3 text-sm font-semibold tracking-tight text-zinc-900 hover:opacity-70 dark:text-zinc-100"
        >
          ChicChat
        </Link>

        {sections.map((section) => {
          const current = section.href === active;
          return (
            <Link
              key={section.href}
              href={section.href}
              title={section.hint}
              // Screen readers get the same "you are here" the colour conveys.
              aria-current={current ? "page" : undefined}
              className={
                current
                  ? "rounded-full bg-zinc-900 px-3 py-1 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "rounded-full px-3 py-1 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }
            >
              {section.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
