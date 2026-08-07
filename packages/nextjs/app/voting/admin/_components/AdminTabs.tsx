"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Sub-navigation for the admin area.
 *
 * Real routes rather than local tab state, for three reasons: the middleware
 * matcher is already `/voting/admin/:path*`, so each one is gated without any
 * new configuration; the shell's breadcrumb renders them for free
 * ("Home / Election Admin / Ballot"); and an operator can bookmark or link the
 * exact screen they mean.
 */

const TABS = [
  { href: "/voting/admin", label: "Operations", hint: "Phases and live status" },
  { href: "/voting/admin/ballot", label: "Ballot", hint: "Question, candidates, roll" },
  { href: "/voting/admin/divisions", label: "Divisions", hint: "Officers and registry" },
];

export const AdminTabs = () => {
  const pathname = usePathname() ?? "/voting/admin";

  return (
    <nav aria-label="Admin sections" className="dash-card p-2">
      <ul className="flex flex-wrap gap-1">
        {TABS.map(({ href, label, hint }) => {
          // Exact match only: every tab is a prefix of nothing else here, and
          // "Operations" is the bare `/voting/admin` root.
          const isActive = pathname === href;
          return (
            <li key={href} className="flex-1 min-w-[8rem]">
              <Link
                href={href}
                aria-current={isActive ? "page" : undefined}
                className={`block rounded-xl px-4 py-2.5 text-center transition-colors ${
                  isActive ? "bg-primary/10 text-primary" : "text-base-content/70 hover:bg-base-200"
                }`}
              >
                <span className="block text-sm font-semibold">{label}</span>
                <span className="block text-[10px] opacity-50">{hint}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
};
