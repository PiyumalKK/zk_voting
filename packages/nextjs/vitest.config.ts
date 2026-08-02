import path from "path";
import { defineConfig } from "vitest/config";

/**
 * Unit tests for the chain-mode switch.
 *
 * Node environment only — these cover pure resolution logic and a source-tree
 * guard, not React rendering. Component behaviour is verified by the M11
 * acceptance gate (`e2e/frontend-check.mjs` plus the browser walkthrough).
 */
export default defineConfig({
  resolve: {
    alias: {
      "~~": path.resolve(__dirname),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
    // The first test to import `viem/chains` pays for transforming it — several
    // seconds on a cold cache, which trips the 5s default. Nothing here is
    // actually slow; every subsequent case runs in single-digit milliseconds.
    testTimeout: 30_000,
  },
});
