"use client";

import React, { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Footer } from "~~/components/Footer";
import { SIDEBAR_COLLAPSED_WIDTH_CLASS, SIDEBAR_WIDTH_CLASS, Sidebar } from "~~/components/dashboard/Sidebar";
import { Topbar } from "~~/components/dashboard/Topbar";

/**
 * The application shell every route renders inside.
 *
 * Three regions, and the split matters: the sidebar and top bar live *outside*
 * the scroll container, so only the workspace moves. The admin panel is several
 * screens tall, and the old document-level scroll took the navigation and the
 * sign-out button with it.
 *
 * The workspace is `flex-1 overflow-y-auto` rather than `h-screen` because it is
 * the second child of a `h-screen` column — giving it a full viewport height of
 * its own would push it past the bottom of the screen by exactly the height of
 * the top bar.
 */

const COLLAPSE_STORAGE_KEY = "zkv.sidebar.collapsed";

export const DashboardShell = ({ children }: { children: React.ReactNode }) => {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Read after mount, never during render: the server has no localStorage and a
  // collapsed-on-first-paint mismatch would hydrate wrong.
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1");
    } catch {
      // Private mode / blocked storage — the default (expanded) is fine.
    }
  }, []);

  const handleToggleCollapsed = useCallback(() => {
    setCollapsed(previous => {
      const next = !previous;
      try {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Persistence is a nicety; the toggle still works for this session.
      }
      return next;
    });
  }, []);

  const closeMobile = useCallback(() => setMobileOpen(false), []);

  // Following a link from the drawer must not leave it hanging open over the
  // page it just navigated to.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-base-200">
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={handleToggleCollapsed}
        mobileOpen={mobileOpen}
        onCloseMobile={closeMobile}
      />

      {mobileOpen && (
        <div
          aria-hidden
          onClick={closeMobile}
          // Not `bg-neutral`: daisyUI inverts that token in dark mode, which
          // would scrim the page with a *light* wash there.
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
        />
      )}

      {/* The rail is `fixed`, so it takes no flow width; this reserves it. */}
      <div
        aria-hidden
        className={`hidden shrink-0 transition-[width] duration-300 ease-in-out lg:block ${
          collapsed ? SIDEBAR_COLLAPSED_WIDTH_CLASS : SIDEBAR_WIDTH_CLASS
        }`}
      />

      <div className="flex h-screen min-w-0 flex-1 flex-col">
        <Topbar onOpenMobileSidebar={() => setMobileOpen(true)} />

        <main className="dash-scroll flex-1 overflow-y-auto overflow-x-hidden">
          {/* `min-h-full` + a growing child keeps every page's existing `grow`
              and `h-full` utilities behaving as they did under the old layout. */}
          <div className="flex min-h-full flex-col">
            <div className="relative flex flex-1 flex-col">{children}</div>
            <Footer />
          </div>
        </main>
      </div>
    </div>
  );
};
