// Tunnel operation helpers for infrastructure E2E tests.

import {
  TUNNEL_SIDEBAR,
  TUNNEL_NEW_BTN,
  TUNNEL_EDITOR_NAME,
  TUNNEL_EDITOR_SSH_CONNECTION,
  TUNNEL_EDITOR_SAVE,
  TUNNEL_EDITOR_SAVE_START,
  TUNNEL_TYPE_LOCAL,
  TUNNEL_TYPE_REMOTE,
  TUNNEL_TYPE_DYNAMIC,
  tunnelStart,
  tunnelStop,
  tunnelStatus,
} from "./selectors.js";
import { handlePasswordPrompt } from "./infrastructure.js";

/**
 * Switch to the SSH Tunnels sidebar.
 */
export async function switchToTunnelsSidebar() {
  const sidebar = await browser.$(TUNNEL_SIDEBAR);
  // The tunnel sidebar is accessed via the activity bar or within the connections sidebar.
  // If not already visible, we may need to click an activity bar item.
  if (!(await sidebar.isExisting())) {
    // Tunnel sidebar might be toggled via activity bar or connections sidebar tab.
    // Try clicking the connections activity bar first.
    const connectionsBtn = await browser.$('[data-testid="activity-bar-connections"]');
    await connectionsBtn.click();
    await browser.pause(300);
  }
}

/**
 * Create a tunnel with specific port configuration.
 * @param {string} name - Tunnel display name
 * @param {string} sshConnectionName - Name of the SSH connection to use
 * @param {object} opts - Tunnel configuration
 * @param {'local'|'remote'|'dynamic'} opts.type - Tunnel type (default 'local')
 * @param {string} [opts.localPort] - Local port
 * @param {string} [opts.remoteHost] - Remote host (default 'localhost')
 * @param {string} [opts.remotePort] - Remote port
 * @returns {Promise<void>}
 */
export async function createTunnelWithPorts(name, sshConnectionName, opts = {}) {
  const { type = "local", localPort, remoteHost, remotePort } = opts;

  const newBtn = await browser.$(TUNNEL_NEW_BTN);
  await newBtn.waitForDisplayed({ timeout: 5000 });
  await newBtn.click();
  await browser.pause(300);

  // Set tunnel name
  const nameInput = await browser.$(TUNNEL_EDITOR_NAME);
  await nameInput.waitForDisplayed({ timeout: 3000 });
  await nameInput.clearValue();
  await nameInput.setValue(name);

  // Select SSH connection
  const sshSelect = await browser.$(TUNNEL_EDITOR_SSH_CONNECTION);
  await sshSelect.selectByVisibleText(sshConnectionName);
  await browser.pause(200);

  // Select tunnel type
  const typeMap = {
    local: TUNNEL_TYPE_LOCAL,
    remote: TUNNEL_TYPE_REMOTE,
    dynamic: TUNNEL_TYPE_DYNAMIC,
  };
  const typeBtn = await browser.$(typeMap[type] || TUNNEL_TYPE_LOCAL);
  await typeBtn.click();
  await browser.pause(200);

  // Set port fields if provided
  if (localPort) {
    const localPortInput = await browser.$('[data-testid="tunnel-editor-local-port"]');
    if (await localPortInput.isExisting()) {
      await localPortInput.clearValue();
      await localPortInput.setValue(localPort);
    }
  }

  if (remoteHost) {
    const remoteHostInput = await browser.$('[data-testid="tunnel-editor-remote-host"]');
    if (await remoteHostInput.isExisting()) {
      await remoteHostInput.clearValue();
      await remoteHostInput.setValue(remoteHost);
    }
  }

  if (remotePort) {
    const remotePortInput = await browser.$('[data-testid="tunnel-editor-remote-port"]');
    if (await remotePortInput.isExisting()) {
      await remotePortInput.clearValue();
      await remotePortInput.setValue(remotePort);
    }
  }
}

/**
 * Save the current tunnel editor.
 */
export async function saveTunnel() {
  const saveBtn = await browser.$(TUNNEL_EDITOR_SAVE);
  await saveBtn.click();
  await browser.pause(300);
}

/**
 * Save and start the current tunnel editor.
 * May trigger a password prompt for the SSH connection.
 * @param {string} [sshPassword] - Password if needed
 */
export async function saveAndStartTunnel(sshPassword) {
  const btn = await browser.$(TUNNEL_EDITOR_SAVE_START);
  await btn.click();
  await browser.pause(500);

  if (sshPassword) {
    try {
      await handlePasswordPrompt(sshPassword, 5000);
    } catch {
      // Password prompt may not appear if key auth is used
    }
  }
  await browser.pause(1000);
}

/**
 * Get the status of a tunnel by its ID.
 * Checks the class or attribute of the status dot element.
 * @param {string} tunnelId - Tunnel ID
 * @returns {Promise<string>} 'connected' | 'disconnected' | 'unknown'
 */
export async function getTunnelStatus(tunnelId) {
  const statusEl = await browser.$(tunnelStatus(tunnelId));
  if (!(await statusEl.isExisting())) return "unknown";
  const cls = await statusEl.getAttribute("class");
  if (cls && cls.includes("connected")) return "connected";
  if (cls && cls.includes("disconnected")) return "disconnected";
  return "unknown";
}

/**
 * Start a tunnel by clicking its play button.
 * @param {string} tunnelId - Tunnel ID
 * @param {string} [sshPassword] - Password for SSH connection if needed
 */
export async function startTunnelById(tunnelId, sshPassword) {
  const btn = await browser.$(tunnelStart(tunnelId));
  await btn.waitForDisplayed({ timeout: 5000 });
  await btn.click();
  await browser.pause(500);

  if (sshPassword) {
    try {
      await handlePasswordPrompt(sshPassword, 5000);
    } catch {
      // Password prompt may not appear
    }
  }
  await browser.pause(1000);
}

/**
 * Stop a tunnel by clicking its stop button.
 * @param {string} tunnelId - Tunnel ID
 */
export async function stopTunnelById(tunnelId) {
  const btn = await browser.$(tunnelStop(tunnelId));
  await btn.waitForDisplayed({ timeout: 5000 });
  await btn.click();
  await browser.pause(500);
}
