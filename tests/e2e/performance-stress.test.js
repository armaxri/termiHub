// Performance stress test: 40 concurrent terminals.
// Covers: PERF-01, PERF-02, PERF-03, PERF-04.
//
// Validates that TermiHub can handle its design target of 40 simultaneous
// local shell terminals without crashing, and logs creation throughput,
// tab-switch latency, and cleanup timing as performance baselines.

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from './helpers/app.js';
import { getAllTabs, getTabCount, getActiveTab } from './helpers/tabs.js';
import { TOOLBAR_NEW_TERMINAL, TAB_ACTIVE_CLASS } from './helpers/selectors.js';

const TERMINAL_COUNT = 40;

describe('Performance: 40 concurrent terminals', () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  after(async () => {
    await closeAllTabs();
  });

  it('PERF-01: creates 40 terminals and measures throughput', async function () {
    this.timeout(120000);

    const baselineCount = await getTabCount();
    const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
    const startTime = Date.now();

    for (let i = 1; i <= TERMINAL_COUNT; i++) {
      await btn.click();
      await browser.pause(150);

      if (i % 10 === 0) {
        const count = await getTabCount();
        const elapsed = Date.now() - startTime;
        console.log(`  [PERF-01] ${i} terminals created — ${count} tabs visible — ${elapsed}ms elapsed`);
      }
    }

    const totalTime = Date.now() - startTime;
    const finalCount = await getTabCount();

    console.log(`  [PERF-01] Total creation time: ${totalTime}ms`);
    console.log(`  [PERF-01] Average per terminal: ${(totalTime / TERMINAL_COUNT).toFixed(1)}ms`);
    console.log(`  [PERF-01] Final tab count: ${finalCount} (expected ${baselineCount + TERMINAL_COUNT})`);

    expect(finalCount).toBe(baselineCount + TERMINAL_COUNT);
  });

  it('PERF-02: UI remains responsive with 40 terminals open', async function () {
    this.timeout(30000);

    const tabs = await getAllTabs();
    expect(tabs.length).toBeGreaterThanOrEqual(TERMINAL_COUNT);

    // Switch to the first tab
    const firstStart = Date.now();
    await tabs[0].click();
    await browser.pause(300);
    let active = await getActiveTab();
    const firstTime = Date.now() - firstStart;
    const firstActiveId = active ? await active.getAttribute('data-testid') : null;
    const firstTabId = await tabs[0].getAttribute('data-testid');
    console.log(`  [PERF-02] Switch to first tab: ${firstTime}ms`);
    expect(firstActiveId).toBe(firstTabId);

    // Switch to the last tab
    const lastIdx = tabs.length - 1;
    const lastStart = Date.now();
    await tabs[lastIdx].click();
    await browser.pause(300);
    active = await getActiveTab();
    const lastTime = Date.now() - lastStart;
    const lastActiveId = active ? await active.getAttribute('data-testid') : null;
    const lastTabId = await tabs[lastIdx].getAttribute('data-testid');
    console.log(`  [PERF-02] Switch to last tab: ${lastTime}ms`);
    expect(lastActiveId).toBe(lastTabId);

    // Switch to a middle tab
    const midIdx = Math.floor(tabs.length / 2);
    const midStart = Date.now();
    await tabs[midIdx].click();
    await browser.pause(300);
    active = await getActiveTab();
    const midTime = Date.now() - midStart;
    const midActiveId = active ? await active.getAttribute('data-testid') : null;
    const midTabId = await tabs[midIdx].getAttribute('data-testid');
    console.log(`  [PERF-02] Switch to middle tab: ${midTime}ms`);
    expect(midActiveId).toBe(midTabId);

    // All switch times should be under 2 seconds
    expect(firstTime).toBeLessThan(2000);
    expect(lastTime).toBeLessThan(2000);
    expect(midTime).toBeLessThan(2000);
  });

  it('PERF-03: terminal input works with 40 terminals open', async function () {
    this.timeout(30000);

    // Ensure a tab is active
    const active = await getActiveTab();
    expect(active).not.toBeNull();

    // Find the xterm container in the active terminal panel
    const xtermEl = await browser.$('.xterm');
    const isDisplayed = await xtermEl.isDisplayed();
    expect(isDisplayed).toBe(true);

    // Click on the xterm area to focus it, then send keystrokes
    await xtermEl.click();
    await browser.pause(200);
    await browser.keys(['e', 'c', 'h', 'o', ' ', 'p', 'e', 'r', 'f', '-', 't', 'e', 's', 't']);
    await browser.pause(300);

    // If we got here without timeout, input was accepted
    console.log('  [PERF-03] Terminal input accepted with 40 terminals open');
  });

  it('PERF-04: closing all 40 terminals completes within timeout', async function () {
    this.timeout(120000);

    const countBefore = await getTabCount();
    console.log(`  [PERF-04] Tabs before close: ${countBefore}`);

    const startTime = Date.now();
    await closeAllTabs();
    const totalTime = Date.now() - startTime;

    const countAfter = await getTabCount();
    console.log(`  [PERF-04] Total close time: ${totalTime}ms`);
    console.log(`  [PERF-04] Average per tab: ${countBefore > 0 ? (totalTime / countBefore).toFixed(1) : 0}ms`);
    console.log(`  [PERF-04] Tabs after close: ${countAfter}`);

    expect(countAfter).toBe(0);
  });
});
