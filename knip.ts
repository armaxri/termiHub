import type { KnipConfig } from "knip";

// Two report modes (DEAD2-006, #4371), both advisory in CI:
//
// - `pnpm knip` (default) also treats the test files as entries, so it reports
//   code that nothing at all uses — not even a test — plus value exports that
//   are only used inside their own file (they should lose `export`).
// - `pnpm knip:prod` (`knip --production`) only follows the `!`-suffixed
//   patterns below, so test files and test doubles are NOT entries. An export
//   whose only importer is its own unit test is then reported as dead
//   production code. Exports also used inside their own file are not reported
//   in this mode: exporting a helper the module itself calls so a unit test can
//   reach it is a test seam, not dead code. Test-only hooks a module exports
//   for its tests (reset/seed/transport overrides, ...) carry an `@internal`
//   JSDoc tag, which production mode skips.
const production = process.argv.includes("--production") || process.argv.includes("--strict");

const config: KnipConfig = {
  // src/test/setup.ts is picked up automatically by knip's vitest plugin
  // (setupFiles) and src/main.tsx by the vite plugin (index.html). Plugins do
  // not contribute production entries, so production mode lists main.tsx.
  entry: [
    ...(production ? ["src/main.tsx!"] : []),
    "src/**/*.test.{ts,tsx}",
    // Loaded dynamically in E2E/dev builds only (never statically imported).
    "src/testbridge/**/*.{ts,tsx}!",
    // Shared test doubles/harnesses; consumed by the test files above.
    "src/test/**/*.{ts,tsx}",
  ],
  // In production mode tests and test doubles are not project files either, so
  // they are neither analysed nor reported as unused.
  project: ["src/**/*.{ts,tsx}!", "!src/**/*.test.{ts,tsx}!", "!src/test/**!"],
  // Generated from Rust by ts-rs; the full set is emitted whether or not the
  // frontend uses every binding, so unused files/exports there are expected.
  ignore: ["src/types/generated/**"],
  ignoreIssues: {
    // The shared UI primitive kit (UI Modernization) exports each primitive's
    // props/variant types from its barrel as part of the documented import
    // surface, whether or not a call site names them yet.
    "src/components/ui/index.ts": ["types"],
    "src/components/ui/Toast/index.ts": ["types"],
  },
  // A type/interface exported next to the function or component that uses it
  // documents that symbol's signature (props, options, results) and lets a
  // future caller name it. Un-exporting such types removes no code, so they
  // are not reported. In default mode values are still reported: an exported
  // constant or function only used in its own file should lose its `export`.
  ignoreExportsUsedInFile: production ? true : { interface: true, type: true },
  vite: {
    config: ["vite.config.ts", "vitest.config.ts"],
  },
};

export default config;
