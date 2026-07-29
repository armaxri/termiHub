import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    // The default 5000ms testTimeout is too tight for the React-DOM `createRoot`
    // component tests when the runner is starved: the Windows CI job has been seen
    // spending 240s+ just on environment setup, leaving otherwise-instant tests
    // (immediately-resolving mocks, no real timers) to trip the timeout under load.
    // Bumping to 15s absorbs that jitter without hiding genuine hangs. See #1025.
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/test/**", "src/**/*.d.ts", "src/main.tsx"],
      // Modest coverage floors so a real regression fails CI without blocking
      // the current tree (#2066, follow-up to the #2050 audit). Measured on the
      // develop tree: statements 78.5%, branches 71.5%, functions 74.6%,
      // lines 79.7%. Each floor sits a few points below its measured value so
      // normal fluctuation passes but a genuine drop trips the gate. Raise these
      // (never lower) as coverage improves — they are a ratchet, not a target.
      thresholds: {
        lines: 75,
        statements: 74,
        functions: 70,
        branches: 67,
      },
    },
  },
});
