// wdio.conf.js
export const config = {
  // Test runner
  runner: 'local',

  // Tauri application path
  specs: [
    './tests/e2e/**/*.test.js'
  ],

  exclude: [],

  // Maximum instances to run in parallel
  maxInstances: 1, // Tauri apps should run one at a time

  capabilities: [{
    maxInstances: 1,
    browserName: 'tauri',
    'tauri:options': {
      application: process.platform === 'win32'
        ? './src-tauri/target/release/termihub.exe'
        : process.platform === 'darwin'
          ? './src-tauri/target/release/bundle/macos/TermiHub.app/Contents/MacOS/TermiHub'
          : './src-tauri/target/release/termihub',
    },
  }],

  // Test framework
  framework: 'mocha',
  mochaOpts: {
    timeout: 60000, // 60 seconds for Tauri app startup
  },

  // Reporters
  reporters: [
    'spec',
    ['html', {
      outputDir: './test-results/e2e',
      filename: 'report.html',
    }],
  ],

  // Services
  services: [
    ['tauri', {
      // Binary path (optional, auto-detected)
      // applicationPath: './src-tauri/target/release/termihub'
    }],
  ],

  // Hooks
  beforeSession: function (config, capabilities, specs) {
    // Build Tauri app before tests
    require('child_process').execSync('npm run tauri build', {
      stdio: 'inherit',
    });
  },

  before: async function (capabilities, specs) {
    // Wait for app to be ready
    await browser.pause(2000);
  },

  afterTest: async function (test, context, { error, result, duration, passed, retries }) {
    // Take screenshot on failure
    if (!passed) {
      const timestamp = new Date().toISOString().replace(/:/g, '-');
      const filename = `./test-results/screenshots/${test.title}-${timestamp}.png`;
      await browser.saveScreenshot(filename);
    }
  },

  // Logging
  logLevel: 'info',
  bail: 0,
  baseUrl: '',
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
};
