import { defineConfig } from "vitest/config";

/**
 * Unit tests for the mobile app's non-React layer.
 *
 * Only `src/config.ts`, `src/services/api.ts` and `src/services/chain.ts` are
 * covered, and deliberately so: those three are the entire surface that decides
 * *what goes on the wire*. Everything else in this package is React Native
 * screens or Expo-native modules (SecureStore, LocalAuthentication, WebView),
 * which cannot run outside a device and whose behaviour the M13 gate checks by
 * hand instead.
 *
 * `environment: "node"` is correct even though this is a React Native package —
 * none of the modules under test import anything from `react-native`.
 */
export default defineConfig({
  test: {
    name: "mobile",
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "e2e/**", ".expo/**"],
    // A cold transform of viem costs several seconds; nothing here is slow.
    testTimeout: 30_000,
  },
});
