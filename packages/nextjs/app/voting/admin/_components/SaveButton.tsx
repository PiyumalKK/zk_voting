import React from "react";
import { CheckIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";

/**
 * The lifecycle of one admin save, as the operator sees it.
 *
 * `saving` already existed as a label swap driven by the provider's `busy`.
 * The two settled states are the point of this component: before it, a save
 * went "Save question" → "Saving…" → "Save question", so the button looked
 * identical whether the transaction landed or the click never registered. The
 * only evidence was a toast, which is gone in four seconds and missed entirely
 * by an operator who looked away — exactly when they are most likely to click
 * twice and send a second transaction.
 *
 * Both settled states persist. Neither expires on a timer, because each is a
 * statement about the data currently on screen and stays true until that data
 * changes — see the provider, which retires a verdict on an edit, a division
 * change, or a fresh attempt, and never on a clock.
 */
export type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * A save button that reports its own outcome.
 *
 * It is shared rather than written twice because the ballot screen has two of
 * these doing the same job (question, candidates), and a settled state that
 * behaved differently between them would be worse than none — an operator
 * would learn one button's language and misread the other.
 *
 * The state is owned by `AdminElectionProvider` (`saveStateOf`), not here,
 * because the provider is what actually knows how a write went. This component
 * only renders it.
 */
export const SaveButton = ({
  state,
  idleLabel,
  savingLabel = "Saving…",
  savedLabel = "Saved",
  errorLabel = "Save failed — retry",
  disabled,
  onClick,
  className = "btn btn-primary btn-sm",
}: {
  state: SaveState;
  /** What the button says when there is nothing to report. */
  idleLabel: React.ReactNode;
  savingLabel?: React.ReactNode;
  savedLabel?: React.ReactNode;
  errorLabel?: React.ReactNode;
  /** Caller's own gating — phase, empty input, another action in flight. */
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) => {
  const isSaving = state === "saving";

  // `saving` and `saved` both disable; `error` deliberately does not.
  //
  // A persistent "Saved" means "what is on screen is what was written", so
  // there is nothing left to do until the operator changes something — and an
  // enabled button there invites a second, identical transaction from someone
  // unsure whether the first landed, which is the very doubt this state
  // exists to settle. Editing the data clears the verdict and re-enables it.
  //
  // A failure is the opposite: unfinished work, whose next move is to retry.
  const isDisabled = disabled || isSaving || state === "saved";

  const tone =
    state === "error"
      ? // Overrides whatever the caller passed, so a failure never renders in
        // the same colour as the idle button it replaced.
        `${className} btn-error`
      : state === "saved"
        ? `${className} btn-success`
        : className;

  return (
    <button
      className={tone}
      disabled={isDisabled}
      onClick={onClick}
      // Announced to assistive technology: the label change is the whole
      // feedback mechanism, so it must not be visual-only.
      aria-live="polite"
    >
      {isSaving && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
      {state === "saved" && <CheckIcon className="h-4 w-4" aria-hidden="true" />}
      {state === "error" && <ExclamationTriangleIcon className="h-4 w-4" aria-hidden="true" />}
      {state === "saving" ? savingLabel : state === "saved" ? savedLabel : state === "error" ? errorLabel : idleLabel}
    </button>
  );
};
