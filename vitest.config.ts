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
      // Include BOTH .ts and .tsx: the old `src/**/*.ts` glob silently excluded
      // every React component (.tsx) from the denominator, so untested components
      // could not lower the percentage and the gate under-counted the whole UI
      // (TOOL-002). `src/main.tsx` stays excluded as the entry point — that
      // exclude was previously inert because .tsx was never included at all.
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/test/**", "src/**/*.d.ts", "src/main.tsx"],
      // Emit lcov (for the unified whole-app merge in scripts/coverage.sh,
      // TOOL-001) alongside the human-readable text + html reports.
      reporter: ["text", "html", "lcov"],
      // Modest coverage floors so a real regression fails CI without blocking
      // the current tree (#2066, follow-up to the #2050 audit). RE-MEASURED
      // after the .tsx glob fix (TOOL-002): folding every React component into
      // the denominator moved the honest numbers to statements 77.5%, branches
      // 69.4%, functions 73.9%, lines 78.8% — the components turned out to be
      // well-covered, so the numbers barely moved and STILL clear these floors.
      // The thresholds are therefore left unchanged (each still sits a few
      // points below its measured value). Raise these (never lower) as coverage
      // improves — they are a ratchet, not a target.
      thresholds: {
        lines: 75,
        statements: 74,
        functions: 70,
        branches: 67,
      },
    },
  },
});
