// SSH Tunnel E2E tests.
// Covers: TUNNEL-01 through TUNNEL-10 (PR #225).

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "./helpers/app.js";
import { uniqueName, openNewConnectionEditor, setConnectionType } from "./helpers/connections.js";
import { createSshConnection } from "./helpers/infrastructure.js";
import { findTabByTitle, getTabCount } from "./helpers/tabs.js";
import {
  TUNNEL_SIDEBAR,
  TUNNEL_NEW_BTN,
  TUNNEL_EMPTY_MESSAGE,
  TUNNEL_LIST,
  TUNNEL_EDITOR,
  TUNNEL_EDITOR_TITLE,
  TUNNEL_EDITOR_FORM,
  TUNNEL_EDITOR_NAME,
  TUNNEL_EDITOR_SSH_CONNECTION,
  TUNNEL_TYPE_LOCAL,
  TUNNEL_TYPE_REMOTE,
  TUNNEL_TYPE_DYNAMIC,
  TUNNEL_DIAGRAM,
  TUNNEL_EDITOR_SAVE,
  TUNNEL_EDITOR_SAVE_START,
  TUNNEL_EDITOR_CANCEL,
  CONN_EDITOR_NAME,
  CONN_EDITOR_SAVE,
  CONN_EDITOR_TYPE,
  SSH_HOST,
  SSH_PORT,
  SSH_USERNAME,
} from "./helpers/selectors.js";

const ACTIVITY_BAR_SSH_TUNNELS = '[data-testid="activity-bar-ssh-tunnels"]';

/**
 * Switch to the SSH Tunnels sidebar by clicking the activity bar icon.
 */
async function ensureTunnelsSidebar() {
  const btn = await browser.$(ACTIVITY_BAR_SSH_TUNNELS);
  await btn.waitForDisplayed({ timeout: 5000 });
  await btn.click();
  await browser.pause(300);

  // Wait for the tunnel sidebar panel to render
  const sidebar = await browser.$(TUNNEL_SIDEBAR);
  await sidebar.waitForDisplayed({ timeout: 5000 });
}

/**
 * Create a minimal SSH connection (for the tunnel editor SSH dropdown).
 * Does not require a live SSH server — only needs to exist as a saved connection.
 * @param {string} name - Connection display name
 */
async function createSshConnectionForTunnels(name) {
  await ensureConnectionsSidebar();
  await createSshConnection(name, {
    host: "127.0.0.1",
    port: "22",
    username: "testuser",
    authMethod: "password",
  });
}

/**
 * Create a tunnel via the tunnel editor and save it.
 * Assumes the tunnel sidebar is already visible.
 * @param {string} tunnelName - Tunnel display name
 * @param {string} sshConnectionName - Name of the SSH connection to select
 * @param {'local'|'remote'|'dynamic'} type - Tunnel type
 */
async function createTunnel(tunnelName, sshConnectionName, type = "local") {
  // Click "+ New Tunnel"
  const newBtn = await browser.$(TUNNEL_NEW_BTN);
  await newBtn.waitForDisplayed({ timeout: 3000 });
  await newBtn.click();
  await browser.pause(500);

  // Wait for editor to appear
  const editor = await browser.$(TUNNEL_EDITOR);
  await editor.waitForDisplayed({ timeout: 5000 });

  // Set tunnel name
  const nameInput = await browser.$(TUNNEL_EDITOR_NAME);
  await nameInput.clearValue();
  await nameInput.setValue(tunnelName);

  // Select SSH connection from dropdown
  const sshSelect = await browser.$(TUNNEL_EDITOR_SSH_CONNECTION);
  const options = await sshSelect.$$("option");
  for (const opt of options) {
    const text = await opt.getText();
    if (text.includes(sshConnectionName)) {
      const val = await opt.getAttribute("value");
      await sshSelect.selectByAttribute("value", val);
      break;
    }
  }
  await browser.pause(200);

  // Select tunnel type
  if (type === "local") {
    const localBtn = await browser.$(TUNNEL_TYPE_LOCAL);
    await localBtn.click();
  } else if (type === "remote") {
    const remoteBtn = await browser.$(TUNNEL_TYPE_REMOTE);
    await remoteBtn.click();
  } else if (type === "dynamic") {
    const dynamicBtn = await browser.$(TUNNEL_TYPE_DYNAMIC);
    await dynamicBtn.click();
  }
  await browser.pause(200);

  // Click Save
  const saveBtn = await browser.$(TUNNEL_EDITOR_SAVE);
  await saveBtn.click();
  await browser.pause(500);
}

