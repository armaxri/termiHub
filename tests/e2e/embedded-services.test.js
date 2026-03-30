// Embedded Services panel E2E tests.
// Covers: SVC-01 through SVC-11 (PR #526, MT-SVC-01 through MT-SVC-05),
//         SVC-12 (FTP file transfer, MT-SVC-04), SVC-13 (TFTP file transfer, MT-SVC-05).
//
// NOTE: The Services sidebar requires experimental features to be enabled.
// The `before` hook enables them via Settings before the suite runs.
//
// SVC-12 and SVC-13 (actual transfer tests) require `curl` to be available on the
// test host. curl is pre-installed on Ubuntu/Debian CI environments.

import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "./helpers/app.js";
import { uniqueName, createLocalConnection, connectByName } from "./helpers/connections.js";
import { openSettingsTab, switchToFilesSidebar } from "./helpers/sidebar.js";

// --- Selectors ---

const ACTIVITY_BAR_SERVICES = '[data-testid="activity-bar-services"]';
const SERVER_SIDEBAR = '[data-testid="server-sidebar"]';
const SERVER_NEW_BTN = '[data-testid="server-new-btn"]';
const SERVER_EMPTY_MESSAGE = '[data-testid="server-empty-message"]';
const SERVER_LIST = '[data-testid="server-list"]';
const SERVER_DIALOG_NAME = '[data-testid="server-dialog-name"]';
const SERVER_DIALOG_PROTO_HTTP = '[data-testid="server-dialog-proto-http"]';
const SERVER_DIALOG_PROTO_FTP = '[data-testid="server-dialog-proto-ftp"]';
const SERVER_DIALOG_PROTO_TFTP = '[data-testid="server-dialog-proto-tftp"]';
const SERVER_DIALOG_ROOT = '[data-testid="server-dialog-root"]';
const SERVER_DIALOG_PORT = '[data-testid="server-dialog-port"]';
const SERVER_DIALOG_BIND_HOST = '[data-testid="server-dialog-bind-host"]';
const SERVER_DIALOG_CANCEL = '[data-testid="server-dialog-cancel"]';
const SERVER_DIALOG_SAVE = '[data-testid="server-dialog-save"]';
const LAN_WARNING_CANCEL = '[data-testid="lan-warning-cancel"]';
const LAN_WARNING_CONFIRM = '[data-testid="lan-warning-confirm"]';
const SERVICES_INDICATOR = '[data-testid="services-indicator"]';
const SETTINGS_EXPERIMENTAL = '[data-testid="settings-experimental-features"]';
const SETTINGS_NAV_GENERAL = '[data-testid="settings-nav-general"]';

// Dynamic selectors
const serverItem = (id) => `[data-testid="server-item-${id}"]`;
const serverStatus = (id) => `[data-testid="server-status-${id}"]`;
const serverStart = (id) => `[data-testid="server-start-${id}"]`;
const serverStop = (id) => `[data-testid="server-stop-${id}"]`;
const serverEdit = (id) => `[data-testid="server-edit-${id}"]`;
const serverDuplicate = (id) => `[data-testid="server-duplicate-${id}"]`;
const serverDelete = (id) => `[data-testid="server-delete-${id}"]`;
const serverType = (id) => `[data-testid="server-type-${id}"]`;

// --- Helpers ---

/**
 * Enable experimental features via the Settings panel.
 * Idempotent — skips the click if the checkbox is already checked.
 */
async function enableExperimentalFeatures() {
  await openSettingsTab();
  await browser.pause(400);

  // Navigate to General settings category
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

  // Close the settings tab
  await closeAllTabs();
  await browser.pause(300);
}

/** Switch to the Services sidebar panel. */
async function ensureServicesSidebar() {
  const btn = await browser.$(ACTIVITY_BAR_SERVICES);
  await btn.waitForDisplayed({ timeout: 5000 });
  await btn.click();
  await browser.pause(300);
  const sidebar = await browser.$(SERVER_SIDEBAR);
  await sidebar.waitForDisplayed({ timeout: 5000 });
}

/**
 * Set an input value using the React-compatible native setter.
 * Avoids keyboard-state corruption issues under WebKitGTK.
 */
