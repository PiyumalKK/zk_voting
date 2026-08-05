import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * jsdom project setup.
 *
 * Unmounting between cases matters more than usual here: `useElectionAuth`
 * keeps a module-level session cache shared by every component, and a hook left
 * mounted would keep subscribing across test boundaries. Each suite that
 * touches it resets the store explicitly; this is the backstop.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * jsdom implements neither of these, and React logs a hard error rather than a
 * warning when a component under test calls them. Both are used by the daisyUI
 * dialogs and the router shim in the pages this project covers.
 */
if (typeof window !== "undefined") {
  window.matchMedia =
    window.matchMedia ??
    ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList);

  window.scrollTo = window.scrollTo ?? (() => {});
}
