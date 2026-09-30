import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";

import { resolveDevPort } from "./scripts/internal/dev-local.mjs";
import { coveragePlugins } from "./scripts/internal/vite-coverage-plugin.mjs";

const host = process.env.TAURI_DEV_HOST;
// Per-checkout dev port: TERMIHUB_DEV_PORT > dev.local.json's dev_port > 1420.
// Reading dev.local.json here (not just the env var) is what stops a bare
// `pnpm tauri dev` from silently binding checkout 0's 1420 in every parallel
// checkout (#1588). With no dev.local.json — a fresh clone, or CI — this is
// still plain 1420. The HMR websocket uses devPort + 1.
// See docs/testing.md → "Parallel test isolation".
const devPort = resolveDevPort();

// Large, rarely-changing startup vendors split out of the entry chunk (#2883),
// so an app-code change does not invalidate their cached bytes and the webview
// can fetch them in parallel. Every group here is statically imported by the
// entry, so Vite emits `<link rel="modulepreload">` for each chunk: no waterfall,
// same startup bytes. Only add packages that are eager; a lazy-only package put
// in an eager group would be pulled into startup.
const VENDOR_CHUNKS: ReadonlyArray<readonly [string, RegExp]> = [
  ["vendor-react", /\/node_modules\/(react|react-dom|scheduler)\//],
  // `@xterm/addon-image` is excluded: it is lazily imported (inlineImages.ts)
  // and must stay in its own on-demand chunk.
  ["vendor-xterm", /\/node_modules\/@xterm\/(?!addon-image\/)/],
  ["vendor-icons", /\/node_modules\/(lucide-react|@lucide\/lab)\//],
  ["vendor-dnd", /\/node_modules\/@dnd-kit\//],
  [
    "vendor-radix",
    /\/node_modules\/(@radix-ui|@floating-ui|react-remove-scroll|react-remove-scroll-bar|react-style-singleton|use-callback-ref|use-sidecar|aria-hidden)\//,
  ],
];

function vendorChunk(id: string): string | undefined {
  for (const [name, pattern] of VENDOR_CHUNKS) {
    if (pattern.test(id)) return name;
  }
  return undefined;
}

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  // Istanbul instrumentation for the system-test harness's coverage (#3657):
  // an empty list unless TERMIHUB_FRONTEND_COVERAGE=1, so dev and release builds
  // are unchanged. It must precede react() so it sees the TypeScript source.
  plugins: [...(await coveragePlugins(fileURLToPath(new URL(".", import.meta.url)))), react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  build: {
    // Never inline a script as a `data:` URL: the shipped CSP's `script-src` has
    // no `data:`, so an inlined worker/module would be blocked at runtime (#3632 —
    // Monaco's 544-byte editor-worker stub was inlined this way). Other small
    // assets keep Vite's default 4 KiB inlining.
    assetsInlineLimit: (filePath: string) => (/\.[cm]?[jt]sx?$/.test(filePath) ? false : undefined),
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
      },
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
