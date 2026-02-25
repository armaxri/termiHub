// Monitoring-related helpers for infrastructure E2E tests.

import {
  MONITORING_CONNECT_BTN,
  MONITORING_LOADING,
  MONITORING_HOST,
  MONITORING_CPU,
  MONITORING_MEM,
  MONITORING_DISK,
  MONITORING_REFRESH,
  MONITORING_DISCONNECT,
  MONITORING_ERROR,
} from "./selectors.js";

/**
 * Check whether any monitoring UI element is present in the DOM.
 * Monitoring may be in connect-button, loading, or connected state.
 * @returns {Promise<boolean>}
 */
export async function isMonitoringVisible() {
  const btn = await browser.$(MONITORING_CONNECT_BTN);
  if (await btn.isExisting()) return true;
  const loading = await browser.$(MONITORING_LOADING);
  if (await loading.isExisting()) return true;
  const host = await browser.$(MONITORING_HOST);
  if (await host.isExisting()) return true;
  return false;
}

/**
 * Wait for monitoring stats (host, CPU, mem, disk) to appear.
 * @param {number} timeout - Max wait time in ms (default 15000)
 * @returns {Promise<boolean>} true if stats appeared
 */
export async function waitForMonitoringStats(timeout = 15000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const host = await browser.$(MONITORING_HOST);
    if ((await host.isExisting()) && (await host.isDisplayed())) {
      return true;
    }
    await browser.pause(500);
  }
  return false;
}

/**
 * Read the monitoring host text from the status bar.
 * @returns {Promise<string|null>}
 */
export async function getMonitoringHost() {
  const host = await browser.$(MONITORING_HOST);
  if (await host.isExisting()) {
    return host.getText();
  }
  return null;
}

/**
 * Read CPU/Mem/Disk values from monitoring stats.
 * @returns {Promise<{cpu: string, mem: string, disk: string}|null>}
 */
export async function getMonitoringStats() {
  const cpu = await browser.$(MONITORING_CPU);
  const mem = await browser.$(MONITORING_MEM);
  const disk = await browser.$(MONITORING_DISK);

  if (!(await cpu.isExisting())) return null;

  return {
    cpu: await cpu.getText(),
    mem: await mem.getText(),
    disk: await disk.getText(),
  };
}

/**
 * Open the monitoring detail dropdown by clicking the host button.
 */
export async function openMonitoringDropdown() {
  const host = await browser.$(MONITORING_HOST);
  await host.waitForDisplayed({ timeout: 5000 });
  await host.click();
  await browser.pause(300);
}

/**
 * Click the monitoring refresh button inside the dropdown.
 */
export async function clickMonitoringRefresh() {
  const btn = await browser.$(MONITORING_REFRESH);
  await btn.waitForDisplayed({ timeout: 3000 });
  await btn.click();
  await browser.pause(500);
}

/**
 * Click the monitoring disconnect button inside the dropdown.
 */
export async function clickMonitoringDisconnect() {
  const btn = await browser.$(MONITORING_DISCONNECT);
  await btn.waitForDisplayed({ timeout: 3000 });
  await btn.click();
  await browser.pause(500);
}
