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
      //
      // Per-directory floors (TFE-011): the global thresholds are a loose ratchet
      // on the whole-app average, so a single new untested file can hide under it.
      // The glob-keyed entries below add local floors for directories that are
      // already uniformly well-covered, so a regression *within* one of those
      // areas fails CI even while the global average stays green. Vitest still
      // counts every file toward the global thresholds — the globs do NOT carve
      // files out of the global denominator (they only ADD a second, stricter
      // gate for the matched files). Each floor is set several points BELOW that
      // directory's current measured coverage so it passes today and only catches
      // future regressions. These are the directories that are uniformly
      // well-covered *recursively* (subdirectories included — the glob `**` matches
      // the whole subtree, unlike the non-recursive per-directory rows in the text
      // report). Measured 2026-09-17, recursive (glob: stmts/branch/func/lines):
      //   src/themes/**        99.42 / 93.39 / 100   / 100
      //   src/components/ui/** 94.85 / 92.66 / 92.65 / 96.57
      //   src/utils/**         93.72 / 91.01 / 96.17 / 94.67
      //   src/store/slices/**  85.19 / 68.63 / 86.80 / 86.22
      // (src/plugins is intentionally NOT floored: its direct files are 100% but
      // recursively the subtree is only ~85%, so it is not uniformly covered.)
      // Raise a floor (never lower) as its directory's coverage climbs.
      thresholds: {
        lines: 75,
        statements: 74,
        functions: 70,
        branches: 67,
        "src/themes/**": {
          statements: 95,
          branches: 88,
          functions: 97,
          lines: 97,
        },
        "src/components/ui/**": {
          statements: 90,
          branches: 86,
          functions: 86,
          lines: 92,
        },
        "src/utils/**": {
          statements: 88,
          branches: 85,
          functions: 90,
          lines: 90,
        },
        "src/store/slices/**": {
          statements: 80,
          branches: 62,
          functions: 80,
          lines: 80,
        },
      },
    },
  },
});
