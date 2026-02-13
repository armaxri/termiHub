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

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

let tauriDriver;

function appBinaryPath() {
  if (process.platform === 'win32') {
    return './src-tauri/target/release/termihub.exe';
  }
  if (process.platform === 'darwin') {
    return './src-tauri/target/release/bundle/macos/TermiHub.app/Contents/MacOS/TermiHub';
  }
  return './src-tauri/target/release/termihub';
}

export const config = {
  runner: 'local',

  // Default specs: UI + local tests (excludes infrastructure/)
  specs: [
    './tests/e2e/*.test.js',
  ],

  exclude: [],

  // Named suites for selective runs
  suites: {
    ui: [
      './tests/e2e/connection-forms.test.js',
      './tests/e2e/connection-crud.test.js',
      './tests/e2e/tab-management.test.js',
      './tests/e2e/split-views.test.js',
      './tests/e2e/settings.test.js',
    ],
    local: [
      './tests/e2e/local-shell.test.js',
      './tests/e2e/file-browser-local.test.js',
    ],
    infra: [
      './tests/e2e/infrastructure/*.test.js',
    ],
  },

  maxInstances: 1,

  capabilities: [{
    maxInstances: 1,
    browserName: 'chrome',
    'goog:chromeOptions': {
      // Tell WebDriver to connect to the tauri-driver WebDriver proxy
      debuggerAddress: '127.0.0.1:4444',
    },
    'tauri:options': {
      application: appBinaryPath(),
    },
  }],

  framework: 'mocha',
  mochaOpts: {
    timeout: 60000,
  },

  reporters: ['spec'],

  services: [],

  // --- Hooks ---

  onPrepare() {
    // Start tauri-driver before all workers
    tauriDriver = spawn('tauri-driver', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    tauriDriver.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('error') || msg.includes('Error')) {
        console.error('[tauri-driver]', msg.trim());
      }
    });

    // Give tauri-driver time to start listening
    return sleep(500);
  },

  before: async function () {
    // Wait for the Tauri app to fully render
    await browser.pause(3000);
  },

  afterTest: async function (test, _context, { passed }) {
    if (!passed) {
      const timestamp = new Date().toISOString().replace(/:/g, '-');
      const safeName = test.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
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
  },

  logLevel: 'warn',
  bail: 0,
  baseUrl: '',
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
};
