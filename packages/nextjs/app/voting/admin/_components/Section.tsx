import React from "react";

/**
 * The admin panel's card. Extracted from `page.tsx` so the GN Accounts panel —
 * which lives in its own file because it is custom-mode only — renders in the
 * same frame as the sections around it.
 *
 * `tone="danger"` marks a control that destroys state. `resetElection` has no
 * phase gate, so it is live during Voting and sits one mis-click away from the
 * routine buttons; it should not look like them.
 *
 * The title is an `h3` because a `GroupHeading` (`h2`) precedes every stack of
 * these. Both were `h2` before, which left a screen reader with a flat list of
 * siblings — the grouping the layout draws did not exist in the a11y tree.
 */
export const Section = ({
  title,
  hint,
  children,
  disabled,
  tone = "default",
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  disabled?: boolean;
  tone?: "default" | "danger";
}) => {
  const isDanger = tone === "danger";
  return (
    <div
      className={`dash-card p-6 lg:p-8 space-y-6 transition-all duration-300 relative overflow-hidden ${
        isDanger ? "border-error/40 bg-error/5" : "hover:border-primary/30"
      } ${disabled ? "opacity-70" : ""}`}
    >
      <div className="border-b border-base-300/60 pb-4">
        <h3 className={`text-lg font-bold ${isDanger ? "text-error" : ""}`}>{title}</h3>
        {hint && <p className="text-xs opacity-60 mt-1">{hint}</p>}
      </div>
      {children}
    </div>
  );
};

/** Separates the panel stack into the operator's mental groups. */
export const GroupHeading = ({ title, subtitle }: { title: string; subtitle?: string }) => (
  <div className="pt-3">
    <h2 className="text-xs font-bold uppercase tracking-widest text-base-content/50">{title}</h2>
    {subtitle && <p className="text-xs opacity-50 mt-1 max-w-2xl">{subtitle}</p>}
  </div>
);
