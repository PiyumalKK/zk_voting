"use client";

import React from "react";
import {
  // ArrowDownTrayIcon, // restore with the "Download App" link below
  // BugAntIcon, // restore with the "Debug" link below
  ChartBarIcon,
  Cog6ToothIcon,
  HomeIcon,
  MagnifyingGlassIcon,
  UserGroupIcon,
} from "@heroicons/react/24/outline";
import { useIsVotingOwner } from "~~/hooks/scaffold-eth";
import { useElectionAuth } from "~~/hooks/useElectionAuth";
import { isCustomMode } from "~~/utils/chainMode";

/**
 * The single source of truth for the app shell's navigation.
 *
 * Lives outside `Sidebar`/`Header` so that the sidebar, the legacy top nav and
 * the breadcrumb bar cannot drift apart: a route added here shows up in all
 * three at once. The admin-gating rule is unchanged from the old header — it is
 * simply expressed once, as a hook, instead of being inlined in the only
 * component that happened to need it.
 */

export type HeaderMenuLink = {
  label: string;
  href: string;
  icon?: React.ReactNode;
  /** Shown under the label in the expanded sidebar. */
  description?: string;
};

const ICON_CLASS = "h-5 w-5";

export const baseMenuLinks: HeaderMenuLink[] = [
  {
    label: "Home",
    href: "/",
    icon: <HomeIcon className={ICON_CLASS} />,
    description: "Project overview",
  },
  // Hidden from the sidebar for now. The `/voting` route itself still works and
  // keeps its entry in ROUTE_LABELS below, so anyone who follows a direct link
  // still gets a titled page and a correct breadcrumb.
  // {
  //   label: "Download App",
  //   href: "/voting",
  //   icon: <ArrowDownTrayIcon className={ICON_CLASS} />,
  //   description: "SL Vote mobile app",
  // },
  {
    label: "GN Portal",
    href: "/gn",
    icon: <UserGroupIcon className={ICON_CLASS} />,
    description: "Enrol voters",
  },
  {
    label: "Results",
    href: "/results",
    icon: <ChartBarIcon className={ICON_CLASS} />,
    description: "Live on-chain tally",
  },
  {
    label: "Audit",
    href: "/audit",
    icon: <MagnifyingGlassIcon className={ICON_CLASS} />,
    description: "Verify every ballot",
  },
  // Hidden from the sidebar for now, on the same terms as "Download App" above:
  // the route still works and keeps its ROUTE_LABELS entry.
  // {
  //   label: "Debug",
  //   href: "/debug",
  //   icon: <BugAntIcon className={ICON_CLASS} />,
  //   description: "Contract playground",
  // },
];

export const adminLink: HeaderMenuLink = {
  label: "Admin",
  href: "/voting/admin",
  icon: <Cog6ToothIcon className={ICON_CLASS} />,
  description: "Election authority controls",
};

/**
 * The visible route list for the signed-in viewer.
 *
 * Both backends are plain EVM chains reached over JSON-RPC, so the menu is
 * identical in either mode: /debug and /blockexplorer work against our node
 * just as they do against Hardhat. Only the Admin link differs, because
 * "is this person the admin?" is a wallet question on Hardhat and a session
 * question on the custom chain — `useIsVotingOwner` can never be true there,
 * so without the second check the link would simply never appear.
 */
export const useDashboardNavLinks = (): HeaderMenuLink[] => {
  const isOwner = useIsVotingOwner();
  const { isAdmin } = useElectionAuth();

  const showAdminLink = isCustomMode() ? isAdmin : isOwner;
  return showAdminLink ? [...baseMenuLinks, adminLink] : baseMenuLinks;
};

/**
 * Which nav entry owns the current URL.
 *
 * A plain `startsWith` would light up "Download App" while the operator is on
 * `/voting/admin`, so the longest matching prefix wins and `/` only ever
 * matches itself.
 */
export const activeHrefFor = (pathname: string, hrefs: string[]): string | undefined =>
  hrefs
    .filter(href => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`)))
    .sort((a, b) => b.length - a.length)[0];

export type Crumb = { label: string; href?: string };

/**
 * Human titles for the top bar. Includes routes that are deliberately absent
 * from the sidebar (login, prover, block explorer detail pages) — those still
 * need a title once an operator lands on them.
 */
const ROUTE_LABELS: Record<string, string> = {
  "/": "Home",
  "/voting": "Download App",
  "/voting/admin": "Election Admin",
  "/gn": "GN Portal",
  "/gn/register": "Register Voter",
  "/results": "Results",
  "/audit": "Election Audit",
  "/debug": "Debug Contracts",
  "/blockexplorer": "Block Explorer",
  "/login": "Election Sign-in",
  "/prover": "Prover",
};

/** Addresses and tx hashes are the only unmapped segments we expect; keep them readable. */
const prettifySegment = (segment: string): string => {
  const decoded = (() => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  })();

  if (decoded.startsWith("0x") && decoded.length > 14) {
    return `${decoded.slice(0, 8)}…${decoded.slice(-6)}`;
  }
  return decoded.replace(/[-_]/g, " ").replace(/\b\w/g, character => character.toUpperCase());
};

/** Title + breadcrumb trail for the top application bar. */
export const describeRoute = (pathname: string): { title: string; crumbs: Crumb[] } => {
  const clean = pathname.split("?")[0].replace(/\/+$/, "") || "/";

  if (clean === "/") {
    return { title: ROUTE_LABELS["/"], crumbs: [{ label: ROUTE_LABELS["/"] }] };
  }

  const segments = clean.split("/").filter(Boolean);
  const crumbs: Crumb[] = [{ label: ROUTE_LABELS["/"], href: "/" }];

  let accumulated = "";
  segments.forEach((segment, index) => {
    accumulated += `/${segment}`;
    const isLast = index === segments.length - 1;
    crumbs.push({
      label: ROUTE_LABELS[accumulated] ?? prettifySegment(segment),
      // Only link crumbs we know resolve to a real page — `/blockexplorer/address`
      // on its own is a 404.
      href: !isLast && accumulated in ROUTE_LABELS ? accumulated : undefined,
    });
  });

  return { title: crumbs[crumbs.length - 1].label, crumbs };
};
