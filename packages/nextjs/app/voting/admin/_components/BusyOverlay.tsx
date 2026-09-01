"use client";

/**
 * Full-screen modal shown while a bulk operation (import, invite send) is in
 * flight. A bulk request can take a while and returns nothing to look at
 * until it's done, so without this an admin has no reason not to click over
 * to another admin tab mid-import — which doesn't cancel the request, but
 * does mean they stop watching for the result (and, worse, might start a
 * second one, or navigate somewhere that resets local state). Purely visual:
 * it can't block a real navigation, it just makes "this is still working"
 * impossible to miss.
 */
export const BusyOverlay = ({ show, label }: { show: boolean; label: string }) => {
  if (!show) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in"
      role="alert"
      aria-live="assertive"
    >
      <div className="bg-base-100 rounded-2xl shadow-2xl p-8 flex flex-col items-center gap-3 max-w-xs mx-4 text-center animate-modal-pop">
        <span className="loading loading-spinner loading-lg text-primary" />
        <p className="font-semibold">{label}</p>
        <p className="text-xs opacity-60">Stay on this page until it finishes.</p>
      </div>
    </div>
  );
};
