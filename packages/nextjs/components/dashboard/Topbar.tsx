"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bars3Icon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { ElectionIdentity } from "~~/components/ElectionIdentity";
import { describeRoute } from "~~/components/dashboard/navigation";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { isCustomMode } from "~~/utils/chainMode";

/**
 * The fixed top application bar.
 *
 * Left: where you are. Right: who you are. Nothing else — the routes moved to
 * the sidebar, so this bar stays a constant height across every page and the
 * workspace beneath it can scroll without the identity control leaving view.
 */
export const Topbar = ({ onOpenMobileSidebar }: { onOpenMobileSidebar: () => void }) => {
  const pathname = usePathname() ?? "/";
  const { title, crumbs } = describeRoute(pathname);

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-base-300/60 bg-base-100/80 px-4 backdrop-blur-lg lg:px-8">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onOpenMobileSidebar}
          aria-label="Open navigation"
          className="btn btn-ghost btn-sm btn-circle lg:hidden"
        >
          <Bars3Icon className="h-5 w-5" />
        </button>

        <div className="flex min-w-0 flex-col justify-center">
          <h1 className="truncate text-base font-bold leading-tight">{title}</h1>
          <nav aria-label="Breadcrumb" className="hidden min-w-0 sm:block">
            <ol className="flex min-w-0 items-center gap-1 text-[11px] text-base-content/50">
              {crumbs.map((crumb, index) => (
                <li key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1">
                  {index > 0 && <ChevronRightIcon aria-hidden className="h-3 w-3 shrink-0 opacity-60" />}
                  {crumb.href ? (
                    <Link href={crumb.href} className="truncate transition-colors hover:text-primary">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className="truncate" aria-current={index === crumbs.length - 1 ? "page" : undefined}>
                      {crumb.label}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        </div>
      </div>

      {/* Custom chain: the signing keys live on the server, so there is no
          wallet to connect and the bar shows the credential identity instead.
          Hardhat: unchanged MetaMask flow (MASTER §1). */}
      <div className="flex shrink-0 items-center gap-2">
        {isCustomMode() ? <ElectionIdentity /> : <RainbowKitCustomConnectButton />}
      </div>
    </header>
  );
};
