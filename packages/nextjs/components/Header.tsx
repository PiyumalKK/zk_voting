"use client";

import React, { useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bars3Icon } from "@heroicons/react/24/outline";
import { ElectionIdentity } from "~~/components/ElectionIdentity";
import { activeHrefFor, useDashboardNavLinks } from "~~/components/dashboard/navigation";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { useOutsideClick } from "~~/hooks/scaffold-eth";
import { isCustomMode } from "~~/utils/chainMode";

/**
 * The pre-dashboard horizontal navbar.
 *
 * `DashboardShell` no longer mounts it — routes live in `Sidebar` and the
 * identity control in `Topbar` — but it is kept intact, and kept sourcing its
 * routes from the shared nav config, so it cannot drift out of sync and so the
 * existing header tests continue to describe real behaviour.
 */

export type { HeaderMenuLink } from "~~/components/dashboard/navigation";
export { baseMenuLinks, adminLink } from "~~/components/dashboard/navigation";

export const HeaderMenuLinks = () => {
  const pathname = usePathname();
  const links = useDashboardNavLinks();
  const activeHref = activeHrefFor(
    pathname ?? "/",
    links.map(link => link.href),
  );

  return (
    <>
      {links.map(({ label, href, icon }) => {
        const isActive = href === activeHref;
        return (
          <li key={href}>
            <Link
              href={href}
              passHref
              className={`${
                isActive ? "bg-primary/10 text-primary font-semibold" : ""
              } hover:bg-primary/10 hover:text-primary focus:!bg-primary/10 active:!text-primary py-1.5 px-3 text-sm rounded-full gap-2 grid grid-flow-col transition-all duration-200`}
            >
              {icon}
              <span>{label}</span>
            </Link>
          </li>
        );
      })}
    </>
  );
};

/**
 * Site header
 */
export const Header = () => {
  const burgerMenuRef = useRef<HTMLDetailsElement>(null);
  useOutsideClick(burgerMenuRef, () => {
    burgerMenuRef?.current?.removeAttribute("open");
  });

  return (
    <div className="sticky lg:static top-0 navbar bg-base-100/80 backdrop-blur-lg min-h-0 shrink-0 justify-between z-20 border-b border-base-300/50 px-0 sm:px-2">
      <div className="navbar-start w-auto lg:w-1/2">
        <details className="dropdown" ref={burgerMenuRef}>
          <summary className="ml-1 btn btn-ghost lg:hidden hover:bg-transparent">
            <Bars3Icon className="h-1/2" />
          </summary>
          <ul
            className="menu menu-compact dropdown-content mt-3 p-2 shadow-lg bg-base-100 rounded-box w-52 border border-base-300/50"
            onClick={() => {
              burgerMenuRef?.current?.removeAttribute("open");
            }}
          >
            <HeaderMenuLinks />
          </ul>
        </details>
        <Link href="/" passHref className="hidden lg:flex items-center gap-2 ml-4 mr-6 shrink-0">
          <div className="flex relative w-9 h-9">
            <Image alt="ZK Voting" className="cursor-pointer" fill src="/zk-logo.svg" />
          </div>
          <div className="flex flex-col">
            <span className="font-bold leading-tight text-sm gradient-text">ZK Voting</span>
            <span className="text-[10px] opacity-60">FYP &bull; University of Ruhuna</span>
          </div>
        </Link>
        <ul className="hidden lg:flex lg:flex-nowrap menu menu-horizontal px-1 gap-2">
          <HeaderMenuLinks />
        </ul>
      </div>
      <div className="navbar-end grow mr-4">
        {/* Custom chain: the signing keys live on the server, so there is no
            wallet to connect and the header shows the credential identity
            instead. Hardhat: unchanged MetaMask flow (MASTER §1). */}
        {isCustomMode() ? <ElectionIdentity /> : <RainbowKitCustomConnectButton />}
      </div>
    </div>
  );
};
