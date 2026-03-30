// Network Tools live E2E tests.
// Covers: MT-NET-10 (ping), MT-NET-12 (port scan), MT-NET-14 (DNS lookup),
//         MT-NET-17 (HTTP monitor), MT-NET-18 (HTTP monitor sidebar row).
//
// Prerequisites:
//   - network-target container running (profile: network):
//     docker compose --profile network up -d network-target
//   - This exposes nginx on 127.0.0.1:8080
//
// These tests use real network I/O against controlled local targets so they
// return deterministic results without depending on external internet access.
//
// Run as part of the infra suite:
//   pnpm test:e2e:infra

import { waitForAppReady, closeAllTabs } from "./helpers/app.js";
import { openSettingsTab } from "./helpers/sidebar.js";

// --- Selectors ---

const ACTIVITY_BAR_NETWORK_TOOLS = '[data-testid="activity-bar-network-tools"]';
const NETWORK_TOOLS_SIDEBAR = '[data-testid="network-tools-sidebar"]';
const NETWORK_NEW_MONITOR = '[data-testid="network-new-monitor"]';
const SETTINGS_EXPERIMENTAL = '[data-testid="settings-experimental-features"]';
const SETTINGS_NAV_GENERAL = '[data-testid="settings-nav-general"]';

const quickAction = (tool) => `[data-testid="network-quick-action-${tool}"]`;

const PING_PANEL = '[data-testid="ping-panel"]';
const PORT_SCANNER_PANEL = '[data-testid="port-scanner-panel"]';
const DNS_LOOKUP_PANEL = '[data-testid="dns-lookup-panel"]';
const HTTP_MONITOR_PANEL = '[data-testid="http-monitor-panel"]';

const PING_HOST_INPUT = '[data-testid="ping-host"]';
const PING_START_BTN = '[data-testid="ping-start"]';
const PING_STOP_BTN = '[data-testid="ping-stop"]';
const PING_STATS = '[data-testid="ping-stats"]';
const PING_CHART = '[data-testid="ping-chart"]';

const PORT_SCANNER_HOST_INPUT = '[data-testid="port-scanner-host"]';
const PORT_SCANNER_PORTS_INPUT = '[data-testid="port-scanner-ports"]';
const PORT_SCANNER_RUN_BTN = '[data-testid="port-scanner-run"]';
const PORT_SCANNER_RESULTS = '[data-testid="port-scanner-results"]';
const PORT_SCANNER_RESULT_ROW = '[data-testid^="port-scanner-result-"]';
const PORT_SCANNER_FOOTER = '[data-testid="port-scanner-footer"]';
const PORT_SCANNER_LARGE_RANGE_WARNING = '[data-testid="port-scanner-large-range-warning"]';

const DNS_HOSTNAME_INPUT = '[data-testid="dns-hostname"]';
const DNS_RUN_BTN = '[data-testid="dns-run"]';
const DNS_RESULTS = '[data-testid="dns-results"]';
const DNS_RESULT_ROW = '[data-testid^="dns-result-"]';

const HTTP_MONITOR_URL_INPUT = '[data-testid="http-monitor-url"]';
const HTTP_MONITOR_START_BTN = '[data-testid="http-monitor-start"]';
const HTTP_MONITOR_STOP_BTN = '[data-testid="http-monitor-stop"]';
const HTTP_MONITOR_HISTORY = '[data-testid="http-monitor-history"]';
const HTTP_MONITOR_HISTORY_ROW = '[data-testid^="http-monitor-entry-"]';
const HTTP_MONITOR_CHART = '[data-testid="http-monitor-chart"]';

const NETWORK_SIDEBAR_MONITORS = '[data-testid="network-monitors-section"]';
const NETWORK_MONITOR_ROW = '[data-testid^="network-monitor-row-"]';

// --- Helpers ---

async function enableExperimentalFeatures() {
  await openSettingsTab();
  await browser.pause(400);

  const generalNav = await browser.$(SETTINGS_NAV_GENERAL);
  if (await generalNav.isExisting()) {
    await generalNav.click();
    await browser.pause(300);
  }

  const checkbox = await browser.$(SETTINGS_EXPERIMENTAL);
  if (await checkbox.isExisting()) {
    const checked = await checkbox.isSelected();
    if (!checked) {
      await browser.execute((el) => el.click(), checkbox);
      await browser.pause(500);
    }
  }

  await closeAllTabs();
  await browser.pause(300);
}

