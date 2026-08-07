"use client";

import Image from "next/image";
import Link from "next/link";
import type { NextPage } from "next";
import {
  ChartBarIcon,
  Cog6ToothIcon,
  DevicePhoneMobileIcon,
  MagnifyingGlassIcon,
  UserGroupIcon,
} from "@heroicons/react/24/outline";

/**
 * Portal home.
 *
 * An index of operator entry points, not a landing page: the marketing hero,
 * feature grid, team roster and tech-stack badges were removed because everyone
 * who reaches this screen is an election official or an observer with a job to
 * do, and every one of those blocks was pushing the actual portals below the
 * fold.
 */

const PORTALS = [
  {
    href: "/voting/admin",
    label: "Election Authority",
    detail: "Configure divisions, ballots and phases",
    icon: Cog6ToothIcon,
  },
  {
    href: "/gn",
    label: "GN Officer",
    detail: "Enrol voters in your division",
    icon: UserGroupIcon,
  },
  {
    href: "/results",
    label: "Results",
    detail: "National and per-division tally",
    icon: ChartBarIcon,
  },
  {
    href: "/audit",
    label: "Audit",
    detail: "Independently verify proofs and tally",
    icon: MagnifyingGlassIcon,
  },
];

const Home: NextPage = () => {
  return (
    <div className="grow w-full p-6 lg:p-8">
      <div className="w-full max-w-5xl mx-auto space-y-6">
        {/* System identity */}
        <div className="dash-card p-6 lg:p-8">
          <div className="flex flex-wrap items-center gap-5">
            <div className="flex items-center gap-3 shrink-0">
              <Image src="/uni_logo.png" width={48} height={48} alt="University of Ruhuna" />
              <Image src="/engineering_logo.png" width={48} height={48} alt="Faculty of Engineering" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold leading-tight">Privacy-Preserving E-Voting System</h1>
              <p className="text-sm opacity-70 mt-1">
                End-to-end verifiable, blockchain-based electronic voting with anonymous credential management.
              </p>
              <p className="text-xs opacity-50 mt-2">
                Department of Electrical and Information Engineering &bull; Faculty of Engineering &bull; University of
                Ruhuna
              </p>
            </div>
          </div>
        </div>

        {/* Operator entry points */}
        <div>
          <h2 className="text-xs font-bold uppercase tracking-widest text-base-content/50 mb-3">Portals</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {PORTALS.map(({ href, label, detail, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className="dash-card flex items-start gap-4 p-5 transition-colors hover:border-primary/40"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-bold">{label}</span>
                  <span className="block text-xs opacity-60 mt-0.5">{detail}</span>
                </span>
              </Link>
            ))}
          </div>
        </div>

        {/* Voter channel — stated as a fact of the system, not a pitch */}
        <div className="dash-card p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-base-200 text-base-content/70">
                <DevicePhoneMobileIcon className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-bold">Voter access</h2>
                <p className="text-xs opacity-60 mt-1 max-w-xl">
                  Ballots are cast only from the SL Vote mobile app, which holds the voter&apos;s key in the
                  phone&apos;s hardware security module. Voters enrol in person at their GN office.
                </p>
              </div>
            </div>
            <Link href="/voting" className="btn btn-outline btn-sm">
              App details
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Home;
