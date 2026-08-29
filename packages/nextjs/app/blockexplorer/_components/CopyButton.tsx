"use client";

import { CheckCircleIcon, DocumentDuplicateIcon } from "@heroicons/react/24/outline";
import { useCopyToClipboard } from "~~/hooks/scaffold-eth";

/**
 * Small copy-to-clipboard affordance, reused for addresses, ABI and bytecode.
 * Wraps the shared `useCopyToClipboard` hook so the 800ms "copied" flash is
 * consistent with the rest of the app.
 */
export const CopyButton = ({
  value,
  label,
  className = "",
}: {
  value: string;
  /** Accessible name, e.g. "Copy contract address". */
  label: string;
  className?: string;
}) => {
  const { copyToClipboard, isCopiedToClipboard } = useCopyToClipboard();

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`btn btn-ghost btn-xs px-1 ${className}`}
      onClick={() => copyToClipboard(value)}
    >
      {isCopiedToClipboard ? (
        <CheckCircleIcon className="h-4 w-4 text-success" aria-hidden />
      ) : (
        <DocumentDuplicateIcon className="h-4 w-4" aria-hidden />
      )}
    </button>
  );
};
