/**
 * Rendered visual checks (#4712): the real Vite frontend, booted in headless
 * Chromium against the in-browser IPC mock (tests/visual/harness/), audited at
 * several window and sidebar sizes. See docs/testing.md → "Rendered visual
 * checks".
 */

import { defineConfig, devices } from "@playwright/test";

import { resolveDevPort } from "../../scripts/internal/dev-local.mjs";

// Per-checkout port (docs/testing.md → "Parallel test isolation"): this
// checkout's dev port + 5, so parallel checkouts never share a server and the
// visual server never collides with `scripts/dev.sh` (dev port, HMR on +1).
const port = Number(process.env.TERMIHUB_VISUAL_PORT ?? resolveDevPort() + 5);

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  outputDir: "test-results",
  globalTeardown: "./globalTeardown.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 120_000,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${port}`,
    // Skip enter/exit animations so a dialog is measured at its final size.
    contextOptions: { reducedMotion: "reduce" },
  },
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    cwd: "../..",
    url: `http://localhost:${port}/tests/visual/harness/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
