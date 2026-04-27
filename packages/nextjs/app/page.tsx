"use client";

import Image from "next/image";
import Link from "next/link";
import type { NextPage } from "next";
import { ShieldCheckIcon, LockClosedIcon, FingerPrintIcon, CheckBadgeIcon } from "@heroicons/react/24/outline";

const Home: NextPage = () => {
  return (
    <>
      {/* Hero Section */}
      <div className="relative min-h-[90vh] flex items-center justify-center overflow-hidden">
        {/* Animated background */}
        <div className="absolute inset-0 animated-gradient opacity-10"></div>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(99,102,241,0.1),transparent_50%)]"></div>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_80%,rgba(6,182,212,0.08),transparent_50%)]"></div>

        <div className="relative z-10 flex flex-col items-center text-center px-6 max-w-5xl mx-auto">
          {/* University & Faculty Logos */}
          <div className="mb-8 mt-5 relative flex items-center gap-6">
            <div className="absolute inset-0 bg-primary/20 rounded-full blur-3xl scale-150"></div>
            <Image
              src="/uni_logo.png"
              width={100}
              height={100}
              alt="University of Ruhuna"
              className="relative shadow-2xl"
            />
            <Image
              src="/engineering_logo.png"
              width={100}
              height={100}
              alt="Faculty of Engineering"
              className="relative shadow-2xl"
            />
          </div>

          {/* Project Title */}
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-extrabold leading-tight mb-4">
            <span className="gradient-text">Privacy-Preserving</span>
            <br />
            <span className="text-base-content">E-Voting System</span>
          </h1>

          <p className="text-lg md:text-xl text-base-content/70 max-w-2xl mb-3">
            End-to-End Verifiable Blockchain-Based Electronic Voting with
            <span className="font-semibold text-primary"> Anonymous Credential Management</span>
          </p>

          <p className="text-sm text-base-content/50 mb-8">
            Department of Electrical and Information Engineering &bull; Faculty of Engineering &bull; University of Ruhuna
          </p>

          {/* CTA Buttons */}
          <div className="flex flex-wrap gap-4 justify-center mb-12">
            <Link href="/voting" className="btn btn-primary btn-lg gap-2 shadow-lg shadow-primary/25">
              <ShieldCheckIcon className="h-5 w-5" />
              Launch Voting App
            </Link>
            <Link href="/debug" className="btn btn-outline btn-lg gap-2">
              Explore Contracts
            </Link>
          </div>

          {/* Feature Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 w-full max-w-4xl">
            <div className="hover-lift bg-base-100 rounded-2xl p-5 shadow-md border border-base-300/50">
              <LockClosedIcon className="h-8 w-8 text-primary mb-3" />
              <h3 className="font-bold text-sm">Zero-Knowledge Proofs</h3>
              <p className="text-xs opacity-60 mt-1">Prove eligibility without revealing identity</p>
            </div>
            <div className="hover-lift bg-base-100 rounded-2xl p-5 shadow-md border border-base-300/50">
              <FingerPrintIcon className="h-8 w-8 text-secondary mb-3" />
              <h3 className="font-bold text-sm">Anonymous Voting</h3>
              <p className="text-xs opacity-60 mt-1">Votes unlinkable to voter identities</p>
            </div>
            <div className="hover-lift bg-base-100 rounded-2xl p-5 shadow-md border border-base-300/50">
              <CheckBadgeIcon className="h-8 w-8 text-accent mb-3" />
              <h3 className="font-bold text-sm">On-Chain Verifiable</h3>
              <p className="text-xs opacity-60 mt-1">Results publicly auditable on blockchain</p>
            </div>
            <div className="hover-lift bg-base-100 rounded-2xl p-5 shadow-md border border-base-300/50">
              <ShieldCheckIcon className="h-8 w-8 text-success mb-3" />
              <h3 className="font-bold text-sm">Sybil Resistant</h3>
              <p className="text-xs opacity-60 mt-1">One-person-one-vote enforcement</p>
            </div>
          </div>
        </div>
      </div>

      {/* Team Section */}
      <div className="bg-base-100 border-t border-base-300 py-16 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-2xl font-bold mb-2">Research Team</h2>
          <p className="text-sm opacity-60 mb-8">BSc Engineering (Hons) &bull; University of Ruhuna, Sri Lanka</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div className="space-y-1">
              <div className="w-12 h-12 mx-auto rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold">KK</div>
              <p className="font-medium text-sm">Kumarasinghe K.K.R.</p>
              <p className="text-xs opacity-50">EG/2021/4632</p>
            </div>
            <div className="space-y-1">
              <div className="w-12 h-12 mx-auto rounded-full bg-secondary/10 flex items-center justify-center text-secondary font-bold">RM</div>
              <p className="font-medium text-sm">Madhusankha R.M.D.</p>
              <p className="text-xs opacity-50">EG/2021/4655</p>
            </div>
            <div className="space-y-1">
              <div className="w-12 h-12 mx-auto rounded-full bg-accent/10 flex items-center justify-center text-accent font-bold">RM</div>
              <p className="font-medium text-sm">Pradeepani R.M.T.</p>
              <p className="text-xs opacity-50">EG/2021/4725</p>
            </div>
            <div className="space-y-1">
              <div className="w-12 h-12 mx-auto rounded-full bg-success/10 flex items-center justify-center text-success font-bold">KK</div>
              <p className="font-medium text-sm">Ranasinghe K.K.M.P</p>
              <p className="text-xs opacity-50">EG/2021/4735</p>
            </div>
          </div>
        </div>
      </div>

      {/* Tech Stack */}
      <div className="bg-base-200 py-12 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <h3 className="text-lg font-bold mb-6 opacity-70">Built With</h3>
          <div className="flex flex-wrap justify-center gap-3">
            {["Noir ZK Circuits", "Solidity", "Barretenberg", "Next.js", "Ethereum", "Poseidon Hash", "LeanIMT", "ERC-4337"].map(tech => (
              <span key={tech} className="px-4 py-2 bg-base-100 rounded-full text-xs font-medium shadow-sm border border-base-300/50">
                {tech}
              </span>
            ))}
          </div>
        </div>
      </div>
    </>
  );
};

export default Home;
