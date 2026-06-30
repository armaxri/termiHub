// wdio.conf.js — WebdriverIO config for Tauri E2E tests.
//
// Prerequisites:
//   1. Build the app: pnpm tauri build
//   2. Install tauri-driver: cargo install tauri-driver
//
// Usage:
//   pnpm test:e2e          — run any UI specs under tests/e2e/*.test.js
//
// The infrastructure, UI, local, and performance specs were all ported to the
// Python bridge harness (tests/system/, epic #799); the named wdio suites were
// retired with them (#1015). This config is the remaining scaffold for future
// tauri-driver UI specs — the helpers under tests/e2e/helpers/ stay for them.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { waitForAppReady, ensureConnectionsSidebar } from "./tests/e2e/helpers/app.js";

let tauriDriver;
let xvfb;
let e2eConfigDir;

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

  // Picks up any UI specs placed under tests/e2e/. All previously-shipped
  // specs (UI, local, infrastructure, performance) were ported to the Python
  // bridge harness (tests/system/) and removed — see epic #799.
  specs: ["./tests/e2e/*.test.js"],

  exclude: [],

  // Point WDIO directly at the tauri-driver WebDriver server (port 4444).
  // tauri-driver acts as a WebDriver proxy in front of the native driver
  // (WebKitWebDriver on Linux, WebView2 on Windows). Do NOT use
  // goog:chromeOptions.debuggerAddress — that attaches to an already-running
  // Chrome DevTools port, which is unrelated to tauri-driver.
  hostname: "localhost",
  // Per-checkout offset (docs/testing.md "Parallel test isolation") so several
  // checkouts' tauri-driver instances don't all fight over 4444. Falls back to
  // 4444 when TERMIHUB_TAURI_DRIVER_PORT is unset (the resolver exports it).
  port: parseInt(process.env.TERMIHUB_TAURI_DRIVER_PORT || "4444", 10),
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
    // Create a fresh isolated config directory for this test run so the app
    // starts with no connections or credentials. This avoids leftover state
    // from previous runs and keeps the connection list short and fast.
    e2eConfigDir = mkdtempSync(join(tmpdir(), "termihub-e2e-"));
    process.env.TERMIHUB_CONFIG_DIR = e2eConfigDir;

    // On Linux/WSL2 there is no display server by default. Start Xvfb so that
    // WebKitWebDriver (and the Tauri app) have a virtual framebuffer to render
    // into. If DISPLAY is already set (e.g. a real desktop), skip Xvfb.
    if (!process.env.DISPLAY) {
      process.env.DISPLAY = DISPLAY_NUM;
      xvfb = spawn("Xvfb", [DISPLAY_NUM, "-screen", "0", "1280x800x24"], {
        stdio: "ignore",
      });
      xvfb.on("error", (err) => console.error("[xvfb]", err.message));
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
    const driverPort = process.env.TERMIHUB_TAURI_DRIVER_PORT || "4444";
    tauriDriver = spawn("tauri-driver", ["--port", driverPort, "--native-driver", nativeDriver], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    tauriDriver.stderr.on("data", (data) => {
      console.error("[tauri-driver]", data.toString().trim());
    });

    tauriDriver.on("error", (err) => console.error("[tauri-driver] failed to start:", err.message));

    tauriDriver.on("exit", (code) => {
      if (code !== null && code !== 0) {
        console.error("[tauri-driver] exited with code", code);
      }
    });

    // Give tauri-driver time to start listening on port 4444
    await sleep(1500);
  },

  before: async function () {
    // Wait for the Tauri app to fully render (longer under Xvfb/WebKitGTK).
    // A freshly-built binary with a large JS bundle can take 15–20s for
    // WebKitGTK to parse and execute under Xvfb; once the bundle is in the
    // WebKit disk cache subsequent runs are faster.
    await browser.pause(8000);
    // Ensure the connections sidebar is visible
    await waitForAppReady();
    await ensureConnectionsSidebar();
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
    // Clean up the isolated config directory created for this test run
    if (e2eConfigDir) {
      try {
        rmSync(e2eConfigDir, { recursive: true, force: true });
      } catch {
        // Non-fatal — OS will clean it up eventually
      }
      e2eConfigDir = null;
    }
  },

  logLevel: "warn",
  bail: 0,
  baseUrl: "",
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
};
