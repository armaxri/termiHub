import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// Allow running multiple dev instances in parallel by setting TERMIHUB_DEV_PORT.
// The HMR websocket uses devPort + 1. See scripts/dev.sh for how to configure this.
// @ts-expect-error process is a nodejs global
const devPort = parseInt(process.env.TERMIHUB_DEV_PORT ?? "1420", 10);

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
