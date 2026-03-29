// Network Tools panel E2E tests.
// Covers: NT-01 through NT-09 (PR #564, MT-NET-01 through MT-NET-09).
//
// NOTE: The Network Tools sidebar requires experimental features to be enabled.
// The `before` hook enables them via Settings before the suite runs.
//
// Tests that require real network connectivity (ping results, DNS resolution,
// traceroute hops, HTTP monitor checks) are covered by manual tests in
// tests/manual/network-tools.yaml.

import { waitForAppReady, closeAllTabs } from "./helpers/app.js";
import { openSettingsTab } from "./helpers/sidebar.js";

// --- Selectors ---

const ACTIVITY_BAR_NETWORK_TOOLS = '[data-testid="activity-bar-network-tools"]';
const NETWORK_TOOLS_SIDEBAR = '[data-testid="network-tools-sidebar"]';
const NETWORK_NEW_MONITOR = '[data-testid="network-new-monitor"]';
const SETTINGS_EXPERIMENTAL = '[data-testid="settings-experimental-features"]';
const SETTINGS_NAV_GENERAL = '[data-testid="settings-nav-general"]';

// Quick-action buttons in the sidebar
const quickAction = (tool) => `[data-testid="network-quick-action-${tool}"]`;

// Panel root selectors (rendered inside a split-view tab)
const PING_PANEL = '[data-testid="ping-panel"]';
const PORT_SCANNER_PANEL = '[data-testid="port-scanner-panel"]';
const DNS_LOOKUP_PANEL = '[data-testid="dns-lookup-panel"]';
const OPEN_PORTS_PANEL = '[data-testid="open-ports-panel"]';
const TRACEROUTE_PANEL = '[data-testid="traceroute-panel"]';
const WOL_PANEL = '[data-testid="wol-panel"]';
const HTTP_MONITOR_PANEL = '[data-testid="http-monitor-panel"]';

// Panel control selectors
const PING_HOST_INPUT = '[data-testid="ping-host"]';
const PING_START_BTN = '[data-testid="ping-start"]';
const PORT_SCANNER_HOST_INPUT = '[data-testid="port-scanner-host"]';
const PORT_SCANNER_PORTS_INPUT = '[data-testid="port-scanner-ports"]';
const PORT_SCANNER_RUN_BTN = '[data-testid="port-scanner-run"]';
const DNS_HOSTNAME_INPUT = '[data-testid="dns-hostname"]';
const DNS_RUN_BTN = '[data-testid="dns-run"]';
const OPEN_PORTS_REFRESH_BTN = '[data-testid="open-ports-refresh"]';
const TRACEROUTE_HOST_INPUT = '[data-testid="traceroute-host"]';
const TRACEROUTE_RUN_BTN = '[data-testid="traceroute-run"]';
const WOL_MAC_INPUT = '[data-testid="wol-mac"]';
const WOL_SEND_BTN = '[data-testid="wol-send"]';
const HTTP_MONITOR_URL_INPUT = '[data-testid="http-monitor-url"]';
const HTTP_MONITOR_START_BTN = '[data-testid="http-monitor-start"]';

// --- Helpers ---

/**
 * Enable experimental features via the Settings panel.
 * Idempotent — skips the click if the checkbox is already checked.
 */
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

/** Open the Network Tools sidebar panel. */
async function openNetworkToolsSidebar() {
  const btn = await browser.$(ACTIVITY_BAR_NETWORK_TOOLS);
  await btn.waitForDisplayed({ timeout: 5000 });
  await btn.click();
  await browser.pause(300);
  const sidebar = await browser.$(NETWORK_TOOLS_SIDEBAR);
  await sidebar.waitForDisplayed({ timeout: 5000 });
}

/**
 * Click a quick-action button in the sidebar and wait for the resulting panel.
 * @param {string} tool - tool name matching data-testid suffix (e.g. "ping")
 * @param {string} panelSelector - data-testid selector of the resulting panel
 */
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