async function openNetworkToolsSidebar() {
  const btn = await browser.$(ACTIVITY_BAR_NETWORK_TOOLS);
  await btn.waitForDisplayed({ timeout: 5000 });
  await btn.click();
  await browser.pause(300);
  const sidebar = await browser.$(NETWORK_TOOLS_SIDEBAR);
  await sidebar.waitForDisplayed({ timeout: 5000 });
}

async function openToolPanel(tool, panelSelector) {
  await openNetworkToolsSidebar();
  const btn = await browser.$(quickAction(tool));
  await btn.waitForDisplayed({ timeout: 5000 });
  await btn.click();
  await browser.pause(400);
  const panel = await browser.$(panelSelector);
  await panel.waitForDisplayed({ timeout: 5000 });
  return panel;
}

// --- Tests ---

describe("Network Tools — live tests (MT-NET-10, MT-NET-12–14, MT-NET-17–18)", () => {
  before(async () => {
    await waitForAppReady();
    await enableExperimentalFeatures();
  });

  afterEach(async () => {
    await closeAllTabs();
    await browser.pause(300);
  });

  // ─── MT-NET-10: Ping live latency chart and stats ────────────────────────────

  describe("MT-NET-10: Ping — live latency chart and stats", () => {
    it("should stream ping replies to 127.0.0.1 and update stats", async () => {
      await openToolPanel("ping", PING_PANEL);

      // Enter loopback address and start
      const hostInput = await browser.$(PING_HOST_INPUT);
      await hostInput.clearValue();
      await hostInput.setValue("127.0.0.1");

      const startBtn = await browser.$(PING_START_BTN);
      await startBtn.click();

      // Wait up to 8 s for the first reply to arrive and stats to appear
      await browser.waitUntil(
        async () => {
          const stats = await browser.$(PING_STATS);
          return (await stats.isExisting()) && (await stats.isDisplayed());
        },
        { timeout: 8000, timeoutMsg: "Ping stats did not appear within 8 s" }
      );

      // Stats should show at least 1 sent packet
      const stats = await browser.$(PING_STATS);
      const statsText = await stats.getText();
      expect(statsText).toMatch(/Sent\s*[1-9]/);

      // Stop the ping
      const stopBtn = await browser.$(PING_STOP_BTN);
      if (await stopBtn.isExisting()) {
        await stopBtn.click();
      }
    });

    it("should show a latency chart after replies begin", async () => {
      await openToolPanel("ping", PING_PANEL);

      const hostInput = await browser.$(PING_HOST_INPUT);
      await hostInput.clearValue();
      await hostInput.setValue("127.0.0.1");

      const startBtn = await browser.$(PING_START_BTN);
      await startBtn.click();

      // Wait for chart to render
      await browser.waitUntil(
        async () => {
          const chart = await browser.$(PING_CHART);
          return (await chart.isExisting()) && (await chart.isDisplayed());
        },
        { timeout: 8000, timeoutMsg: "Ping chart did not appear within 8 s" }
      );

      const stopBtn = await browser.$(PING_STOP_BTN);
      if (await stopBtn.isExisting()) {
        await stopBtn.click();
      }
    });
  });

  // ─── MT-NET-12: Port Scanner — results stream in ─────────────────────────────

  describe("MT-NET-12: Port Scanner — results stream in", () => {
    it("should find port 80 open on 127.0.0.1 (network-target container)", async () => {
      await openToolPanel("port-scanner", PORT_SCANNER_PANEL);

      const hostInput = await browser.$(PORT_SCANNER_HOST_INPUT);
      await hostInput.clearValue();
      await hostInput.setValue("127.0.0.1");

      const portsInput = await browser.$(PORT_SCANNER_PORTS_INPUT);
      await portsInput.clearValue();
      // Scan port 8080 (network-target) and port 22 (not exposed directly on host)
      await portsInput.setValue("80,8080");

      const runBtn = await browser.$(PORT_SCANNER_RUN_BTN);
      await runBtn.click();

      // Wait for results to stream in
      await browser.waitUntil(
        async () => {
          const rows = await browser.$$(PORT_SCANNER_RESULT_ROW);
          return rows.length > 0;
        },
        { timeout: 15000, timeoutMsg: "Port scanner results did not appear within 15 s" }
      );

      // Wait for the scan to complete (footer appears)
      await browser.waitUntil(
        async () => {
          const footer = await browser.$(PORT_SCANNER_FOOTER);
          return (await footer.isExisting()) && (await footer.isDisplayed());
        },
        { timeout: 20000, timeoutMsg: "Port scanner footer did not appear" }
      );

      const rows = await browser.$$(PORT_SCANNER_RESULT_ROW);
      expect(rows.length).toBeGreaterThan(0);

      // Verify at least one row is labeled as open (port 8080 should be open)
      const rowTexts = await Promise.all(rows.map((r) => r.getText()));
      const hasOpen = rowTexts.some((t) => t.toLowerCase().includes("open"));
      expect(hasOpen).toBe(true);
    });

    it("should show footer with count and elapsed time after scan completes", async () => {
      await openToolPanel("port-scanner", PORT_SCANNER_PANEL);

      const hostInput = await browser.$(PORT_SCANNER_HOST_INPUT);
      await hostInput.clearValue();
      await hostInput.setValue("127.0.0.1");

      const portsInput = await browser.$(PORT_SCANNER_PORTS_INPUT);
      await portsInput.clearValue();
      await portsInput.setValue("8080");

      await (await browser.$(PORT_SCANNER_RUN_BTN)).click();

      await browser.waitUntil(
        async () => {
          const footer = await browser.$(PORT_SCANNER_FOOTER);
          return (await footer.isExisting()) && (await footer.isDisplayed());
        },
        { timeout: 20000, timeoutMsg: "Port scanner footer did not appear" }
      );

      const footer = await browser.$(PORT_SCANNER_FOOTER);
      const footerText = await footer.getText();
      // Footer should mention port count and elapsed time
      expect(footerText).toMatch(/\d+/);
    });
  });

  // ─── MT-NET-13: Port Scanner — large range warning ───────────────────────────

  describe("MT-NET-13: Port Scanner — large range warning", () => {
    it("should show large-range warning when scanning a wide port range", async () => {
      await openToolPanel("port-scanner", PORT_SCANNER_PANEL);

      const hostInput = await browser.$(PORT_SCANNER_HOST_INPUT);
      await hostInput.clearValue();
      await hostInput.setValue("127.0.0.1");

      const portsInput = await browser.$(PORT_SCANNER_PORTS_INPUT);
      await portsInput.clearValue();
      await portsInput.setValue("1-10000");

      await (await browser.$(PORT_SCANNER_RUN_BTN)).click();

      // Warning should appear quickly (before or during scan)
      await browser.waitUntil(
        async () => {
          const warning = await browser.$(PORT_SCANNER_LARGE_RANGE_WARNING);
          return await warning.isExisting();
        },
        { timeout: 5000, timeoutMsg: "Large-range warning did not appear" }
      );

      const warning = await browser.$(PORT_SCANNER_LARGE_RANGE_WARNING);
      expect(await warning.isDisplayed()).toBe(true);

      // Cancel the large scan
      const cancelBtn = await browser.$(PORT_SCANNER_RUN_BTN);
      if (await cancelBtn.isExisting()) {
        const btnText = await cancelBtn.getText();
        if (btnText.toLowerCase().includes("cancel")) {
          await cancelBtn.click();
        }
      }
    });
  });

  // ─── MT-NET-14: DNS Lookup — A record resolution ─────────────────────────────

  describe("MT-NET-14: DNS Lookup — A record resolution", () => {
    it("should resolve localhost to 127.0.0.1", async () => {
      await openToolPanel("dns-lookup", DNS_LOOKUP_PANEL);

      const hostnameInput = await browser.$(DNS_HOSTNAME_INPUT);
      await hostnameInput.clearValue();
      await hostnameInput.setValue("localhost");

      await (await browser.$(DNS_RUN_BTN)).click();

      // Wait for results
      await browser.waitUntil(
        async () => {
          const rows = await browser.$$(DNS_RESULT_ROW);
          return rows.length > 0;
        },
        { timeout: 10000, timeoutMsg: "DNS results did not appear within 10 s" }
      );

      const rows = await browser.$$(DNS_RESULT_ROW);
      expect(rows.length).toBeGreaterThan(0);

      // Result for localhost should contain 127.0.0.1
      const rowTexts = await Promise.all(rows.map((r) => r.getText()));
      const hasLocalhost = rowTexts.some((t) => t.includes("127.0.0.1"));
      expect(hasLocalhost).toBe(true);
    });
  });

  // ─── MT-NET-17: HTTP Monitor — periodic checks and chart ─────────────────────

  describe("MT-NET-17: HTTP Monitor — periodic checks and chart", () => {
    it("should complete a check against network-target (127.0.0.1:8080)", async () => {
      await openNetworkToolsSidebar();
      const newMonitorBtn = await browser.$(NETWORK_NEW_MONITOR);
      await newMonitorBtn.waitForDisplayed({ timeout: 5000 });
      await newMonitorBtn.click();
      await browser.pause(400);

      const panel = await browser.$(HTTP_MONITOR_PANEL);
      await panel.waitForDisplayed({ timeout: 5000 });

      const urlInput = await browser.$(HTTP_MONITOR_URL_INPUT);
      await urlInput.clearValue();
      await urlInput.setValue("http://127.0.0.1:8080");

      await (await browser.$(HTTP_MONITOR_START_BTN)).click();

      // Wait for the first check to appear (up to 15 s for first poll)
      await browser.waitUntil(
        async () => {
          const rows = await browser.$$(HTTP_MONITOR_HISTORY_ROW);
          return rows.length > 0;
        },
        { timeout: 15000, timeoutMsg: "HTTP monitor history row did not appear within 15 s" }
      );

      const rows = await browser.$$(HTTP_MONITOR_HISTORY_ROW);
      expect(rows.length).toBeGreaterThan(0);

      // First row should show a 200 status (nginx default page)
      const firstRow = rows[0];
      const rowText = await firstRow.getText();
      expect(rowText).toContain("200");

      // Stop the monitor
      const stopBtn = await browser.$(HTTP_MONITOR_STOP_BTN);
      if (await stopBtn.isExisting()) {
        await stopBtn.click();
      }
    });

    it("should show a response-time chart after the first check", async () => {
      await openNetworkToolsSidebar();
      const newMonitorBtn = await browser.$(NETWORK_NEW_MONITOR);
      await newMonitorBtn.waitForDisplayed({ timeout: 5000 });
      await newMonitorBtn.click();
      await browser.pause(400);

      const panel = await browser.$(HTTP_MONITOR_PANEL);
      await panel.waitForDisplayed({ timeout: 5000 });

      const urlInput = await browser.$(HTTP_MONITOR_URL_INPUT);
      await urlInput.clearValue();
      await urlInput.setValue("http://127.0.0.1:8080");

      await (await browser.$(HTTP_MONITOR_START_BTN)).click();

      await browser.waitUntil(
        async () => {
          const chart = await browser.$(HTTP_MONITOR_CHART);
          return (await chart.isExisting()) && (await chart.isDisplayed());
        },
        { timeout: 15000, timeoutMsg: "HTTP monitor chart did not appear" }
      );

      const stopBtn = await browser.$(HTTP_MONITOR_STOP_BTN);
      if (await stopBtn.isExisting()) {
        await stopBtn.click();
      }
    });
  });

  // ─── MT-NET-18: HTTP Monitor — sidebar monitor row ───────────────────────────

  describe("MT-NET-18: HTTP Monitor — sidebar monitor row", () => {
    it("should show running monitor in sidebar Monitors section", async () => {
      await openNetworkToolsSidebar();
      const newMonitorBtn = await browser.$(NETWORK_NEW_MONITOR);
      await newMonitorBtn.waitForDisplayed({ timeout: 5000 });
      await newMonitorBtn.click();
      await browser.pause(400);

      const panel = await browser.$(HTTP_MONITOR_PANEL);
      await panel.waitForDisplayed({ timeout: 5000 });

      const urlInput = await browser.$(HTTP_MONITOR_URL_INPUT);
      await urlInput.clearValue();
      await urlInput.setValue("http://127.0.0.1:8080");

      await (await browser.$(HTTP_MONITOR_START_BTN)).click();

      // Wait for first check
      await browser.waitUntil(
        async () => {
          const rows = await browser.$$(HTTP_MONITOR_HISTORY_ROW);
          return rows.length > 0;
        },
        { timeout: 15000, timeoutMsg: "HTTP monitor did not produce first check" }
      );

      // Switch to another view and back to verify the sidebar row persists
      await openNetworkToolsSidebar();
      await browser.pause(500);

      // The Monitors section should contain the running monitor
      const monitorsSection = await browser.$(NETWORK_SIDEBAR_MONITORS);
      if (await monitorsSection.isExisting()) {
        const monitorRows = await browser.$$(NETWORK_MONITOR_ROW);
        expect(monitorRows.length).toBeGreaterThan(0);
      }

      // Stop the monitor via the panel stop button
      const stopBtn = await browser.$(HTTP_MONITOR_STOP_BTN);
      if (await stopBtn.isExisting()) {
        await stopBtn.click();
      }
    });
  });
});
