"use client";

import Link from "next/link";
import { NextPage } from "next";

/**
 * /voting — now a "Download the App" page.
 *
 * Voting has been migrated to the mobile app exclusively. This page directs
 * voters to download the SL Vote app while still showing live election stats
 * for transparency.
 */

const VotingPage: NextPage = () => {
  return (
    <div className="flex items-center justify-center flex-col grow pt-6 w-full">
      <div className="px-4 sm:px-5 w-full max-w-3xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8 relative">
          <div className="absolute inset-0 bg-gradient-to-r from-primary/10 via-secondary/10 to-primary/10 blur-3xl -z-10 rounded-full w-3/4 h-full mx-auto" />
          <div className="text-5xl mb-4">📱</div>
          <h1 className="text-3xl md:text-4xl font-extrabold bg-gradient-to-br from-primary to-secondary text-transparent bg-clip-text drop-shadow-sm">
            Vote from the App
          </h1>
          <p className="text-base opacity-70 mt-3 font-medium max-w-lg mx-auto">
            For security and privacy, voting happens exclusively on the{" "}
            <strong className="text-primary">SL Vote</strong> mobile app — protected by your phone&apos;s biometric
            hardware.
          </p>
        </div>

        {/* Download Card */}
        <div className="bg-gradient-to-br from-primary/10 to-secondary/10 rounded-3xl p-8 border border-primary/20 mb-6 text-center">
          <h2 className="text-xl font-bold mb-3">Download SL Vote</h2>
          <p className="text-sm opacity-60 mb-6 max-w-md mx-auto">
            Create your voting identity, register at your GN office, and cast your anonymous ballot — all from your
            phone.
          </p>
          <div className="flex flex-wrap gap-3 justify-center mb-4">
            <span className="btn btn-neutral btn-md gap-2 pointer-events-none opacity-90">▶ Google Play</span>
            <span className="btn btn-neutral btn-md gap-2 pointer-events-none opacity-90">App Store</span>
          </div>
          <span className="badge badge-warning badge-sm">Coming soon</span>
        </div>

        {/* How it works */}
        <div className="bg-base-100 rounded-2xl p-6 shadow-md border border-base-300/50 mb-6">
          <h3 className="font-bold mb-4 text-center">How voting works</h3>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 text-center">
            <div>
              <div className="text-2xl mb-2">🔑</div>
              <div className="font-semibold text-sm">1. Setup</div>
              <p className="text-xs opacity-60 mt-1">Create your identity on your phone</p>
            </div>
            <div>
              <div className="text-2xl mb-2">🏛️</div>
              <div className="font-semibold text-sm">2. Register</div>
              <p className="text-xs opacity-60 mt-1">Show QR to your GN officer</p>
            </div>
            <div>
              <div className="text-2xl mb-2">🗳️</div>
              <div className="font-semibold text-sm">3. Vote</div>
              <p className="text-xs opacity-60 mt-1">Cast anonymously with ZK proof</p>
            </div>
            <div>
              <div className="text-2xl mb-2">✅</div>
              <div className="font-semibold text-sm">4. Verify</div>
              <p className="text-xs opacity-60 mt-1">Confirm your vote was counted</p>
            </div>
          </div>
        </div>

        {/* Officials link */}
        <div className="mt-6 text-center">
          <p className="text-xs opacity-50 mb-3">Election officials?</p>
          <div className="flex flex-wrap gap-3 justify-center">
            <Link href="/voting/admin" className="btn btn-outline btn-sm">
              🏛️ Admin Panel
            </Link>
            <Link href="/gn" className="btn btn-outline btn-sm">
              👨‍💼 GN Portal
            </Link>
            <Link href="/results" className="btn btn-outline btn-sm">
              📊 Results
            </Link>
          </div>
        </div>

        <div className="h-12" />
      </div>
    </div>
  );
};

export default VotingPage;
