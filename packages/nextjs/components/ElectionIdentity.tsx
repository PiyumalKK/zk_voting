"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useElectionAuth } from "~~/hooks/useElectionAuth";

/**
 * The header's identity control in custom-chain mode.
 *
 * Replaces the RainbowKit connect button, which is meaningless once the signing
 * keys live on the server: there is no wallet for an operator to connect, and
 * offering one would invite them to try (`01-AUTH-DESIGN.md` §2).
 *
 * Renders nothing at all in hardhat mode — `Header` decides which control to
 * show, and this component never appears there.
 */

const ROLE_LABEL: Record<"admin" | "gn", string> = {
  admin: "Election Authority",
  gn: "GN Officer",
};

export const ElectionIdentity = () => {
  const router = useRouter();
  const { session, isLoading, signOut } = useElectionAuth();

  if (isLoading) {
    return <span className="loading loading-spinner loading-sm mr-2" aria-label="Checking sign-in status" />;
  }

  if (!session) {
    return (
      <Link href="/login" className="btn btn-primary btn-sm">
        Sign in
      </Link>
    );
  }

  const handleSignOut = async () => {
    await signOut();
    // A push rather than a replace: the operator can still go back to the page
    // they were on, where the gate will now correctly ask them to sign in.
    router.push("/login");
  };

  return (
    <div className="flex items-center gap-2">
      <div className="hidden sm:flex flex-col items-end leading-tight">
        <span className="text-sm font-bold">{session.username}</span>
        <span className="text-[10px] opacity-60">
          {ROLE_LABEL[session.role]}
          {session.role === "gn" && session.divisionId !== undefined ? ` · Division ${session.divisionId}` : ""}
        </span>
      </div>
      <button className="btn btn-ghost btn-sm" onClick={handleSignOut}>
        Sign out
      </button>
    </div>
  );
};
