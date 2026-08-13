"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The app's replacement for `window.confirm`.
 *
 * Every call site this exists for gates something destructive — a broadcast
 * that overwrites every division's ballot, a one-way phase change, deleting an
 * officer's signing key, wiping an election. A toast is the wrong shape for
 * that: it is passive and it auto-dismisses, so the operator would never be
 * asked anything. What those call sites need is the same blocking yes/no
 * `window.confirm` gave them, in the app's own visual language.
 *
 * `useConfirm` therefore keeps the *promise* shape rather than a callback one.
 * A call site written against `window.confirm` reads
 *
 *     const ok = window.confirm(text);
 *     if (!ok) return;
 *
 * and becomes
 *
 *     const ok = await confirm({ title, message: text });
 *     if (!ok) return;
 *
 * — one `await`, and the branch below it is untouched. Anything callback-shaped
 * would have forced every one of these handlers to be turned inside out, which
 * is exactly the kind of change that loses a confirmation step by accident.
 */

export type ConfirmRequest = {
  /** Short heading. The dialog needs one; `window.confirm` had no equivalent. */
  title: string;
  /** The prompt itself. Rendered `whitespace-pre-line`, so `\n` survives. */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` paints the confirm button as destructive. Presentation only. */
  tone?: "default" | "danger";
};

type ConfirmDialogProps = ConfirmRequest & {
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * The dialog itself. Mounted only while a decision is pending, which is what
 * makes it open — there is no `open` prop to keep in sync with the DOM.
 */
export const ConfirmDialog = ({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;

    // `showModal()` is what makes this modal: the ::backdrop, the focus trap and
    // the inertness of the page behind it. jsdom (26.x) implements neither
    // `showModal` nor `close`, so fall back to the `open` attribute there — the
    // dialog still renders, is still exposed as `role="dialog"`, and the
    // handlers below still supply Escape and backdrop dismissal.
    //
    // Note the ordering: `showModal()` throws `InvalidStateError` on an element
    // that already carries `open`, which is why `open` is never set in the JSX.
    if (typeof node.showModal === "function") node.showModal();
    else node.setAttribute("open", "");

    // Focus the safe option, not the destructive one. It also gives Escape a
    // target inside the dialog on the fallback path, where nothing moved focus.
    cancelRef.current?.focus();

    return () => {
      if (typeof node.close === "function" && node.open) node.close();
    };
  }, []);

  /**
   * Escape closes it, as it did for `window.confirm`, and closing without an
   * answer means "no" — the same branch a Cancel click takes, so dismissing can
   * never be mistaken for consent.
   *
   * `preventDefault` stops the element closing itself natively: React owns
   * whether this is mounted, and a dialog that closed behind React's back would
   * leave the promise unresolved and the caller waiting forever.
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onCancel();
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
      onKeyDown={handleKeyDown}
      onCancel={event => {
        // Belt and braces for browsers that raise `cancel` without a keydown we
        // saw (e.g. the platform's own dismiss gesture).
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="modal-box">
        <h3 id="confirm-dialog-title" className="text-lg font-semibold m-0 p-0">
          {title}
        </h3>

        <p id="confirm-dialog-message" className="py-4 text-sm whitespace-pre-line break-words">
          {message}
        </p>

        <div className="modal-action">
          <button type="button" className="btn btn-sm" onClick={onCancel} ref={cancelRef}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${tone === "danger" ? "btn-error" : "btn-primary"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>

      {/*
       * DaisyUI's backdrop. `type="button"` rather than the usual
       * `method="dialog"` submit: a native submit closes the element directly,
       * which is the same desync `handleKeyDown` avoids. Routed through
       * `onCancel` instead, so a backdrop click is just another "no".
       *
       * Hidden from the accessibility tree and from the tab order on purpose.
       * It is a pointer affordance only — a keyboard user already has Escape
       * and the Cancel button, and exposing this would put a second control
       * with the same meaning in the tree, which reads as a duplicate rather
       * than a shortcut.
       */}
      <form method="dialog" className="modal-backdrop">
        <button type="button" onClick={onCancel} aria-hidden="true" tabIndex={-1}>
          close
        </button>
      </form>
    </dialog>
  );
};

/**
 * Ask for confirmation from an event handler.
 *
 * Returns the `confirm` function and the element to render. The element is
 * `null` while nothing is pending, so the dialog is mounted only when there is
 * actually a question outstanding.
 */
export const useConfirm = () => {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    resolve?.(confirmed);
  }, []);

  const confirm = useCallback((next: ConfirmRequest) => {
    // A second prompt raised while one is still open would strand the first
    // promise, leaving its handler suspended forever. Deny the outstanding one
    // instead: an unanswered question is not consent.
    resolveRef.current?.(false);
    resolveRef.current = null;

    setRequest(next);
    return new Promise<boolean>(resolve => {
      resolveRef.current = resolve;
    });
  }, []);

  const onConfirm = useCallback(() => settle(true), [settle]);
  const onCancel = useCallback(() => settle(false), [settle]);

  const confirmDialog = request ? <ConfirmDialog {...request} onConfirm={onConfirm} onCancel={onCancel} /> : null;

  return { confirm, confirmDialog };
};
