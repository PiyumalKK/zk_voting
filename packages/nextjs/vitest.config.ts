import path from "path";
import { defineConfig } from "vitest/config";

/**
 * Two test projects, split by what they need to run in.
 *
 * - **node** (`*.test.ts`): pure resolution logic, the auth services, the
 *   middleware, and the source-tree guards. No DOM, no React.
 * - **jsdom** (`*.test.tsx`): the client seam added in M12 pass 2 —
 *   `useElectionAuth`, `useElectionWriter`, and the login page. These decide
 *   whether a write is signed by MetaMask or by the server relay, which is a
 *   security-relevant branch and too important to leave to a manual gate.
 *
 * `tsconfig.json` sets `jsx: "preserve"` for Next's own compiler, and Vite's
 * transform (oxc) honours it — which leaves raw JSX in the output and fails
 * import analysis. Overriding the runtime here is what makes `.tsx` tests
 * compile; without it every one of them dies with "invalid JS syntax".
 */
const shared = {
  resolve: { alias: { "~~": path.resolve(__dirname) } },
  oxc: { jsx: { runtime: "automatic" as const, importSource: "react" } },
};

export default defineConfig({
  ...shared,
  test: {
    projects: [
      {
        ...shared,
        test: {
          name: "node",
          environment: "node",
          include: ["**/*.test.ts"],
          exclude: ["node_modules/**", ".next/**", "e2e/**"],
          // The first test to import `viem/chains` pays for transforming it —
          // several seconds on a cold cache, which trips the 5s default.
          // Nothing here is actually slow; every subsequent case runs in
          // single-digit milliseconds.
          testTimeout: 30_000,
        },
      },
      {
        ...shared,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["**/*.test.tsx"],
          exclude: ["node_modules/**", ".next/**", "e2e/**"],
          setupFiles: ["./test/setup.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
