import React from "react";

/**
 * The admin panel's card. Extracted from `page.tsx` so the GN Accounts panel —
 * which lives in its own file because it is custom-mode only — renders in the
 * same frame as the numbered sections around it.
 */
export const Section = ({
  title,
  hint,
  children,
  disabled,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  disabled?: boolean;
}) => (
  <div
    className={`bg-base-100/60 backdrop-blur-xl shadow-2xl rounded-3xl p-8 space-y-6 border border-base-300/50 hover:border-primary/30 transition-all duration-500 relative overflow-hidden ${disabled ? "opacity-70" : ""}`}
  >
    <div>
      <h2 className="text-xl font-bold">{title}</h2>
      {hint && <p className="text-xs opacity-60 mt-1">{hint}</p>}
    </div>
    {children}
  </div>
);
