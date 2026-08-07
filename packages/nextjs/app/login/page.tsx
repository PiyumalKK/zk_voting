"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useElectionAuth } from "~~/hooks/useElectionAuth";
import { getChainMode, homePathForRole } from "~~/utils/chainMode";
import { safeNextPath } from "~~/utils/navigation";

/**
 * Credential sign-in for the election admin and GN officers
 * (`01-AUTH-DESIGN.md` §2, M12 build-order item 2).
 *
 * Custom-chain mode only. In hardhat mode operators authenticate by holding a
 * wallet and the middleware never routes anyone here, so the page explains that
 * rather than presenting a form that `POST /api/auth/login` would answer with a
 * 404.
 *
 * The role is not chosen here: the server infers it from the credentials
 * (admin from env, GN from the account store) and returns it, so a GN cannot
 * reach the admin panel by picking "admin" in a dropdown.
 */

const LoginForm = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { refresh } = useElectionAuth();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const configError = searchParams.get("error") === "config";

  // Nothing on this page should be cached by the browser's back/forward store
  // with a filled-in password field.
  useEffect(() => () => setPassword(""), []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        // The server deliberately returns one message for every credential
        // failure and a distinct one for lockout/rate limiting; showing it
        // verbatim keeps this page from inventing a hint the server withheld.
        setError(typeof body?.error === "string" ? body.error : `Sign-in failed (${response.status}).`);
        setPassword("");
        return;
      }

      const role = body?.role === "gn" ? "gn" : "admin";
      // Re-read the session so the header and page gates see the new identity
      // before the route changes; otherwise the destination renders its
      // "not signed in" state for a frame.
      await refresh();
      router.replace(safeNextPath(searchParams.get("next"), homePathForRole(role)));
    } catch {
      setError("Could not reach the sign-in service. Is the Next.js server running?");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {configError && (
        <div className="alert alert-warning text-sm" role="status">
          <span>
            This server&apos;s session secret is missing or too short. Set <code>SESSION_SECRET</code> (32+ characters)
            in <code>.env.local</code> and restart.
          </span>
        </div>
      )}

      {error && (
        <div className="alert alert-error text-sm" role="alert">
          <span>{error}</span>
        </div>
      )}

      <div className="form-control">
        <label className="label" htmlFor="username">
          <span className="label-text text-sm font-bold">Username</span>
        </label>
        <input
          id="username"
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          className="input input-bordered w-full"
          value={username}
          onChange={event => setUsername(event.target.value)}
          disabled={isSubmitting}
        />
      </div>

      <div className="form-control">
        <label className="label" htmlFor="password">
          <span className="label-text text-sm font-bold">Password</span>
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="input input-bordered w-full"
          value={password}
          onChange={event => setPassword(event.target.value)}
          disabled={isSubmitting}
        />
      </div>

      <button type="submit" className="btn btn-primary w-full" disabled={isSubmitting || !username || !password}>
        {isSubmitting ? <span className="loading loading-spinner loading-sm" /> : "Sign in"}
      </button>

      <p className="text-xs opacity-50 text-center">
        Five failed attempts lock the account for 15 minutes. Voters never sign in here — they use the mobile app.
      </p>
    </form>
  );
};

const WalletModeNotice = () => (
  <div className="text-center space-y-4">
    <p className="opacity-70 text-sm">
      This deployment runs against Hardhat, where the admin and GN portals authenticate with a wallet. There are no
      credentials to enter.
    </p>
    <p className="text-xs opacity-50">
      Connect your wallet from the header, then open the admin panel or the GN portal.
    </p>
    <div className="flex justify-center gap-2">
      <Link href="/voting/admin" className="btn btn-primary btn-sm">
        Admin panel
      </Link>
      <Link href="/gn" className="btn btn-ghost btn-sm">
        GN portal
      </Link>
    </div>
  </div>
);

const LoginPage = () => {
  const isCustom = getChainMode() === "custom";

  return (
    <div className="flex flex-col items-center justify-center grow p-6 lg:p-8">
      <div className="w-full max-w-sm bg-base-100 rounded-2xl p-8 shadow-md border border-base-300/50">
        <div className="text-center mb-6">
          <div className="text-4xl mb-2">🗳️</div>
          <h1 className="text-2xl font-bold">Election Sign-in</h1>
          <p className="text-xs opacity-50 mt-1">Election Authority &amp; Grama Niladhari officers</p>
        </div>

        {isCustom ? (
          // `useSearchParams` opts the subtree into client rendering; without a
          // boundary the whole route would be forced dynamic at build time.
          <Suspense
            fallback={
              <div className="flex justify-center py-8">
                <span className="loading loading-spinner" />
              </div>
            }
          >
            <LoginForm />
          </Suspense>
        ) : (
          <WalletModeNotice />
        )}
      </div>
    </div>
  );
};

export default LoginPage;
