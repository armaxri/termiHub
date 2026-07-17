import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";

import { resolveDevPort } from "./scripts/internal/dev-local.mjs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// Per-checkout dev port: TERMIHUB_DEV_PORT > dev.local.json's dev_port > 1420.
// Reading dev.local.json here (not just the env var) is what stops a bare
// `pnpm tauri dev` from silently binding checkout 0's 1420 in every parallel
// checkout (#1588). With no dev.local.json — a fresh clone, or CI — this is
// still plain 1420. The HMR websocket uses devPort + 1.
// See docs/testing.md → "Parallel test isolation".
const devPort = resolveDevPort();

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Exclude Rust build artifacts from dependency scanning
  optimizeDeps: {
    exclude: [],
    entries: ["src/**/*.{ts,tsx}"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: devPort,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: devPort + 1,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri` and Rust build artifacts
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
}));
