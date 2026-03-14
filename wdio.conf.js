// wdio.conf.js — WebdriverIO config for Tauri E2E tests.
//
// Prerequisites:
//   1. Build the app: pnpm tauri build
//   2. Install tauri-driver: cargo install tauri-driver
//
// Usage:
//   pnpm test:e2e          — run UI + local tests
//   pnpm test:e2e:ui       — connection forms, CRUD, tabs, splits, settings (no backend needed)
//   pnpm test:e2e:local    — local shell + local file browser
//   pnpm test:e2e:infra    — SSH, serial, telnet (requires live servers)

import { spawn, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { waitForAppReady, ensureConnectionsSidebar, cleanupE2EConnections } from "./tests/e2e/helpers/app.js";

let tauriDriver;
let xvfb;

const DISPLAY_NUM = ":99";

function appBinaryPath() {
  if (process.platform === "win32") {
    return "./target/release/termihub.exe";
  }
  if (process.platform === "darwin") {
    return "./target/release/bundle/macos/termiHub.app/Contents/MacOS/termiHub";
  }
  return "./target/release/termihub";
}

export const config = {
  runner: "local",

  // Default specs: UI + local tests (excludes infrastructure/)
  specs: ["./tests/e2e/*.test.js"],

  exclude: [],

  // Named suites for selective runs
  suites: {
    ui: [
      "./tests/e2e/connection-forms.test.js",
      "./tests/e2e/connection-crud.test.js",
      "./tests/e2e/connection-editor-extended.test.js",
      "./tests/e2e/tab-management.test.js",
      "./tests/e2e/tab-horizontal-scroll.test.js",
      "./tests/e2e/split-views.test.js",
      "./tests/e2e/settings.test.js",
      "./tests/e2e/sidebar-toggle.test.js",
      "./tests/e2e/sidebar-sections.test.js",
      "./tests/e2e/theme-layout.test.js",
      "./tests/e2e/ui-state.test.js",
      "./tests/e2e/ssh-tunnels.test.js",
      "./tests/e2e/ssh-agent-warning.test.js",
      "./tests/e2e/credential-store.test.js",
      "./tests/e2e/encrypted-export-import.test.js",
      "./tests/e2e/external-files.test.js",
      "./tests/e2e/cross-platform.test.js",
    ],
    local: [
      "./tests/e2e/local-shell.test.js",
      "./tests/e2e/local-shell-extended.test.js",
      "./tests/e2e/file-browser-local.test.js",
      "./tests/e2e/file-browser-extended.test.js",
      "./tests/e2e/editor.test.js",
    ],
    infra: ["./tests/e2e/infrastructure/*.test.js"],
    perf: ["./tests/e2e/performance.test.js"],
  },

  // Point WDIO directly at the tauri-driver WebDriver server (port 4444).
  // tauri-driver acts as a WebDriver proxy in front of the native driver
  // (WebKitWebDriver on Linux, WebView2 on Windows). Do NOT use
  // goog:chromeOptions.debuggerAddress — that attaches to an already-running
  // Chrome DevTools port, which is unrelated to tauri-driver.
  hostname: "localhost",
  port: 4444,
  path: "/",

  maxInstances: 1,

  capabilities: [
    {
      maxInstances: 1,
      "tauri:options": {
        application: appBinaryPath(),
      },
    },
  ],

  framework: "mocha",
  mochaOpts: {
    timeout: 60000,
  },

  reporters: ["spec"],

  services: [],

  // --- Hooks ---

  async onPrepare() {
    // On Linux/WSL2 there is no display server by default. Start Xvfb so that
    // WebKitWebDriver (and the Tauri app) have a virtual framebuffer to render
    // into. If DISPLAY is already set (e.g. a real desktop), skip Xvfb.
    if (!process.env.DISPLAY) {
      process.env.DISPLAY = DISPLAY_NUM;
      xvfb = spawn("Xvfb", [DISPLAY_NUM, "-screen", "0", "1280x800x24"], {
        stdio: "ignore",
      });
      xvfb.on("error", (err) =>
        console.error("[xvfb]", err.message),
      );
      // Give Xvfb time to initialise before anything tries to connect
      await sleep(1000);
    }

    // Start tauri-driver before all workers.
    // Pass --native-driver with the absolute path so tauri-driver can find
    // WebKitWebDriver even when /usr/bin is not on Node.js's PATH (WSL2).
    const nativeDriver =
      process.env.WEBKIT_DRIVER_PATH ||
      (() => {
        try {
          return execFileSync("which", ["WebKitWebDriver"], {
            encoding: "utf8",
          }).trim();
        } catch {
          return "WebKitWebDriver";
        }
      })();
    tauriDriver = spawn("tauri-driver", ["--native-driver", nativeDriver], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    tauriDriver.stderr.on("data", (data) => {
      console.error("[tauri-driver]", data.toString().trim());
    });

    tauriDriver.on("error", (err) =>
      console.error("[tauri-driver] failed to start:", err.message),
    );

    tauriDriver.on("exit", (code) => {
      if (code !== null && code !== 0) {
        console.error("[tauri-driver] exited with code", code);
      }
    });

    // Give tauri-driver time to start listening on port 4444
    await sleep(1500);
  },

  before: async function () {
    // Wait for the Tauri app to fully render (longer under Xvfb/WebKitGTK)
    await browser.pause(5000);
    // Dismiss any "Configuration Recovery" dialog that may appear on startup
    // (e.g., if the connections.json was corrupt or had an unexpected format).
    const recoveryOkBtn = await browser.$('[data-testid="recovery-dialog-close"]');
    const recoveryVisible = await recoveryOkBtn.isDisplayed().catch(() => false);
    if (recoveryVisible) {
      await recoveryOkBtn.click();
      await browser.pause(500);
    }
    // Ensure the connections sidebar is visible
    await waitForAppReady();
    await ensureConnectionsSidebar();
    // Remove E2E connections left over from previous test runs so each worker
    // starts with a clean connection list and findConnectionByName is fast.
    await cleanupE2EConnections();
  },

  afterTest: async function (test, _context, { passed }) {
    if (!passed) {
      const timestamp = new Date().toISOString().replace(/:/g, "-");
      const safeName = test.title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
      const filename = `./test-results/screenshots/${safeName}-${timestamp}.png`;
      try {
        await browser.saveScreenshot(filename);
      } catch {
        // Screenshot may fail if the app crashed — ignore
      }
    }
  },

  onComplete() {
    if (tauriDriver) {
      tauriDriver.kill();
      tauriDriver = null;
    }
    if (xvfb) {
      xvfb.kill();
      xvfb = null;
    }
  },

  logLevel: "warn",
  bail: 0,
  baseUrl: "",
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
};
