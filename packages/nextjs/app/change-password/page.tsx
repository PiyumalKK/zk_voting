"use client";

import { FormEvent, useEffect, useState } from "react";
import { useElectionAuth } from "~~/hooks/useElectionAuth";
import { MIN_PASSWORD_LENGTH } from "~~/services/auth/passwordPolicy";
import { getChainMode, homePathForRole } from "~~/utils/chainMode";

/**
 * Where a GN officer takes custody of their own credential.
 *
 * Reached two ways: forced, straight after a first sign-in with the password
 * the admin generated, or voluntarily later. The forced case is the one that
 * matters — until it completes, `requireSession()` refuses every privileged
 * call, so an officer standing here cannot yet enrol a voter.
 *
 * The page explains *why* rather than just demanding a new password. An officer
 * who understands that the admin can read the current one is an officer who
 * picks a real replacement instead of adding "1" to what they were given.
 */

const ChangePasswordPage = () => {
  const { session, isLoading, mustChangePassword, refresh } = useElectionAuth();
  const isCustom = getChainMode() === "custom";

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Never leave a password in the back/forward cache.
  useEffect(
    () => () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
    [],
  );

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH;
  const sameAsCurrent = newPassword.length > 0 && newPassword === currentPassword;

  const canSubmit =
    !isSubmitting && currentPassword.length > 0 && newPassword.length > 0 && !mismatch && !tooShort && !sameAsCurrent;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;

    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(typeof body?.error === "string" ? body.error : `Could not change the password (${response.status}).`);
        setCurrentPassword("");
        setIsSubmitting(false);
        return;
      }

      // Drop the cached session so nothing downstream still believes the gate
      // is set.
      await refresh();

      // A full navigation rather than `router.replace`. We reached this page by
      // being redirected away from the portal, so the App Router's client cache
      // holds that redirect for `/gn` — replaying it would bounce us straight
      // back here even though the cookie is now clear. A hard load re-runs the
      // middleware against the fresh cookie with no cache in the way.
      //
      // `isSubmitting` is deliberately left set: the button stays disabled
      // while the browser tears the page down, instead of flashing back to
      // "Save password" as if nothing happened.
      window.location.assign(homePathForRole(session?.role ?? "gn"));
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setIsSubmitting(false);
    }
  };

  if (!isCustom) {
    return (
      <div className="flex flex-col items-center justify-center grow p-6">
        <p className="opacity-70 text-sm max-w-sm text-center">
          This deployment authenticates operators with a wallet, so there is no password to change.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center grow p-6 lg:p-8">
      <div className="w-full max-w-sm bg-base-100 rounded-2xl p-8 shadow-md border border-base-300/50">
        <div className="text-center mb-6">
          <div className="text-4xl mb-2">🔑</div>
          <h1 className="text-2xl font-bold">Set your password</h1>
          {session?.username && <p className="text-xs opacity-50 mt-1">Signed in as {session.username}</p>}
        </div>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <span className="loading loading-spinner" />
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            {mustChangePassword && (
              // One wrapper child on purpose: DaisyUI's `.alert` lays its direct
              // children out as grid *columns*, so two siblings here would sit
              // side by side and squeeze the explanation into a sliver.
              // `alert-soft` rather than the solid fill: this is an
              // explanation the officer needs to read, not an error. At full
              // saturation it shouts louder than the form it is introducing.
              <div className="alert alert-warning alert-soft text-sm" role="status">
                <div className="flex flex-col items-start gap-1 w-full min-w-0">
                  <span className="font-bold">Choose your own password to continue.</span>
                  <span className="text-xs">
                    The password you signed in with was generated by the election admin, who has seen it. Until you
                    replace it, you cannot enrol voters — and any action taken with it could not be attributed to you
                    alone.
                  </span>
                </div>
              </div>
            )}

            {error && (
              <div className="alert alert-error text-sm" role="alert">
                <span>{error}</span>
              </div>
            )}

            <div className="form-control">
              <label className="label" htmlFor="current-password">
                <span className="label-text text-sm font-bold">Current password</span>
              </label>
              <input
                id="current-password"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
                className="input input-bordered w-full"
                value={currentPassword}
                onChange={event => setCurrentPassword(event.target.value)}
                disabled={isSubmitting}
              />
            </div>

            <div className="form-control">
              <label className="label" htmlFor="new-password">
                <span className="label-text text-sm font-bold">New password</span>
              </label>
              <input
                id="new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                className={`input input-bordered w-full ${tooShort || sameAsCurrent ? "input-error" : ""}`}
                value={newPassword}
                onChange={event => setNewPassword(event.target.value)}
                disabled={isSubmitting}
                aria-describedby="new-password-hint"
              />
              {/*
                A plain paragraph, not DaisyUI's `.label`: that class is
                `white-space: nowrap`, so a sentence inside it cannot wrap and
                runs straight off the edge of the card.
              */}
              <p id="new-password-hint" className="text-xs opacity-60 mt-1">
                {sameAsCurrent
                  ? "Choose something different from your current password."
                  : `At least ${MIN_PASSWORD_LENGTH} characters. Nobody else will know it — there is no way to recover it.`}
              </p>
            </div>

            <div className="form-control">
              <label className="label" htmlFor="confirm-password">
                <span className="label-text text-sm font-bold">Confirm new password</span>
              </label>
              <input
                id="confirm-password"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                className={`input input-bordered w-full ${mismatch ? "input-error" : ""}`}
                value={confirmPassword}
                onChange={event => setConfirmPassword(event.target.value)}
                disabled={isSubmitting}
              />
              {mismatch && <p className="text-xs text-error mt-1">The two passwords do not match.</p>}
            </div>

            <button type="submit" className="btn btn-primary w-full" disabled={!canSubmit}>
              {isSubmitting ? <span className="loading loading-spinner loading-sm" /> : "Save password"}
            </button>

            <p className="text-xs opacity-50 text-center">
              If you forget it, the admin can delete the account and issue a new one. They cannot look this password up.
            </p>
          </form>
        )}
      </div>
    </div>
  );
};

export default ChangePasswordPage;
