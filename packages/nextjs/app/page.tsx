"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { NextPage } from "next";
import { usePublicClient } from "wagmi";
import {
  ArrowDownTrayIcon,
  ArrowRightIcon,
  CheckBadgeIcon,
  DevicePhoneMobileIcon,
  EyeIcon,
  LockClosedIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";
import { useDivisions } from "~~/hooks/useDivisions";

const VOTING_PREVIEW_ABI = [
  { name: "getCandidates", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string[]" }] },
  { name: "getVoteCounts", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] },
  {
    name: "getVotingData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { type: "string" },
      { type: "address" },
      { type: "uint8" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
    ],
  },
] as const;

const PALETTES = ["bg-primary", "bg-secondary", "bg-accent", "bg-success", "bg-warning", "bg-error"];

type DivisionPreview = {
  candidates: string[];
  counts: number[];
  question: string;
};

// Simple concentric-ring verification seal — the page's one signature element.
// Ties directly to the platform's actual differentiator (publicly verifiable proofs)
// rather than a decorative icon.
const VerificationSeal = ({ active }: { active: boolean }) => (
  <div className="relative flex h-16 w-16 items-center justify-center">
    <span className="absolute inset-0 rounded-full border-2 border-primary/30" />
    <span className="absolute inset-[6px] rounded-full border border-primary/50" />
    <ShieldCheckIcon className="h-7 w-7 text-primary" />
    {active && (
      <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
        <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-success" />
      </span>
    )}
  </div>
);

const Home: NextPage = () => {
  const publicClient = usePublicClient();
  const { divisions, isLoading: divisionsLoading } = useDivisions();
  const [previews, setPreviews] = useState<DivisionPreview[]>([]);
  const [loadingPreview, setLoadingPreview] = useState(true);

  const divisionsKey = useMemo(() => divisions.map(division => division.votingContract).join(","), [divisions]);

  useEffect(() => {
    let cancelled = false;

    const loadPreview = async () => {
      if (!publicClient || divisions.length === 0) {
        if (!divisionsLoading) setLoadingPreview(false);
        return;
      }

      setLoadingPreview(true);
      const loaded = await Promise.all(
        divisions.map(async division => {
          try {
            const [candidates, counts, votingData] = await Promise.all([
              publicClient.readContract({
                address: division.votingContract,
                abi: VOTING_PREVIEW_ABI,
                functionName: "getCandidates",
              }),
              publicClient.readContract({
                address: division.votingContract,
                abi: VOTING_PREVIEW_ABI,
                functionName: "getVoteCounts",
              }),
              publicClient.readContract({
                address: division.votingContract,
                abi: VOTING_PREVIEW_ABI,
                functionName: "getVotingData",
              }),
            ]);

            return {
              candidates: candidates as string[],
              counts: (counts as bigint[]).map(Number),
              question: (votingData as readonly unknown[])[0] as string,
            };
          } catch {
            return { candidates: [], counts: [], question: "" };
          }
        }),
      );

      if (!cancelled) {
        setPreviews(loaded);
        setLoadingPreview(false);
      }
    };

    loadPreview();
    return () => {
      cancelled = true;
    };
    // Keep this aligned with the Results page's per-division reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [divisionsKey, publicClient, divisionsLoading]);

  const national = useMemo(() => {
    const candidates: string[] = [];
    const totals: number[] = [];
    let totalVotes = 0;
    let question = "";

    for (const preview of previews) {
      if (!question && preview.question) question = preview.question;
      preview.candidates.forEach((candidate, index) => {
        if (!candidates[index]) candidates[index] = candidate;
        totals[index] = (totals[index] ?? 0) + (preview.counts[index] ?? 0);
      });
      totalVotes += preview.counts.reduce((sum, count) => sum + count, 0);
    }

    return { candidates, totals, totalVotes, question };
  }, [previews]);

  const maxVotes = Math.max(0, ...national.totals);
  const previewLoading = divisionsLoading || loadingPreview;
  const hasActiveElection = !previewLoading && Boolean(national.question) && national.candidates.length > 0;

  return (
    <main>
      {/* ── Hero: platform identity, not tied to any single election ── */}
      <section className="border-b border-base-300 bg-base-100 px-6 py-20 md:py-24">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-col items-start gap-10 md:flex-row md:items-center md:justify-between">
            <div className="max-w-2xl">
              <div className="mb-6 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-primary/80">
                <span className="h-px w-8 bg-primary/50" />
                Digital election infrastructure
              </div>
              <h1 className="font-serif text-4xl font-bold leading-[1.15] text-base-content md:text-5xl">
                A voting record every citizen can verify — without ever revealing a single vote.
              </h1>
              <p className="mt-6 max-w-xl text-base leading-relaxed text-base-content/65 md:text-lg">
                SL Vote is election infrastructure built on zero-knowledge proofs: eligibility is checked, ballots are
                counted, and results are publicly auditable — while no one, including the system itself, can ever see
                how an individual voted.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <a className="btn btn-primary gap-2" href="#download">
                  <ArrowDownTrayIcon className="h-5 w-5" /> Download the app
                </a>
                <Link className="btn btn-outline gap-2" href="/results">
                  View live results <ArrowRightIcon className="h-4 w-4" />
                </Link>
              </div>
            </div>

            <div className="flex shrink-0 flex-col items-center gap-3 self-stretch justify-center border-t border-base-300 pt-8 md:border-l md:border-t-0 md:pl-10 md:pt-0">
              <VerificationSeal active={hasActiveElection} />
              <p className="text-center text-xs leading-relaxed text-base-content/50">
                {hasActiveElection ? "Election in progress" : "No election currently active"}
              </p>
            </div>
          </div>

          <dl className="mt-14 grid grid-cols-1 gap-6 border-t border-base-300 pt-8 sm:grid-cols-3">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-base-content/45">Ballot secrecy</dt>
              <dd className="mt-1 text-sm text-base-content/70">Identity and vote choice are never linkable.</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-base-content/45">Verifiability</dt>
              <dd className="mt-1 text-sm text-base-content/70">Every result can be independently audited.</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-base-content/45">Eligibility</dt>
              <dd className="mt-1 text-sm text-base-content/70">One person, one vote — cryptographically enforced.</dd>
            </div>
          </dl>
        </div>
      </section>

      {/* ── Current election: dynamic, clearly separate from platform identity ── */}
      <section className="bg-base-200 px-6 py-16 md:py-20">
        <div className="mx-auto max-w-4xl">
          <div className="mb-6 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-primary/80">
            <span className="h-px w-8 bg-primary/50" />
            Currently active election
          </div>

          <div className="rounded-2xl border border-base-300/60 bg-base-100 p-6 shadow-sm md:p-8">
            {previewLoading ? (
              <div className="flex items-center gap-3 py-6 text-base-content/60">
                <span className="loading loading-spinner loading-sm" /> Reading election status from chain…
              </div>
            ) : !hasActiveElection ? (
              <div className="py-6">
                <p className="font-semibold text-base-content">No election is currently active.</p>
                <p className="mt-1 text-sm text-base-content/55">
                  When an election is opened, its details and live results will appear here automatically.
                </p>
              </div>
            ) : (
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="badge badge-success gap-1.5 border-none px-3 py-3 text-xs font-semibold text-success-content">
                    <span className="h-1.5 w-1.5 rounded-full bg-success-content" /> Live
                  </span>
                  <span className="text-xs text-base-content/45">
                    {divisions.length} division{divisions.length === 1 ? "" : "s"} reporting
                  </span>
                </div>
                <h2 className="mt-4 font-serif text-2xl font-bold leading-snug text-base-content md:text-3xl">
                  {national.question}
                </h2>
                <p className="mt-2 text-sm text-base-content/55">
                  {national.candidates.length} candidate{national.candidates.length === 1 ? "" : "s"} ·{" "}
                  {national.totalVotes.toLocaleString()} votes recorded so far
                </p>
                <Link className="btn btn-sm btn-outline mt-6 gap-1" href="/results">
                  View full results <ArrowRightIcon className="h-4 w-4" />
                </Link>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── Download ── */}
      <section id="download" className="bg-base-100 px-6 py-16 md:py-20">
        <div className="mx-auto grid max-w-5xl items-start gap-10 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-base-300 text-primary">
              <DevicePhoneMobileIcon className="h-6 w-6" />
            </div>
            <h2 className="font-serif text-2xl font-bold text-base-content md:text-3xl">Download the SL Vote app</h2>
            <p className="mt-2 max-w-xl text-base-content/65">
              Voting credentials stay on your own device. Register once with your local GN office, then take part
              whenever an election you&apos;re eligible for is open.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <button className="btn btn-neutral gap-2" disabled type="button">
                <span className="text-lg leading-none">▶</span> Google Play{" "}
                <span className="badge badge-warning badge-sm">Coming soon</span>
              </button>
              <button className="btn btn-neutral gap-2" disabled type="button">
                <span className="text-lg leading-none">●</span> App Store{" "}
                <span className="badge badge-warning badge-sm">Coming soon</span>
              </button>
            </div>
            <p className="mt-4 text-xs text-base-content/45">
              The app is not published yet. Store links will appear here once it is available.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-1">
            {[
              [LockClosedIcon, "Private", "Your identity stays separate from your ballot."],
              [CheckBadgeIcon, "Verifiable", "Election records can be checked publicly."],
              [ShieldCheckIcon, "Secure", "Built on zero-knowledge cryptography."],
            ].map(([Icon, title, description]) => {
              const FeatureIcon = Icon as typeof LockClosedIcon;
              return (
                <div
                  key={title as string}
                  className="flex items-start gap-3 rounded-xl border border-base-300/60 bg-base-100 p-4"
                >
                  <FeatureIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <div>
                    <h3 className="text-sm font-bold text-base-content">{title as string}</h3>
                    <p className="text-xs leading-relaxed text-base-content/55">{description as string}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Live results preview ── */}
      <section className="border-y border-base-300 bg-base-200 px-6 py-16 md:py-20">
        <div className="mx-auto max-w-4xl">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary/80">Live results</p>
              <h2 className="mt-2 font-serif text-2xl font-bold text-base-content md:text-3xl">
                National results preview
              </h2>
              <p className="mt-1 text-sm text-base-content/60">A simplified tally aggregated from every division.</p>
            </div>
            <Link className="btn btn-outline btn-sm gap-1" href="/results">
              View full results <ArrowRightIcon className="h-4 w-4" />
            </Link>
          </div>

          <div className="rounded-2xl border border-base-300/60 bg-base-100 p-5 md:p-7">
            {previewLoading ? (
              <div className="flex items-center justify-center gap-3 py-14 text-base-content/60">
                <span className="loading loading-spinner loading-md" /> Loading on-chain results…
              </div>
            ) : national.candidates.length === 0 ? (
              <div className="py-12 text-center text-base-content/60">
                <EyeIcon className="mx-auto mb-3 h-9 w-9 text-primary/70" />
                <p className="font-semibold text-base-content">Results will appear here once an election is active.</p>
                <p className="mt-1 text-sm">The full results page remains available for public verification.</p>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="flex items-baseline justify-between border-b border-base-300/70 pb-4">
                  <span className="text-sm text-base-content/60">Votes recorded</span>
                  <span className="text-2xl font-bold text-primary">{national.totalVotes.toLocaleString()}</span>
                </div>
                {national.candidates.map((candidate, index) => {
                  const votes = national.totals[index] ?? 0;
                  const percentage = national.totalVotes > 0 ? (votes / national.totalVotes) * 100 : 0;
                  return (
                    <div key={`${candidate}-${index}`}>
                      <div className="mb-2 flex items-center justify-between gap-4">
                        <span className="text-sm font-semibold text-base-content">{candidate}</span>
                        <span className="text-sm text-base-content/60">
                          {votes.toLocaleString()} · {percentage.toFixed(1)}%
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-base-300/60">
                        <div
                          className={`h-full rounded-full ${PALETTES[index % PALETTES.length]} transition-all duration-700`}
                          style={{ width: `${maxVotes > 0 ? percentage : 0}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── How it works: a genuine ordered sequence, so numbering earns its place ── */}
      <section className="bg-base-100 px-6 py-16 md:py-20">
        <div className="mx-auto max-w-5xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary/80">How it works</p>
          <h2 className="mt-2 font-serif text-2xl font-bold text-base-content md:text-3xl">
            Simple for voters. Private by design.
          </h2>
          <ol className="mt-10 grid gap-6 md:grid-cols-4">
            {[
              ["01", "Register", "Visit your local GN office to join the voter roll."],
              ["02", "Verify", "Your eligibility is checked without placing your personal details on the ballot."],
              ["03", "Vote anonymously", "Use the mobile app to cast a private vote during the election."],
              ["04", "Verify your vote", "Review the public election record and final results with confidence."],
            ].map(([number, title, description]) => (
              <li key={number} className="border-t-2 border-primary/70 pt-4">
                <span className="font-serif text-sm font-bold text-primary/70">{number}</span>
                <h3 className="mt-2 font-bold text-base-content">{title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-base-content/60">{description}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-base-300 bg-base-100 px-6 py-10">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-5 text-center md:flex-row md:text-left">
          <div>
            <p className="font-serif font-bold text-base-content">SL Vote</p>
            <p className="text-sm text-base-content/55">
              Independent, publicly verifiable election infrastructure · Final Year Project, University of Ruhuna
            </p>
          </div>
          <nav className="flex flex-wrap justify-center gap-5 text-sm font-medium text-primary">
            <Link className="hover:underline" href="/results">
              Results
            </Link>
            <Link className="hover:underline" href="/audit">
              Audit
            </Link>
            <Link className="hover:underline" href="/gn">
              GN Portal
            </Link>
          </nav>
        </div>
      </footer>
    </main>
  );
};

export default Home;
