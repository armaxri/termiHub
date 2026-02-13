// Connection editor form validation tests.
// Covers: LOCAL-01, SSH/Serial/Telnet form field visibility.

import { waitForAppReady, ensureConnectionsSidebar } from './helpers/app.js';
import { openNewConnectionEditor, setConnectionType, cancelEditor } from './helpers/connections.js';
import {
  CONN_EDITOR_TYPE,
  CONN_EDITOR_NAME,
  CONN_EDITOR_FOLDER,
  CONN_EDITOR_SAVE,
  CONN_EDITOR_CANCEL,
  CONN_EDITOR_HORIZONTAL_SCROLL,
  CONN_EDITOR_COLOR_PICKER,
  SHELL_SELECT,
  SSH_HOST,
  SSH_PORT,
  SSH_USERNAME,
  SSH_AUTH_METHOD,
  SSH_X11_CHECKBOX,
  SERIAL_BAUD_RATE,
  SERIAL_DATA_BITS,
  SERIAL_STOP_BITS,
  SERIAL_PARITY,
  SERIAL_FLOW_CONTROL,
  TELNET_HOST,
  TELNET_PORT,
} from './helpers/selectors.js';

describe('Connection Editor Forms', () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await cancelEditor();
  });

  describe('Common fields', () => {
    it('should show name, folder, type, save, and cancel fields', async () => {
      await openNewConnectionEditor();

      expect(await browser.$(CONN_EDITOR_NAME).isDisplayed()).toBe(true);
      expect(await browser.$(CONN_EDITOR_FOLDER).isDisplayed()).toBe(true);
      expect(await browser.$(CONN_EDITOR_TYPE).isDisplayed()).toBe(true);
      expect(await browser.$(CONN_EDITOR_SAVE).isDisplayed()).toBe(true);
      expect(await browser.$(CONN_EDITOR_CANCEL).isDisplayed()).toBe(true);
      expect(await browser.$(CONN_EDITOR_HORIZONTAL_SCROLL).isDisplayed()).toBe(true);
      expect(await browser.$(CONN_EDITOR_COLOR_PICKER).isDisplayed()).toBe(true);
    });
  });

  describe('Local Shell (LOCAL-01)', () => {
    it('should show shell type dropdown with at least one option', async () => {
      await openNewConnectionEditor();
      // Default type is "local"
      const shellSelect = await browser.$(SHELL_SELECT);
      expect(await shellSelect.isDisplayed()).toBe(true);

      // Verify at least one option is available (platform-dependent)
      const options = await shellSelect.$$('option');
      expect(options.length).toBeGreaterThanOrEqual(1);
    });

    it('should have type selector set to local by default', async () => {
      await openNewConnectionEditor();
      const typeSelect = await browser.$(CONN_EDITOR_TYPE);
      const value = await typeSelect.getValue();
      expect(value).toBe('local');
    });
  });

  describe('SSH form fields', () => {
    it('should show SSH-specific fields when type is SSH', async () => {
      await openNewConnectionEditor();
      await setConnectionType('ssh');

      expect(await browser.$(SSH_HOST).isDisplayed()).toBe(true);
      expect(await browser.$(SSH_PORT).isDisplayed()).toBe(true);
      expect(await browser.$(SSH_USERNAME).isDisplayed()).toBe(true);
      expect(await browser.$(SSH_AUTH_METHOD).isDisplayed()).toBe(true);
      expect(await browser.$(SSH_X11_CHECKBOX).isDisplayed()).toBe(true);
    });

    it('should default SSH port to 22', async () => {
      await openNewConnectionEditor();
      await setConnectionType('ssh');

      const portInput = await browser.$(SSH_PORT);
      const value = await portInput.getValue();
      expect(value).toBe('22');
    });
  });

  describe('Serial form fields', () => {
    it('should show serial-specific fields when type is Serial', async () => {
      await openNewConnectionEditor();
      await setConnectionType('serial');

      expect(await browser.$(SERIAL_BAUD_RATE).isDisplayed()).toBe(true);
      expect(await browser.$(SERIAL_DATA_BITS).isDisplayed()).toBe(true);
      expect(await browser.$(SERIAL_STOP_BITS).isDisplayed()).toBe(true);
      expect(await browser.$(SERIAL_PARITY).isDisplayed()).toBe(true);
      expect(await browser.$(SERIAL_FLOW_CONTROL).isDisplayed()).toBe(true);
    });
  });

  describe('Telnet form fields', () => {
    it('should show telnet-specific fields when type is Telnet', async () => {
      await openNewConnectionEditor();
      await setConnectionType('telnet');

      expect(await browser.$(TELNET_HOST).isDisplayed()).toBe(true);
      expect(await browser.$(TELNET_PORT).isDisplayed()).toBe(true);
    });

    it('should default Telnet port to 23', async () => {
      await openNewConnectionEditor();
      await setConnectionType('telnet');

      const portInput = await browser.$(TELNET_PORT);
      const value = await portInput.getValue();
      expect(value).toBe('23');
    });
  });
});