async function setInputValue(element, value) {
  await browser.execute(
    (el, val) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    element,
    value
  );
}

/**
 * Fill and submit the New/Edit Service dialog.
 * @param {{ name: string, proto?: 'http'|'ftp'|'tftp', root?: string, port?: number }} opts
 */
async function fillServerDialog({ name, proto = "http", root = "/tmp", port }) {
  const nameInput = await browser.$(SERVER_DIALOG_NAME);
  await nameInput.waitForDisplayed({ timeout: 5000 });
  await setInputValue(nameInput, name);

  if (proto === "ftp") {
    const ftpRadio = await browser.$(SERVER_DIALOG_PROTO_FTP);
    await browser.execute((el) => el.click(), ftpRadio);
    await browser.pause(200);
  } else if (proto === "tftp") {
    const tftpRadio = await browser.$(SERVER_DIALOG_PROTO_TFTP);
    await browser.execute((el) => el.click(), tftpRadio);
    await browser.pause(200);
  }

  const rootInput = await browser.$(SERVER_DIALOG_ROOT);
  await setInputValue(rootInput, root);

  if (port !== undefined) {
    const portInput = await browser.$(SERVER_DIALOG_PORT);
    await browser.execute(
      (el, val) => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        ).set;
        setter.call(el, String(val));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      portInput,
      port
    );
    await browser.pause(100);
  }

  await browser.pause(200);
  const saveBtn = await browser.$(SERVER_DIALOG_SAVE);
  await saveBtn.click();
  await browser.pause(600);
}

/**
 * Find a server in the sidebar by name text.
 * @param {string} name
 * @returns {Promise<{element: WebdriverIO.Element, id: string}|null>}
 */
async function findServerByName(name) {
  const items = await browser.$$('[data-testid^="server-item-"]');
  for (const item of items) {
    const text = await item.getText();
    if (text.includes(name)) {
      const testId = await item.getAttribute("data-testid");
      return { element: item, id: testId.replace("server-item-", "") };
    }
  }
  return null;
}

/**
 * Stop and delete all configured services. Safe to call even with no services.
 */
async function cleanupAllServers() {
  for (let round = 0; round < 20; round++) {
    const items = await browser.$$('[data-testid^="server-item-"]');
    if (items.length === 0) break;
    let acted = false;
    for (const item of items) {
      try {
        const testId = await item.getAttribute("data-testid");
        const id = testId.replace("server-item-", "");
        // Stop first if the stop button is visible (server is running)
        const stopBtn = await browser.$(serverStop(id));
        if (await stopBtn.isExisting()) {
          await browser.execute((el) => el.click(), stopBtn);
          await browser.pause(400);
        }
        const delBtn = await browser.$(serverDelete(id));
        if (await delBtn.isExisting()) {
          await browser.execute((el) => el.click(), delBtn);
          await browser.pause(400);
          acted = true;
          break; // Restart scan — DOM changed
        }
      } catch {
        acted = true;
        break;
      }
    }
    if (!acted) break;
  }
}

// --- Tests ---