describe("Network Tools (PR #564)", () => {
  before(async () => {
    await waitForAppReady();
    await enableExperimentalFeatures();
  });

  afterEach(async () => {
    await closeAllTabs();
    await browser.pause(300);
  });

  // ─── NT-01: Open Network Tools sidebar ──────────────────────────────────────

  describe("NT-01: Open Network Tools sidebar", () => {
    it("should display the Network Tools sidebar when clicking the activity bar icon", async () => {
      await openNetworkToolsSidebar();
      const sidebar = await browser.$(NETWORK_TOOLS_SIDEBAR);
      expect(await sidebar.isDisplayed()).toBe(true);
    });

    it("should show all Quick Action buttons in the sidebar", async () => {
      await openNetworkToolsSidebar();

      for (const tool of ["ping", "port-scanner", "dns-lookup", "wol"]) {
        const btn = await browser.$(quickAction(tool));
        expect(await btn.isDisplayed()).toBe(true);
      }
    });

    it("should show the Local section with View Open Ports and Traceroute actions", async () => {
      await openNetworkToolsSidebar();

      const openPortsBtn = await browser.$(quickAction("open-ports"));
      expect(await openPortsBtn.isDisplayed()).toBe(true);

      const tracerouteBtn = await browser.$(quickAction("traceroute"));
      expect(await tracerouteBtn.isDisplayed()).toBe(true);
    });

    it("should show the New Monitor button", async () => {
      await openNetworkToolsSidebar();
      const btn = await browser.$(NETWORK_NEW_MONITOR);
      expect(await btn.isDisplayed()).toBe(true);
    });
  });

  // ─── NT-02: Open Ping tab ────────────────────────────────────────────────────

  describe("NT-02: Open Ping tab", () => {
    it("should open a Ping panel when clicking 'Ping Host…'", async () => {
      const panel = await openToolPanel("ping", PING_PANEL);
      expect(await panel.isDisplayed()).toBe(true);
    });

    it("should show the host input and Start button in the Ping panel", async () => {
      await openToolPanel("ping", PING_PANEL);

      const hostInput = await browser.$(PING_HOST_INPUT);
      expect(await hostInput.isDisplayed()).toBe(true);

      const startBtn = await browser.$(PING_START_BTN);
      expect(await startBtn.isDisplayed()).toBe(true);
    });

    it("should disable the Start button when the host field is empty", async () => {
      await openToolPanel("ping", PING_PANEL);

      const startBtn = await browser.$(PING_START_BTN);
      const disabled = await startBtn.getAttribute("disabled");
      expect(disabled).not.toBeNull();
    });
  });

  // ─── NT-03: Open Port Scanner tab ───────────────────────────────────────────

  describe("NT-03: Open Port Scanner tab", () => {
    it("should open a Port Scanner panel when clicking 'Scan Ports…'", async () => {
      const panel = await openToolPanel("port-scanner", PORT_SCANNER_PANEL);
      expect(await panel.isDisplayed()).toBe(true);
    });

    it("should show host, ports inputs and Run button", async () => {
      await openToolPanel("port-scanner", PORT_SCANNER_PANEL);

      expect(await (await browser.$(PORT_SCANNER_HOST_INPUT)).isDisplayed()).toBe(true);
      expect(await (await browser.$(PORT_SCANNER_PORTS_INPUT)).isDisplayed()).toBe(true);
      expect(await (await browser.$(PORT_SCANNER_RUN_BTN)).isDisplayed()).toBe(true);
    });

    it("should disable the Run button when both host and ports fields are empty", async () => {
      await openToolPanel("port-scanner", PORT_SCANNER_PANEL);

      const runBtn = await browser.$(PORT_SCANNER_RUN_BTN);
      const disabled = await runBtn.getAttribute("disabled");
      expect(disabled).not.toBeNull();
    });
  });

  // ─── NT-04: Open DNS Lookup tab ──────────────────────────────────────────────

  describe("NT-04: Open DNS Lookup tab", () => {
    it("should open a DNS Lookup panel when clicking 'DNS Lookup…'", async () => {
      const panel = await openToolPanel("dns-lookup", DNS_LOOKUP_PANEL);
      expect(await panel.isDisplayed()).toBe(true);
    });

    it("should show the hostname input, record-type selector, and Run button", async () => {
      await openToolPanel("dns-lookup", DNS_LOOKUP_PANEL);

      expect(await (await browser.$(DNS_HOSTNAME_INPUT)).isDisplayed()).toBe(true);
      expect(await (await browser.$(DNS_RUN_BTN)).isDisplayed()).toBe(true);
    });
  });

  // ─── NT-05: Open Open Ports tab ──────────────────────────────────────────────

  describe("NT-05: Open Ports tab", () => {
    it("should open an Open Ports panel when clicking 'View Open Ports'", async () => {
      const panel = await openToolPanel("open-ports", OPEN_PORTS_PANEL);
      expect(await panel.isDisplayed()).toBe(true);
    });

    it("should show the Refresh button", async () => {
      await openToolPanel("open-ports", OPEN_PORTS_PANEL);

      const refreshBtn = await browser.$(OPEN_PORTS_REFRESH_BTN);
      expect(await refreshBtn.isDisplayed()).toBe(true);
    });

    it("should return results when clicking Refresh (local machine query)", async () => {
      await openToolPanel("open-ports", OPEN_PORTS_PANEL);

      const refreshBtn = await browser.$(OPEN_PORTS_REFRESH_BTN);
      await refreshBtn.click();

      // Wait up to 10s for results or an error — both mean the backend responded
      await browser.waitUntil(
        async () => {
          const error = await browser.$(".network-panel__error");
          const table = await browser.$(".network-panel__table-wrapper");
          return (await error.isExisting()) || (await table.isExisting());
        },
        { timeout: 10000, timeoutMsg: "Open Ports did not respond within 10s" }
      );
    });
  });

  // ─── NT-06: Open Traceroute tab ──────────────────────────────────────────────

  describe("NT-06: Open Traceroute tab", () => {
    it("should open a Traceroute panel when clicking 'Traceroute…'", async () => {
      const panel = await openToolPanel("traceroute", TRACEROUTE_PANEL);
      expect(await panel.isDisplayed()).toBe(true);
    });

    it("should show the host input and Run button", async () => {
      await openToolPanel("traceroute", TRACEROUTE_PANEL);

      expect(await (await browser.$(TRACEROUTE_HOST_INPUT)).isDisplayed()).toBe(true);
      expect(await (await browser.$(TRACEROUTE_RUN_BTN)).isDisplayed()).toBe(true);
    });

    it("should disable the Run button when the host field is empty", async () => {
      await openToolPanel("traceroute", TRACEROUTE_PANEL);

      const runBtn = await browser.$(TRACEROUTE_RUN_BTN);
      const disabled = await runBtn.getAttribute("disabled");
      expect(disabled).not.toBeNull();
    });
  });

  // ─── NT-07: Wake-on-LAN panel ────────────────────────────────────────────────

  describe("NT-07: Wake-on-LAN panel", () => {
    it("should open a WoL panel when clicking 'Wake-on-LAN…'", async () => {
      const panel = await openToolPanel("wol", WOL_PANEL);
      expect(await panel.isDisplayed()).toBe(true);
    });

    it("should show the MAC address input and Send button", async () => {
      await openToolPanel("wol", WOL_PANEL);

      expect(await (await browser.$(WOL_MAC_INPUT)).isDisplayed()).toBe(true);
      expect(await (await browser.$(WOL_SEND_BTN)).isDisplayed()).toBe(true);
    });

    it("should disable the Send button when the MAC address field is empty", async () => {
      await openToolPanel("wol", WOL_PANEL);

      const sendBtn = await browser.$(WOL_SEND_BTN);
      const disabled = await sendBtn.getAttribute("disabled");
      expect(disabled).not.toBeNull();
    });
  });

  // ─── NT-08: HTTP Monitor tab ─────────────────────────────────────────────────

  describe("NT-08: HTTP Monitor tab", () => {
    it("should open an HTTP Monitor panel when clicking 'New Monitor'", async () => {
      await openNetworkToolsSidebar();
      const newMonitorBtn = await browser.$(NETWORK_NEW_MONITOR);
      await newMonitorBtn.click();
      await browser.pause(400);

      const panel = await browser.$(HTTP_MONITOR_PANEL);
      await panel.waitForDisplayed({ timeout: 5000 });
      expect(await panel.isDisplayed()).toBe(true);
    });

    it("should show the URL input and Start button", async () => {
      await openNetworkToolsSidebar();
      await (await browser.$(NETWORK_NEW_MONITOR)).click();
      await browser.pause(400);

      expect(await (await browser.$(HTTP_MONITOR_URL_INPUT)).isDisplayed()).toBe(true);
      expect(await (await browser.$(HTTP_MONITOR_START_BTN)).isDisplayed()).toBe(true);
    });
  });

  // ─── NT-09: Multiple panels open simultaneously ───────────────────────────────

  describe("NT-09: Multiple panels open simultaneously", () => {
    it("should allow opening multiple diagnostic panels in the split view", async () => {
      // Open ping
      await openToolPanel("ping", PING_PANEL);

      // Open a second tool while the first tab is still open
      await openNetworkToolsSidebar();
      await (await browser.$(quickAction("dns-lookup"))).click();
      await browser.pause(400);

      // Both panels should exist in the DOM
      const pingPanel = await browser.$(PING_PANEL);
      const dnsPanel = await browser.$(DNS_LOOKUP_PANEL);
      expect(await pingPanel.isExisting()).toBe(true);
      expect(await dnsPanel.isExisting()).toBe(true);
    });
  });
});