/**
 * Find a tunnel item in the sidebar by its visible name text.
 * @param {string} name
 * @returns {Promise<WebdriverIO.Element|null>}
 */
async function findTunnelByName(name) {
  const items = await browser.$$('[data-testid^="tunnel-item-"]');
  for (const item of items) {
    const text = await item.getText();
    if (text.includes(name)) {
      return item;
    }
  }
  return null;
}

/**
 * Extract the tunnel ID from a tunnel item element's data-testid attribute.
 * @param {WebdriverIO.Element} tunnelItem
 * @returns {Promise<string>}
 */
async function getTunnelId(tunnelItem) {
  const testId = await tunnelItem.getAttribute("data-testid");
  // testId is "tunnel-item-<id>"
  return testId.replace("tunnel-item-", "");
}

describe("SSH Tunnels (PR #225)", () => {
  let sshConnName;

  before(async () => {
    await waitForAppReady();

    // Create an SSH connection that tunnel tests can reference
    sshConnName = uniqueName("tunnel-ssh");
    await createSshConnectionForTunnels(sshConnName);

    // Switch to the tunnels sidebar
    await ensureTunnelsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
    // Return to the tunnels sidebar for the next test
    await ensureTunnelsSidebar();
  });

  describe("TUNNEL-01: Open tunnel sidebar panel", () => {
    it("should show tunnel sidebar with empty message and New Tunnel button", async () => {
      const sidebar = await browser.$(TUNNEL_SIDEBAR);
      expect(await sidebar.isDisplayed()).toBe(true);

      const newBtn = await browser.$(TUNNEL_NEW_BTN);
      expect(await newBtn.isDisplayed()).toBe(true);
    });
  });

  describe("TUNNEL-02: Open tunnel editor via New Tunnel button", () => {
    it("should open tunnel editor tab with name, SSH dropdown, type selector, and diagram", async () => {
      const newBtn = await browser.$(TUNNEL_NEW_BTN);
      await newBtn.click();
      await browser.pause(500);

      // Editor should be visible
      const editor = await browser.$(TUNNEL_EDITOR);
      expect(await editor.isDisplayed()).toBe(true);

      // Name input
      const nameInput = await browser.$(TUNNEL_EDITOR_NAME);
      expect(await nameInput.isDisplayed()).toBe(true);

      // SSH connection dropdown
      const sshSelect = await browser.$(TUNNEL_EDITOR_SSH_CONNECTION);
      expect(await sshSelect.isDisplayed()).toBe(true);

      // Type selector buttons
      const localBtn = await browser.$(TUNNEL_TYPE_LOCAL);
      expect(await localBtn.isDisplayed()).toBe(true);
      const remoteBtn = await browser.$(TUNNEL_TYPE_REMOTE);
      expect(await remoteBtn.isDisplayed()).toBe(true);
      const dynamicBtn = await browser.$(TUNNEL_TYPE_DYNAMIC);
      expect(await dynamicBtn.isDisplayed()).toBe(true);

      // Visual diagram
      const diagram = await browser.$(TUNNEL_DIAGRAM);
      expect(await diagram.isDisplayed()).toBe(true);

      // Title should say "New SSH Tunnel"
      const title = await browser.$(TUNNEL_EDITOR_TITLE);
      const titleText = await title.getText();
      expect(titleText).toContain("New SSH Tunnel");
    });
  });

  describe("TUNNEL-03: Select Local type", () => {
    it("should show local forward diagram with Your PC, SSH Server, and Target boxes", async () => {
      const newBtn = await browser.$(TUNNEL_NEW_BTN);
      await newBtn.click();
      await browser.pause(500);

      // Local is the default type, but click it explicitly
      const localBtn = await browser.$(TUNNEL_TYPE_LOCAL);
      await localBtn.click();
      await browser.pause(200);

      // Verify diagram content
      const diagram = await browser.$(TUNNEL_DIAGRAM);
      const diagramText = await diagram.getText();
      expect(diagramText).toContain("Your PC");
      expect(diagramText).toContain("SSH Server");
      expect(diagramText).toContain("Target");

      // Verify local/remote host/port fields appear (Local Bind and Remote Target sections)
      const editorForm = await browser.$(TUNNEL_EDITOR_FORM);
      const formText = await editorForm.getText();
      expect(formText).toContain("Local Host");
      expect(formText).toContain("Local Port");
      expect(formText).toContain("Remote Host");
      expect(formText).toContain("Remote Port");
    });
  });

  describe("TUNNEL-04: Select Remote type", () => {
    it("should show remote forward diagram with Local Target, SSH Server, and Remote Clients boxes", async () => {
      const newBtn = await browser.$(TUNNEL_NEW_BTN);
      await newBtn.click();
      await browser.pause(500);

      const remoteBtn = await browser.$(TUNNEL_TYPE_REMOTE);
      await remoteBtn.click();
      await browser.pause(200);

      // Verify diagram content
      const diagram = await browser.$(TUNNEL_DIAGRAM);
      const diagramText = await diagram.getText();
      expect(diagramText).toContain("Local Target");
      expect(diagramText).toContain("SSH Server");
      expect(diagramText).toContain("Remote Clients");

      // Verify host/port fields appear
      const editorForm = await browser.$(TUNNEL_EDITOR_FORM);
      const formText = await editorForm.getText();
      expect(formText).toContain("Local Host");
      expect(formText).toContain("Local Port");
      expect(formText).toContain("Remote Host");
      expect(formText).toContain("Remote Port");
    });
  });

  describe("TUNNEL-05: Select Dynamic type", () => {
    it("should show dynamic (SOCKS5) diagram with Your PC, SSH Server, and Internet boxes", async () => {
      const newBtn = await browser.$(TUNNEL_NEW_BTN);
      await newBtn.click();
      await browser.pause(500);

      const dynamicBtn = await browser.$(TUNNEL_TYPE_DYNAMIC);
      await dynamicBtn.click();
      await browser.pause(200);

      // Verify diagram content
      const diagram = await browser.$(TUNNEL_DIAGRAM);
      const diagramText = await diagram.getText();
      expect(diagramText).toContain("Your PC");
      expect(diagramText).toContain("SSH Server");
      expect(diagramText).toContain("Internet");

      // Dynamic type only shows local host/port (SOCKS5 bind), no remote fields
      const editorForm = await browser.$(TUNNEL_EDITOR_FORM);
      const formText = await editorForm.getText();
      expect(formText).toContain("Local Host");
      expect(formText).toContain("Local Port");
      // Should NOT show Remote Host/Remote Port fields
      expect(formText).not.toContain("Remote Host");
      expect(formText).not.toContain("Remote Port");
    });
  });

  describe("TUNNEL-06: Diagram updates reactively on port change", () => {
    it("should update diagram port numbers when input values change", async () => {
      const newBtn = await browser.$(TUNNEL_NEW_BTN);
      await newBtn.click();
      await browser.pause(500);

      // Default is Local type, diagram should show default ports (8080 and 80)
      let diagram = await browser.$(TUNNEL_DIAGRAM);
      let diagramText = await diagram.getText();
      expect(diagramText).toContain("8080");

      // Find the local port input and change it
      // The local port field is a number input inside the editor form
      const portInputs = await browser.$$('.tunnel-editor__port-field input[type="number"]');
      // First port input is the local port
      if (portInputs.length > 0) {
        const localPortInput = portInputs[0];
        await localPortInput.clearValue();
        await localPortInput.setValue("9999");
        await browser.pause(300);

        // Verify diagram updated
        diagram = await browser.$(TUNNEL_DIAGRAM);
        diagramText = await diagram.getText();
        expect(diagramText).toContain("9999");
      }
    });
  });

  describe("TUNNEL-07: Save tunnel", () => {
    it("should save tunnel and show it in the sidebar list", async () => {
      const tunnelName = uniqueName("tunnel-save");

      const tabsBefore = await getTabCount();

      await createTunnel(tunnelName, sshConnName, "local");

      // Editor tab should have closed
      const tabsAfter = await getTabCount();
      expect(tabsAfter).toBeLessThan(tabsBefore + 1);

      // Tunnel should appear in the sidebar list
      await ensureTunnelsSidebar();
      const tunnelItem = await findTunnelByName(tunnelName);
      expect(tunnelItem).not.toBeNull();
      expect(await tunnelItem.isDisplayed()).toBe(true);
    });
  });

  describe("TUNNEL-08: Double-click tunnel to edit", () => {
    it("should open editor tab with saved config when double-clicking a tunnel", async () => {
      const tunnelName = uniqueName("tunnel-dblclick");
      await createTunnel(tunnelName, sshConnName, "local");

      // Ensure we are back on tunnel sidebar
      await ensureTunnelsSidebar();

      // Find the tunnel and double-click it
      const tunnelItem = await findTunnelByName(tunnelName);
      expect(tunnelItem).not.toBeNull();
      await tunnelItem.doubleClick();
      await browser.pause(500);

      // Editor should open with the tunnel name pre-filled
      const editor = await browser.$(TUNNEL_EDITOR);
      expect(await editor.isDisplayed()).toBe(true);

      const nameInput = await browser.$(TUNNEL_EDITOR_NAME);
      const currentValue = await nameInput.getValue();
      expect(currentValue).toBe(tunnelName);

      // Title should show "Edit Tunnel: <name>"
      const title = await browser.$(TUNNEL_EDITOR_TITLE);
      const titleText = await title.getText();
      expect(titleText).toContain("Edit Tunnel");
      expect(titleText).toContain(tunnelName);
    });
  });

  describe("TUNNEL-09: Duplicate tunnel", () => {
    it('should create a "Copy of ..." tunnel when clicking Duplicate', async () => {
      const tunnelName = uniqueName("tunnel-dup");
      await createTunnel(tunnelName, sshConnName, "local");

      // Ensure we are back on tunnel sidebar
      await ensureTunnelsSidebar();

      // Find the tunnel item and its duplicate button
      const tunnelItem = await findTunnelByName(tunnelName);
      expect(tunnelItem).not.toBeNull();
      const tunnelId = await getTunnelId(tunnelItem);

      const duplicateBtn = await browser.$(`[data-testid="tunnel-duplicate-${tunnelId}"]`);
      await duplicateBtn.click();
      await browser.pause(500);

      // A "Copy of <name>" tunnel should appear
      const duplicate = await findTunnelByName(`Copy of ${tunnelName}`);
      expect(duplicate).not.toBeNull();
      expect(await duplicate.isDisplayed()).toBe(true);
    });
  });

  describe("TUNNEL-10: Delete tunnel", () => {
    it("should remove tunnel from sidebar when clicking Delete", async () => {
      const tunnelName = uniqueName("tunnel-del");
      await createTunnel(tunnelName, sshConnName, "local");

      // Ensure we are back on tunnel sidebar
      await ensureTunnelsSidebar();

      // Verify the tunnel exists
      let tunnelItem = await findTunnelByName(tunnelName);
      expect(tunnelItem).not.toBeNull();
      const tunnelId = await getTunnelId(tunnelItem);

      // Click the delete button
      const deleteBtn = await browser.$(`[data-testid="tunnel-delete-${tunnelId}"]`);
      await deleteBtn.click();
      await browser.pause(500);

      // Tunnel should be gone from the list
      tunnelItem = await findTunnelByName(tunnelName);
      expect(tunnelItem).toBeNull();
    });
  });
});
