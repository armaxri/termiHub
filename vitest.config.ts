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
    },
  },
});
