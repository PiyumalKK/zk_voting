"use client";

import { useMemo } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-solidity";

/**
 * Solidity source rendered with Prism highlighting and a line-number gutter.
 *
 * Prism is used through `Prism.highlight()` rather than `highlightAll()`, and
 * the output deliberately carries no `language-solidity` class. Prism's core
 * registers a `DOMContentLoaded` hook that re-highlights any element with such a
 * class; keeping the class off means that hook can never double-process this
 * markup, so no `Prism.manual` global juggling is needed.
 *
 * Token colours live in `styles/globals.css` under `.solidity-code`, so they
 * follow the daisyUI theme instead of shipping a fixed Prism theme stylesheet
 * (global CSS can only be imported from the root layout anyway).
 */
export const SolidityCode = ({ code, className = "" }: { code: string; className?: string }) => {
  const highlighted = useMemo(() => {
    const grammar = Prism.languages.solidity;
    // Fall back to plain text if the grammar failed to register, rather than
    // throwing and taking the whole contract page down.
    if (!grammar) return null;
    try {
      return Prism.highlight(code, grammar, "solidity");
    } catch {
      return null;
    }
  }, [code]);

  const lineCount = useMemo(() => code.split("\n").length, [code]);

  return (
    <div className={`solidity-code flex overflow-x-auto rounded-lg border border-base-300 ${className}`}>
      <div
        aria-hidden
        className="select-none shrink-0 py-3 pl-4 pr-3 text-right font-mono text-xs leading-5 text-base-content/40 border-r border-base-300 bg-base-200/60 sticky left-0"
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <pre className="grow py-3 px-4 font-mono text-xs leading-5 whitespace-pre">
        {highlighted === null ? <code>{code}</code> : <code dangerouslySetInnerHTML={{ __html: highlighted }} />}
      </pre>
    </div>
  );
};
