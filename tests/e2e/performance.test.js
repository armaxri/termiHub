// Performance tests for termiHub.
// Validates the app can handle 40 concurrent terminals without degradation.
// Run with: pnpm test:e2e:perf

import { waitForAppReady, closeAllTabs } from './helpers/app.js';
import { getTabCount } from './helpers/tabs.js';
import { TOOLBAR_NEW_TERMINAL } from './helpers/selectors.js';

const TARGET_TERMINALS = 40;

describe('Performance: 40 concurrent terminals', () => {
  before(async () => {
    await waitForAppReady();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  it('PERF-01: should create 40 terminals via toolbar button', async () => {
    const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
    await btn.waitForClickable({ timeout: 5000 });

    for (let i = 0; i < TARGET_TERMINALS; i++) {
      await btn.click();
      // Short pause between clicks to avoid overwhelming the UI
      await browser.pause(150);
    }

    // Wait for all terminals to settle
    await browser.pause(2000);

    const count = await getTabCount();
    expect(count).toBe(TARGET_TERMINALS);
  });

  it('PERF-02: UI remains responsive with 40 terminals open', async () => {
    // First create 40 terminals
    const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
    await btn.waitForClickable({ timeout: 5000 });

    for (let i = 0; i < TARGET_TERMINALS; i++) {
      await btn.click();
      await browser.pause(150);
    }
    await browser.pause(2000);

    // Now measure creating one more terminal — should complete within 5 seconds
    const start = Date.now();
    await btn.click();
    await browser.pause(500);
    const elapsed = Date.now() - start;

    const count = await getTabCount();
    expect(count).toBe(TARGET_TERMINALS + 1);
    // The 41st terminal should be created promptly
    expect(elapsed).toBeLessThan(5000);
  });

  it('PERF-03: JS heap memory stays under 500 MB with 40 terminals', async () => {
    const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
    await btn.waitForClickable({ timeout: 5000 });

    for (let i = 0; i < TARGET_TERMINALS; i++) {
      await btn.click();
      await browser.pause(150);
    }
    await browser.pause(3000);

    // Query JS heap usage via Chrome DevTools protocol
    const metrics = await browser.execute(() => {
      if (window.performance && window.performance.memory) {
        return {
          usedJSHeapSize: window.performance.memory.usedJSHeapSize,
          totalJSHeapSize: window.performance.memory.totalJSHeapSize,
        };
      }
      return null;
    });

    if (metrics) {
      const usedMB = metrics.usedJSHeapSize / (1024 * 1024);
      console.log(`  JS heap used: ${usedMB.toFixed(1)} MB`);
      console.log(`  JS heap total: ${(metrics.totalJSHeapSize / (1024 * 1024)).toFixed(1)} MB`);
      expect(usedMB).toBeLessThan(500);
    } else {
      // performance.memory is only available in Chromium — skip on other engines
      console.log('  performance.memory not available, skipping heap check');
    }
  });

  it('PERF-04: closing all 40 terminals cleans up properly', async () => {
    const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
    await btn.waitForClickable({ timeout: 5000 });

    for (let i = 0; i < TARGET_TERMINALS; i++) {
      await btn.click();
      await browser.pause(150);
    }
    await browser.pause(2000);

    let count = await getTabCount();
    expect(count).toBe(TARGET_TERMINALS);

    // Close all tabs
    await closeAllTabs();

    count = await getTabCount();
    expect(count).toBe(0);
  });
});
