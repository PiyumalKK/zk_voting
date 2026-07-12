"use client";

import React, { useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bars3Icon, BugAntIcon, Cog6ToothIcon } from "@heroicons/react/24/outline";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { useIsVotingOwner, useOutsideClick } from "~~/hooks/scaffold-eth";
import { isCustomChain } from "~~/services/chain/hooks";

type HeaderMenuLink = {
  label: string;
  href: string;
  icon?: React.ReactNode;
};

export const baseMenuLinks: HeaderMenuLink[] = [
  {
    label: "Home",
    href: "/",
  },
  {
    label: "Download App",
    href: "/voting",
  },
  {
    label: "GN Portal",
    href: "/gn",
  },
  {
    label: "Results",
    href: "/results",
  },
  {
    label: "Audit",
    href: "/audit",
  },
  {
    label: "Debug",
    href: "/debug",
    icon: <BugAntIcon className="h-4 w-4" />,
  },
];

const adminLink: HeaderMenuLink = {
  label: "Admin",
  href: "/voting/admin",
  icon: <Cog6ToothIcon className="h-4 w-4" />,
};

export const HeaderMenuLinks = () => {
  const pathname = usePathname();
  const isOwner = useIsVotingOwner();
  // Custom chain: no wallets, so "Debug Contracts" (an EVM/RPC tool) is
  // replaced by the REST chain explorer. The Admin link is always shown —
  // the page itself is password-gated (there is no wallet-owner signal to
  // hide it behind).
  const menu = isCustomChain
    ? [
        ...baseMenuLinks.filter(l => l.href !== "/debug"),
        { label: "Chain Explorer", href: "/chain-explorer", icon: <BugAntIcon className="h-4 w-4" /> },
      ]
    : baseMenuLinks;
  const showAdmin = isCustomChain ? true : isOwner;
  const links = showAdmin ? [...menu, adminLink] : menu;

  return (
    <>
      {links.map(({ label, href, icon }) => {
        const isActive = pathname === href;
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
        {/* Wallets only exist on the EVM backend; the custom chain is wallet-free. */}
        {!isCustomChain && <RainbowKitCustomConnectButton />}
      </div>
    </div>
  );
};
