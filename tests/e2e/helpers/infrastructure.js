// Helpers for infrastructure E2E tests (SSH, Telnet, Serial).
// These tests require live servers — see scripts/test-system.sh.

import {
  CONN_EDITOR_NAME,
  CONN_EDITOR_SAVE,
  SSH_HOST,
  SSH_PORT,
  SSH_USERNAME,
  SSH_AUTH_METHOD,
  TELNET_HOST,
  TELNET_PORT,
  SERIAL_PORT_SELECT,
  SERIAL_PORT_INPUT,
  SERIAL_BAUD_RATE,
  PASSWORD_PROMPT_INPUT,
  PASSWORD_PROMPT_CONNECT,
} from './selectors.js';
import { openNewConnectionEditor, setConnectionType } from './connections.js';

/**
 * Create an SSH connection in the editor and save it.
 * Assumes the Connections sidebar is already visible.
 * @param {string} name - Connection display name
 * @param {object} opts - SSH settings
 * @param {string} opts.host - SSH host (default '127.0.0.1')
 * @param {string} opts.port - SSH port (default '2222')
 * @param {string} opts.username - SSH username (default 'testuser')
 * @param {string} [opts.authMethod] - Auth method value (default 'password')
 */
export async function createSshConnection(name, opts = {}) {
  const { host = '127.0.0.1', port = '2222', username = 'testuser', authMethod = 'password' } = opts;

  await openNewConnectionEditor();
  const nameInput = await browser.$(CONN_EDITOR_NAME);
  await nameInput.setValue(name);

  await setConnectionType('ssh');

  const hostInput = await browser.$(SSH_HOST);
  await hostInput.clearValue();
  await hostInput.setValue(host);

  const portInput = await browser.$(SSH_PORT);
  await portInput.clearValue();
  await portInput.setValue(port);

  const usernameInput = await browser.$(SSH_USERNAME);
  await usernameInput.clearValue();
  await usernameInput.setValue(username);

  // Set auth method if selector is available
  if (authMethod) {
    const authSelect = await browser.$(SSH_AUTH_METHOD);
    if (await authSelect.isDisplayed()) {
      await authSelect.selectByAttribute('value', authMethod);
      await browser.pause(200);
    }
  }

  const saveBtn = await browser.$(CONN_EDITOR_SAVE);
  await saveBtn.click();
  await browser.pause(300);
  return name;
}

/**
 * Create a Telnet connection in the editor and save it.
 * Assumes the Connections sidebar is already visible.
 * @param {string} name - Connection display name
 * @param {object} opts - Telnet settings
 * @param {string} opts.host - Telnet host (default '127.0.0.1')
 * @param {string} opts.port - Telnet port (default '2323')
 */
export async function createTelnetConnection(name, opts = {}) {
  const { host = '127.0.0.1', port = '2323' } = opts;

  await openNewConnectionEditor();
  const nameInput = await browser.$(CONN_EDITOR_NAME);
  await nameInput.setValue(name);

  await setConnectionType('telnet');

  const hostInput = await browser.$(TELNET_HOST);
  await hostInput.clearValue();
  await hostInput.setValue(host);

  const portInput = await browser.$(TELNET_PORT);
  await portInput.clearValue();
  await portInput.setValue(port);

  const saveBtn = await browser.$(CONN_EDITOR_SAVE);
  await saveBtn.click();
  await browser.pause(300);
  return name;
}

/**
 * Create a Serial connection in the editor and save it.
 * Assumes the Connections sidebar is already visible.
 * @param {string} name - Connection display name
 * @param {object} opts - Serial settings
 * @param {string} opts.port - Serial port path (default '/tmp/termihub-serial-a')
 * @param {string} [opts.baudRate] - Baud rate value (default '9600')
 */
export async function createSerialConnection(name, opts = {}) {
  const { port = '/tmp/termihub-serial-a', baudRate = '9600' } = opts;

  await openNewConnectionEditor();
  const nameInput = await browser.$(CONN_EDITOR_NAME);
  await nameInput.setValue(name);

  await setConnectionType('serial');

  // The serial port UI shows a <select> when system ports are detected,
  // or a text <input> when no ports are found.
  const portSelect = await browser.$(SERIAL_PORT_SELECT);
  const portInput = await browser.$(SERIAL_PORT_INPUT);

  if (await portInput.isExisting() && await portInput.isDisplayed()) {
    // No system ports detected — type the path manually
    await portInput.clearValue();
    await portInput.setValue(port);
  } else if (await portSelect.isExisting() && await portSelect.isDisplayed()) {
    // System ports detected — try to select by value
    try {
      await portSelect.selectByAttribute('value', port);
    } catch {
      // The virtual port path may not be in the dropdown options.
      // This is expected when socat ports aren't enumerated by serialport crate.
    }
    await browser.pause(200);
  }

  // Set baud rate if the select is available
  if (baudRate) {
    const baudSelect = await browser.$(SERIAL_BAUD_RATE);
    if (await baudSelect.isDisplayed()) {
      await baudSelect.selectByAttribute('value', baudRate);
      await browser.pause(200);
    }
  }

  const saveBtn = await browser.$(CONN_EDITOR_SAVE);
  await saveBtn.click();
  await browser.pause(300);
  return name;
}

/**
 * Handle the SSH password prompt dialog.
 * Waits for the prompt to appear, enters the password, and clicks Connect.
 * @param {string} password - Password to enter (default 'testpass')
 * @param {number} timeout - Max wait for prompt (default 10000ms)
 */
export async function handlePasswordPrompt(password = 'testpass', timeout = 10000) {
  const input = await browser.$(PASSWORD_PROMPT_INPUT);
  await input.waitForDisplayed({ timeout });
  await input.setValue(password);

  const connectBtn = await browser.$(PASSWORD_PROMPT_CONNECT);
  await connectBtn.click();
  await browser.pause(500);
}

/**
 * Verify that an xterm terminal has been rendered in the terminal area.
 * Checks for the xterm container and optionally the canvas element.
 * @param {number} waitMs - Time to wait for xterm to initialize (default 2000ms)
 * @returns {Promise<boolean>} true if terminal is rendered
 */
export async function verifyTerminalRendered(waitMs = 2000) {
  await browser.pause(waitMs);

  const xtermContainer = await browser.$('.xterm');
  const containerExists = await xtermContainer.isExisting();

  if (containerExists) return true;

  // Fallback: check for the canvas inside xterm-screen
  const canvas = await browser.$('.xterm-screen canvas');
  return canvas.isExisting();
}