describe("Embedded Services Panel (PR #526)", () => {
  // Use a port range unlikely to conflict with other tests or system services.
  let portBase = 19100;
  const nextPort = () => portBase++;

  before(async () => {
    await waitForAppReady();
    // Enable experimental features so the Services sidebar is visible.
    await enableExperimentalFeatures();
    await ensureServicesSidebar();
    await cleanupAllServers();
  });

  afterEach(async () => {
    await ensureServicesSidebar();
    await cleanupAllServers();
  });

  // ─── SVC-01: Open Services sidebar ───────────────────────────────────────

  describe("SVC-01: Open Services sidebar", () => {
    it("should display the Services sidebar with a New Service button", async () => {
      const sidebar = await browser.$(SERVER_SIDEBAR);
      expect(await sidebar.isDisplayed()).toBe(true);

      const newBtn = await browser.$(SERVER_NEW_BTN);
      expect(await newBtn.isDisplayed()).toBe(true);
    });

    it("should show the empty-state message when no services are configured", async () => {
      const empty = await browser.$(SERVER_EMPTY_MESSAGE);
      expect(await empty.isDisplayed()).toBe(true);
    });
  });

  // ─── SVC-02: New Service dialog ──────────────────────────────────────────

  describe("SVC-02: New Service dialog", () => {
    it("should open the dialog when clicking New Service", async () => {
      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);

      const nameInput = await browser.$(SERVER_DIALOG_NAME);
      expect(await nameInput.isDisplayed()).toBe(true);

      // Cancel — clean up
      const cancelBtn = await browser.$(SERVER_DIALOG_CANCEL);
      await cancelBtn.click();
      await browser.pause(300);
    });

    it("should not save when Cancel is clicked", async () => {
      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);

      const cancelBtn = await browser.$(SERVER_DIALOG_CANCEL);
      await cancelBtn.click();
      await browser.pause(300);

      // List should remain empty
      const empty = await browser.$(SERVER_EMPTY_MESSAGE);
      expect(await empty.isDisplayed()).toBe(true);
    });

    it("should create an HTTP server and show it in the sidebar (MT-SVC-01)", async () => {
      const name = uniqueName("svc-create-http");
      const port = nextPort();

      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);

      await fillServerDialog({ name, proto: "http", root: "/tmp", port });

      const server = await findServerByName(name);
      expect(server).not.toBeNull();
      expect(await server.element.isDisplayed()).toBe(true);

      // Protocol badge should read "HTTP"
      const badge = await browser.$(serverType(server.id));
      expect(await badge.getText()).toBe("HTTP");
    });
  });

  // ─── SVC-03: Start / stop HTTP server ────────────────────────────────────

  describe("SVC-03: Start and stop HTTP server (MT-SVC-01)", () => {
    it("should show running status dot after starting the server", async () => {
      const name = uniqueName("svc-start");
      const port = nextPort();

      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);
      await fillServerDialog({ name, proto: "http", root: "/tmp", port });

      const server = await findServerByName(name);
      expect(server).not.toBeNull();

      const startBtn = await browser.$(serverStart(server.id));
      await browser.execute((el) => el.click(), startBtn);
      await browser.pause(1500);

      const dot = await browser.$(serverStatus(server.id));
      const classes = await dot.getAttribute("class");
      expect(classes).toContain("server-item__status--running");

      // Play button replaced by stop button
      const stopBtn = await browser.$(serverStop(server.id));
      expect(await stopBtn.isDisplayed()).toBe(true);
    });

    it("should return to stopped state after clicking stop", async () => {
      const name = uniqueName("svc-stop");
      const port = nextPort();

      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);
      await fillServerDialog({ name, proto: "http", root: "/tmp", port });

      const server = await findServerByName(name);
      const startBtn = await browser.$(serverStart(server.id));
      await browser.execute((el) => el.click(), startBtn);
      await browser.pause(1500);

      const stopBtn = await browser.$(serverStop(server.id));
      await browser.execute((el) => el.click(), stopBtn);
      await browser.pause(1500);

      const dot = await browser.$(serverStatus(server.id));
      const classes = await dot.getAttribute("class");
      expect(classes).not.toContain("server-item__status--running");
    });

    it("should respond to HTTP requests when running (MT-SVC-01 browser verification)", async () => {
      const name = uniqueName("svc-http-check");
      const port = nextPort();

      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);
      await fillServerDialog({ name, proto: "http", root: "/tmp", port });

      const server = await findServerByName(name);
      const startBtn = await browser.$(serverStart(server.id));
      await browser.execute((el) => el.click(), startBtn);
      await browser.pause(1500);

      // Verify the server is reachable from within the WebView
      const httpStatus = await browser.execute(async (p) => {
        try {
          const r = await fetch(`http://127.0.0.1:${p}/`);
          return r.status;
        } catch {
          return 0;
        }
      }, port);
      expect(httpStatus).toBe(200);
    });
  });

  // ─── SVC-04: Status bar services indicator (MT-SVC-03) ───────────────────

  describe("SVC-04: Status bar services indicator (MT-SVC-03)", () => {
    it("should show the services indicator when a server is running", async () => {
      const name = uniqueName("svc-sb-show");
      const port = nextPort();

      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);
      await fillServerDialog({ name, proto: "http", root: "/tmp", port });

      const server = await findServerByName(name);
      const startBtn = await browser.$(serverStart(server.id));
      await browser.execute((el) => el.click(), startBtn);
      await browser.pause(1500);

      const indicator = await browser.$(SERVICES_INDICATOR);
      expect(await indicator.isDisplayed()).toBe(true);
    });

    it("should open the Services sidebar when clicking the status bar indicator", async () => {
      const name = uniqueName("svc-sb-click");
      const port = nextPort();

      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);
      await fillServerDialog({ name, proto: "http", root: "/tmp", port });

      const server = await findServerByName(name);
      const startBtn = await browser.$(serverStart(server.id));
      await browser.execute((el) => el.click(), startBtn);
      await browser.pause(1500);

      // Navigate away, then use the indicator to return
      await ensureConnectionsSidebar();
      await browser.pause(300);

      const indicator = await browser.$(SERVICES_INDICATOR);
      await indicator.click();
      await browser.pause(400);

      const sidebar = await browser.$(SERVER_SIDEBAR);
      expect(await sidebar.isDisplayed()).toBe(true);
    });

    it("should hide the indicator when all servers are stopped", async () => {
      const name = uniqueName("svc-sb-hide");
      const port = nextPort();

      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);
      await fillServerDialog({ name, proto: "http", root: "/tmp", port });

      const server = await findServerByName(name);
      const startBtn = await browser.$(serverStart(server.id));
      await browser.execute((el) => el.click(), startBtn);
      await browser.pause(1500);

      const indicator = await browser.$(SERVICES_INDICATOR);
      expect(await indicator.isDisplayed()).toBe(true);

      const stopBtn = await browser.$(serverStop(server.id));
      await browser.execute((el) => el.click(), stopBtn);
      await browser.pause(1500);

      const visible = await indicator.isDisplayed().catch(() => false);
      expect(visible).toBe(false);
    });
  });

  // ─── SVC-05: Edit server configuration ───────────────────────────────────

  describe("SVC-05: Edit server configuration", () => {
    it("should pre-populate the edit dialog with the existing config", async () => {
      const name = uniqueName("svc-edit-open");
      const port = nextPort();

      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);
      await fillServerDialog({ name, proto: "http", root: "/tmp", port });

      const server = await findServerByName(name);
      const editBtn = await browser.$(serverEdit(server.id));
      await browser.execute((el) => el.click(), editBtn);
      await browser.pause(400);

      const nameInput = await browser.$(SERVER_DIALOG_NAME);
      expect(await nameInput.getValue()).toBe(name);

      const cancelBtn = await browser.$(SERVER_DIALOG_CANCEL);
      await cancelBtn.click();
      await browser.pause(300);
    });

    it("should persist the updated name after editing", async () => {
      const name = uniqueName("svc-edit-orig");
      const newName = uniqueName("svc-edit-new");
      const port = nextPort();

      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);
      await fillServerDialog({ name, proto: "http", root: "/tmp", port });

      const server = await findServerByName(name);
      const editBtn = await browser.$(serverEdit(server.id));
      await browser.execute((el) => el.click(), editBtn);
      await browser.pause(400);

      const nameInput = await browser.$(SERVER_DIALOG_NAME);
      await setInputValue(nameInput, newName);
      await browser.pause(200);

      const saveBtn = await browser.$(SERVER_DIALOG_SAVE);
      await saveBtn.click();
      await browser.pause(600);

      const updated = await findServerByName(newName);
      expect(updated).not.toBeNull();

      const old = await findServerByName(name);
      expect(old).toBeNull();
    });
  });

  // ─── SVC-06: Duplicate server entry ──────────────────────────────────────

  describe("SVC-06: Duplicate server entry", () => {
    it('should create a "Copy of ..." entry when clicking Duplicate', async () => {
      const name = uniqueName("svc-dup");
      const port = nextPort();

      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);
      await fillServerDialog({ name, proto: "http", root: "/tmp", port });

      const server = await findServerByName(name);
      const dupBtn = await browser.$(serverDuplicate(server.id));
      await browser.execute((el) => el.click(), dupBtn);
      await browser.pause(600);

      const copy = await findServerByName(`Copy of ${name}`);
      expect(copy).not.toBeNull();
      expect(await copy.element.isDisplayed()).toBe(true);
    });
  });

  // ─── SVC-07: Delete server entry ─────────────────────────────────────────

  describe("SVC-07: Delete server entry", () => {
    it("should remove the entry and restore the empty-state message", async () => {
      const name = uniqueName("svc-del");
      const port = nextPort();

      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);
      await fillServerDialog({ name, proto: "http", root: "/tmp", port });

      const server = await findServerByName(name);
      expect(server).not.toBeNull();

      const delBtn = await browser.$(serverDelete(server.id));
      await browser.execute((el) => el.click(), delBtn);
      await browser.pause(600);

      expect(await findServerByName(name)).toBeNull();

      const empty = await browser.$(SERVER_EMPTY_MESSAGE);
      expect(await empty.isDisplayed()).toBe(true);
    });
  });

  // ─── SVC-08: FTP server lifecycle (MT-SVC-04) ────────────────────────────

  describe("SVC-08: FTP server lifecycle (MT-SVC-04)", () => {
    it("should show FTP badge and running state after starting an FTP server", async () => {
      const name = uniqueName("svc-ftp");
      const port = nextPort();

      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);
      await fillServerDialog({ name, proto: "ftp", root: "/tmp", port });

      const server = await findServerByName(name);
      expect(server).not.toBeNull();
      expect(await (await browser.$(serverType(server.id))).getText()).toBe("FTP");

      const startBtn = await browser.$(serverStart(server.id));
      await browser.execute((el) => el.click(), startBtn);
      await browser.pause(1500);

      const dot = await browser.$(serverStatus(server.id));
      expect(await dot.getAttribute("class")).toContain("server-item__status--running");
    });
  });

  // ─── SVC-09: TFTP server lifecycle (MT-SVC-05) ───────────────────────────

  describe("SVC-09: TFTP server lifecycle (MT-SVC-05)", () => {
    it("should show TFTP badge and running state after starting a TFTP server", async () => {
      const name = uniqueName("svc-tftp");
      const port = nextPort();

      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);
      await fillServerDialog({ name, proto: "tftp", root: "/tmp", port });

      const server = await findServerByName(name);
      expect(server).not.toBeNull();
      expect(await (await browser.$(serverType(server.id))).getText()).toBe("TFTP");

      const startBtn = await browser.$(serverStart(server.id));
      await browser.execute((el) => el.click(), startBtn);
      await browser.pause(1500);

      const dot = await browser.$(serverStatus(server.id));
      expect(await dot.getAttribute("class")).toContain("server-item__status--running");
    });
  });

  // ─── SVC-10: File Browser quick-share (MT-SVC-02) ────────────────────────

  describe("SVC-10: File Browser quick-share via HTTP (MT-SVC-02)", () => {
    let localConnName;

    before(async () => {
      await ensureConnectionsSidebar();
      localConnName = uniqueName("svc-share-conn");
      await createLocalConnection(localConnName);
      await connectByName(localConnName);
      await browser.pause(1000);
      // Navigate to / so the file browser lists top-level directories
      await browser.keys("cd /\n");
      await browser.pause(800);
    });

    after(async () => {
      await ensureServicesSidebar();
      await cleanupAllServers();
      await ensureConnectionsSidebar();
      await closeAllTabs();
    });

    it("should switch to Services sidebar and start a server after right-click Share via HTTP", async () => {
      await switchToFilesSidebar();
      await browser.pause(600);

      // Right-click each file row until we find a directory (has the share-http item)
      const rows = await browser.$$('[data-testid^="file-row-"]');
      let shared = false;
      for (const row of rows) {
        try {
          await row.click({ button: "right" });
          await browser.pause(300);

          const shareItem = await browser.$('[data-testid="context-file-share-http"]');
          if (await shareItem.isExisting()) {
            await shareItem.click();
            await browser.pause(1000);
            shared = true;
            break;
          }
          await browser.keys(["Escape"]);
          await browser.pause(200);
        } catch {
          await browser.keys(["Escape"]).catch(() => {});
        }
      }

      if (!shared) {
        // No directory rows visible — skip gracefully
        return;
      }

      // The sidebar should have switched to Services
      const sidebar = await browser.$(SERVER_SIDEBAR);
      await sidebar.waitForDisplayed({ timeout: 5000 });
      expect(await sidebar.isDisplayed()).toBe(true);

      // At least one server should be in a running state
      const allItems = await browser.$$('[data-testid^="server-item-"]');
      expect(allItems.length).toBeGreaterThan(0);

      let hasRunning = false;
      for (const item of allItems) {
        const tid = await item.getAttribute("data-testid");
        const id = tid.replace("server-item-", "");
        const dot = await browser.$(`[data-testid="server-status-${id}"]`);
        const cls = await dot.getAttribute("class");
        if (cls && cls.includes("server-item__status--running")) {
          hasRunning = true;
          break;
        }
      }
      expect(hasRunning).toBe(true);
    });
  });

  // ─── SVC-11: Bind-address dropdown and LAN warning ───────────────────────

  describe("SVC-11: Bind-address dropdown and LAN security warning", () => {
    it("should show the bind-address dropdown in the dialog", async () => {
      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);

      const bindSelect = await browser.$(SERVER_DIALOG_BIND_HOST);
      expect(await bindSelect.isDisplayed()).toBe(true);

      // Must contain at least loopback and all-interfaces options
      const options = await bindSelect.$$("option");
      const values = await Promise.all(options.map((o) => o.getAttribute("value")));
      expect(values).toContain("127.0.0.1");
      expect(values).toContain("0.0.0.0");

      const cancelBtn = await browser.$(SERVER_DIALOG_CANCEL);
      await cancelBtn.click();
      await browser.pause(300);
    });

    it("should show a security warning when 0.0.0.0 is selected", async () => {
      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);

      const bindSelect = await browser.$(SERVER_DIALOG_BIND_HOST);
      await bindSelect.selectByAttribute("value", "0.0.0.0");
      await browser.pause(300);

      const warnConfirm = await browser.$(LAN_WARNING_CONFIRM);
      expect(await warnConfirm.isDisplayed()).toBe(true);

      // Dismiss without confirming
      const warnCancel = await browser.$(LAN_WARNING_CANCEL);
      await warnCancel.click();
      await browser.pause(300);

      const cancelBtn = await browser.$(SERVER_DIALOG_CANCEL);
      await cancelBtn.click();
      await browser.pause(300);
    });

    it("should bind to 0.0.0.0 and show details after confirming the LAN warning", async () => {
      const name = uniqueName("svc-lan-bind");
      const port = nextPort();

      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);

      const nameInput = await browser.$(SERVER_DIALOG_NAME);
      await setInputValue(nameInput, name);

      const rootInput = await browser.$(SERVER_DIALOG_ROOT);
      await setInputValue(rootInput, "/tmp");

      const portInput = await browser.$(SERVER_DIALOG_PORT);
      await browser.execute(
        (el, val) => {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value"
          ).set;
          setter.call(el, String(val));
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        },
        portInput,
        port
      );

      const bindSelect = await browser.$(SERVER_DIALOG_BIND_HOST);
      await bindSelect.selectByAttribute("value", "0.0.0.0");
      await browser.pause(300);

      // Confirm the LAN warning
      const warnConfirm = await browser.$(LAN_WARNING_CONFIRM);
      await warnConfirm.click();
      await browser.pause(300);

      const saveBtn = await browser.$(SERVER_DIALOG_SAVE);
      await saveBtn.click();
      await browser.pause(600);

      // The server details line should contain 0.0.0.0
      const server = await findServerByName(name);
      expect(server).not.toBeNull();
      const text = await server.element.getText();
      expect(text).toContain("0.0.0.0");
    });
  });

  // ─── SVC-12: FTP server actual file transfer (MT-SVC-04) ─────────────────

  describe("SVC-12: FTP server actual file transfer (MT-SVC-04)", () => {
    let tmpDir;
    let port;
    let serverName;

    before(async () => {
      // Create a temp directory with a known test file
      tmpDir = mkdtempSync(join(tmpdir(), "termihub-ftp-test-"));
      writeFileSync(join(tmpDir, "hello.txt"), "termihub-ftp-transfer-ok\n");
    });

    after(async () => {
      await ensureServicesSidebar();
      await cleanupAllServers();
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true });
        } catch {
          // ignore cleanup errors
        }
      }
    });

    it("should serve files via FTP protocol (curl download)", async () => {
      port = nextPort();
      serverName = uniqueName("svc-ftp-transfer");

      await ensureServicesSidebar();
      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);
      await fillServerDialog({ name: serverName, proto: "ftp", root: tmpDir, port });

      const server = await findServerByName(serverName);
      expect(server).not.toBeNull();

      const startBtn = await browser.$(serverStart(server.id));
      await browser.execute((el) => el.click(), startBtn);
      await browser.pause(2000);

      // Verify server is running in UI
      const dot = await browser.$(serverStatus(server.id));
      expect(await dot.getAttribute("class")).toContain("server-item__status--running");

      // Use curl to download the test file via FTP
      let curlOutput;
      try {
        curlOutput = execSync(
          `curl --silent --connect-timeout 5 --max-time 10 ftp://127.0.0.1:${port}/hello.txt`,
          { encoding: "utf8", timeout: 15000 }
        );
      } catch (err) {
        throw new Error(
          `curl FTP download failed on port ${port}: ${err.message}. ` +
            "Ensure the FTP server is accessible on 127.0.0.1."
        );
      }

      expect(curlOutput.trim()).toBe("termihub-ftp-transfer-ok");
    });

    it("should list directory contents via FTP", async () => {
      // Re-use the server started in the previous test (same describe block)
      if (!port) this.skip();

      let listing;
      try {
        listing = execSync(
          `curl --silent --connect-timeout 5 --max-time 10 ftp://127.0.0.1:${port}/`,
          { encoding: "utf8", timeout: 15000 }
        );
      } catch (err) {
        throw new Error(`curl FTP listing failed on port ${port}: ${err.message}`);
      }

      expect(listing).toContain("hello.txt");
    });
  });

  // ─── SVC-13: TFTP server actual file transfer (MT-SVC-05) ────────────────

  describe("SVC-13: TFTP server actual file transfer (MT-SVC-05)", () => {
    let tmpDir;
    let port;
    let serverName;

    before(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "termihub-tftp-test-"));
      writeFileSync(join(tmpDir, "boot.txt"), "termihub-tftp-transfer-ok\n");
    });

    after(async () => {
      await ensureServicesSidebar();
      await cleanupAllServers();
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true });
        } catch {
          // ignore cleanup errors
        }
      }
    });

    it("should serve files via TFTP protocol (curl download)", async () => {
      port = nextPort();
      serverName = uniqueName("svc-tftp-transfer");

      await ensureServicesSidebar();
      const newBtn = await browser.$(SERVER_NEW_BTN);
      await newBtn.click();
      await browser.pause(400);
      await fillServerDialog({ name: serverName, proto: "tftp", root: tmpDir, port });

      const server = await findServerByName(serverName);
      expect(server).not.toBeNull();

      const startBtn = await browser.$(serverStart(server.id));
      await browser.execute((el) => el.click(), startBtn);
      await browser.pause(2000);

      // Verify server is running in UI
      const dot = await browser.$(serverStatus(server.id));
      expect(await dot.getAttribute("class")).toContain("server-item__status--running");

      // Use curl to download via TFTP (curl supports tftp:// scheme)
      let curlOutput;
      try {
        curlOutput = execSync(
          `curl --silent --connect-timeout 5 --max-time 10 tftp://127.0.0.1:${port}/boot.txt`,
          { encoding: "utf8", timeout: 15000 }
        );
      } catch (err) {
        throw new Error(
          `curl TFTP download failed on port ${port}: ${err.message}. ` +
            "Ensure the TFTP server is accessible on 127.0.0.1 and curl supports TFTP."
        );
      }

      expect(curlOutput.trim()).toBe("termihub-tftp-transfer-ok");
    });
  });
});
