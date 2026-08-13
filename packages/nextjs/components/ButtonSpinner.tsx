import React from "react";

/**
 * The pending indicator for a button that is waiting on a transaction.
 *
 * daisyUI 5 changed what `loading` means. In v3/v4 it was a `.btn` modifier
 * that prepended a spinner; in v5 it is a standalone component that turns
 * whatever element carries it *into* the spinner — `mask-image`, `mask-size:
 * 100%`, `aspect-ratio: 1`. `.btn` wins the properties the two rules share
 * (both sit in `@layer utilities`, and daisyUI emits `button` after `loading`),
 * but nothing in `.btn` unsets the mask. So the pre-v5 idiom
 *
 *     className={`btn btn-primary ${busy ? "loading" : ""}`}
 *
 * no longer decorates the button, it erases it: the mask is scaled to the
 * button's width and centred, so a full-width button is clipped to a thin
 * horizontal slice of a ~460px animated ring. The background and the label
 * both disappear, leaving two flickering arcs at the button's edges for the
 * whole transaction. The spinner has to be a *child*, which is how
 * `SaveButton` and the rest of the app already render it.
 *
 * Shared rather than inlined at each call site because these five buttons all
 * stand in front of the same thing — an unconfirmed on-chain write — and an
 * operator who learns one button's pending state should not have to relearn
 * it on the next screen.
 *
 * The slot is always mounted and always one width, so the label sits in the
 * same place before, during and after the action. Mounting the spinner only
 * while pending would jog the label sideways by the spinner plus `.btn`'s
 * `gap` at the exact moment the operator clicks — the one moment they are
 * looking straight at it.
 */
export const ButtonSpinner = ({ pending }: { pending: boolean }) => (
  // `w-4` matches `loading-xs` (1rem), so the slot is exactly the spinner's
  // footprint and no wider.
  <span className="inline-flex w-4 shrink-0 items-center justify-center" aria-hidden="true">
    {pending && <span className="loading loading-spinner loading-xs" />}
  </span>
);
