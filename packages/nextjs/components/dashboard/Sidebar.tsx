"use client";

import React from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { SwitchTheme } from "~~/components/SwitchTheme";
import { activeHrefFor, useDashboardNavLinks } from "~~/components/dashboard/navigation";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { isLocalChainId } from "~~/utils/customChain";

/**
 * The dashboard's primary navigation rail.
 *
 * Fixed to the left screen boundary and independently scrollable, so it stays
 * put while the workspace scrolls — the whole point of the shell for pages like
 * the admin panel, which is far taller than a viewport.
 *
 * Below `lg` it becomes an overlay drawer: `DashboardShell` owns `mobileOpen`
 * and renders the backdrop, because the backdrop has to sit above the workspace
 * but below this rail.
 */

export type SidebarProps = {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
};

export const SIDEBAR_WIDTH_CLASS = "w-64";
export const SIDEBAR_COLLAPSED_WIDTH_CLASS = "w-20";

export const Sidebar = ({ collapsed, onToggleCollapsed, mobileOpen, onCloseMobile }: SidebarProps) => {
  const pathname = usePathname() ?? "/";
  const links = useDashboardNavLinks();
  const { targetNetwork } = useTargetNetwork();

  // The built-in block explorer works against any locally-run node — Hardhat
  // or the custom Go chain.
  const isLocalNetwork = isLocalChainId(targetNetwork.id);

  const activeHref = activeHrefFor(
    pathname,
    links.map(link => link.href),
  );

  return (
    <aside
      aria-label="Main navigation"
      className={`fixed inset-y-0 left-0 z-50 flex h-screen flex-col border-r border-base-300/60 bg-base-100 transition-[width,transform] duration-300 ease-in-out ${
        collapsed ? SIDEBAR_COLLAPSED_WIDTH_CLASS : SIDEBAR_WIDTH_CLASS
      } ${mobileOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"} lg:translate-x-0 lg:shadow-none`}
    >
      {/* Brand */}
      <div
        className={`flex h-16 shrink-0 items-center gap-3 border-b border-base-300/60 px-4 ${
          collapsed ? "lg:justify-center lg:px-0" : ""
        }`}
      >
        <Link href="/" className="flex min-w-0 items-center gap-3" onClick={onCloseMobile}>
          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center">
            <Image alt="ZK Voting" src="/zk-logo.svg" fill className="object-contain" />
          </span>
          {!collapsed && (
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm font-bold">ZK Voting</span>
              <span className="truncate text-[10px] uppercase tracking-wider opacity-50">Election Portal</span>
            </span>
          )}
        </Link>

        {/* Drawer dismiss — mobile only, where there is no backdrop-free way out. */}
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation"
          className="btn btn-ghost btn-sm btn-circle ml-auto lg:hidden"
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>

      {/* Routes */}
      <nav className="dash-scroll flex-1 overflow-y-auto px-3 py-4">
        <ul className="flex flex-col gap-1">
          {links.map(({ label, href, icon, description }) => {
            const isActive = href === activeHref;
            return (
              <li key={href}>
                <Link
                  href={href}
                  onClick={onCloseMobile}
                  aria-current={isActive ? "page" : undefined}
                  title={collapsed ? label : undefined}
                  className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 ${
                    isActive
                      ? "bg-primary/10 text-primary shadow-sm"
                      : "text-base-content/70 hover:bg-base-200 hover:text-base-content"
                  } ${collapsed ? "justify-center px-0" : ""}`}
                >
                  {/* Active marker rides the rail edge so it reads the same collapsed or not. */}
                  <span
                    aria-hidden
                    className={`absolute -left-3 h-7 w-1 rounded-r-full bg-primary transition-opacity duration-200 ${
                      isActive ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  <span className="shrink-0">{icon}</span>
                  {!collapsed && (
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{label}</span>
                      {description && (
                        <span className="truncate text-[10px] font-normal opacity-50">{description}</span>
                      )}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Utilities */}
      <div className="shrink-0 border-t border-base-300/60 p-3">
        <div className={`flex flex-col gap-2 ${collapsed ? "items-center" : ""}`}>
          {isLocalNetwork && (
            <Link
              href="/blockexplorer"
              onClick={onCloseMobile}
              title={collapsed ? "Block Explorer" : undefined}
              className={`btn btn-primary btn-sm gap-2 font-normal ${collapsed ? "btn-circle px-0" : "w-full"}`}
            >
              <MagnifyingGlassIcon className="h-4 w-4" />
              {!collapsed && <span>Block Explorer</span>}
            </Link>
          )}

          <div
            className={`flex items-center rounded-xl bg-base-200/60 px-2 py-1.5 ${
              collapsed ? "justify-center" : "w-full justify-between"
            }`}
          >
            {!collapsed && <span className="pl-1 text-xs opacity-60">Theme</span>}
            <SwitchTheme />
          </div>

          {/* Collapse is a desktop affordance: on mobile the rail is a drawer already. */}
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            className={`btn btn-ghost btn-sm hidden lg:flex ${collapsed ? "btn-circle px-0" : "w-full justify-start gap-2"}`}
          >
            {collapsed ? (
              <ChevronDoubleRightIcon className="h-4 w-4" />
            ) : (
              <>
                <ChevronDoubleLeftIcon className="h-4 w-4" />
                <span className="text-xs font-normal opacity-70">Collapse</span>
              </>
            )}
          </button>
        </div>
      </div>
    </aside>
  );
};
