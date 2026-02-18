// Serial port E2E tests — requires virtual serial ports via socat.
// Run with: pnpm test:e2e:infra
// Full setup: ./scripts/test-system.sh
//
// Prerequisites:
//   - Virtual serial port pair via socat:
//       /tmp/termihub-serial-a <--> /tmp/termihub-serial-b
//     (see examples/scripts/setup-virtual-serial.sh)
//   - Serial echo server running on /tmp/termihub-serial-b
//     (see examples/serial/serial-echo-server.py)
//   - Built app binary (pnpm tauri build)
//   - tauri-driver installed (cargo install tauri-driver)

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from '../helpers/app.js';
import { uniqueName, connectByName, openNewConnectionEditor, setConnectionType, cancelEditor } from '../helpers/connections.js';
import { findTabByTitle, getActiveTab } from '../helpers/tabs.js';
import {
  createSerialConnection,
  verifyTerminalRendered,
} from '../helpers/infrastructure.js';
import {
  SERIAL_PORT_SELECT,
  SERIAL_PORT_INPUT,
  SERIAL_BAUD_RATE,
  SERIAL_DATA_BITS,
  SERIAL_STOP_BITS,
  SERIAL_PARITY,
  SERIAL_FLOW_CONTROL,
} from '../helpers/selectors.js';

describe('Serial Connections (requires virtual port)', () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
    await cancelEditor();
  });

  describe('SERIAL-01: Port enumeration', () => {
    it('should display serial port field when type is Serial', async () => {
      await openNewConnectionEditor();
      await setConnectionType('serial');

      // The UI shows either a <select> (ports detected) or an <input> (no ports)
      const portSelect = await browser.$(SERIAL_PORT_SELECT);
      const portInput = await browser.$(SERIAL_PORT_INPUT);

      const selectVisible = await portSelect.isExisting() && await portSelect.isDisplayed();
      const inputVisible = await portInput.isExisting() && await portInput.isDisplayed();

      // One of them must be displayed
      expect(selectVisible || inputVisible).toBe(true);
    });

    it('should display all serial configuration fields', async () => {
      await openNewConnectionEditor();
      await setConnectionType('serial');

      expect(await browser.$(SERIAL_BAUD_RATE).isDisplayed()).toBe(true);
      expect(await browser.$(SERIAL_DATA_BITS).isDisplayed()).toBe(true);
      expect(await browser.$(SERIAL_STOP_BITS).isDisplayed()).toBe(true);
      expect(await browser.$(SERIAL_PARITY).isDisplayed()).toBe(true);
      expect(await browser.$(SERIAL_FLOW_CONTROL).isDisplayed()).toBe(true);
    });
  });

  describe('SERIAL-02: Connect at common baud rates', () => {
    it('should connect to virtual serial port at 9600 baud', async () => {
      const name = uniqueName('serial-9600');
      await createSerialConnection(name, {
        port: '/tmp/termihub-serial-a',
        baudRate: '9600',
      });

      // Double-click to connect
      await connectByName(name);

      // Verify a terminal tab appeared
      const tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();

      const active = await getActiveTab();
      expect(active).not.toBeNull();
      const activeText = await active.getText();
      expect(activeText).toContain(name);
    });

    it('should render an xterm terminal for serial connection', async () => {
      const name = uniqueName('serial-xterm');
      await createSerialConnection(name, {
        port: '/tmp/termihub-serial-a',
        baudRate: '9600',
      });

      await connectByName(name);

      // Verify xterm rendered
      const rendered = await verifyTerminalRendered();
      expect(rendered).toBe(true);
    });
  });

  // Send/receive verification requires reading xterm canvas content,
  // which is not straightforward in WebdriverIO.
  it('SERIAL-03: should send and receive data');

  // Disconnect handling requires stopping socat mid-test.
  it('SERIAL-04: should handle device disconnect');

  describe('SERIAL-05: Non-default config parameters', () => {
    it('should allow selecting non-default baud rate, parity, and flow control', async () => {
      await openNewConnectionEditor();
      await setConnectionType('serial');

      // Set non-default baud rate
      const baudSelect = await browser.$(SERIAL_BAUD_RATE);
      await baudSelect.selectByAttribute('value', '115200');
      const baudValue = await baudSelect.getValue();
      expect(baudValue).toBe('115200');

      // Set non-default parity
      const paritySelect = await browser.$(SERIAL_PARITY);
      await paritySelect.selectByAttribute('value', 'even');
      const parityValue = await paritySelect.getValue();
      expect(parityValue).toBe('even');

      // Set non-default flow control
      const flowSelect = await browser.$(SERIAL_FLOW_CONTROL);
      await flowSelect.selectByAttribute('value', 'hardware');
      const flowValue = await flowSelect.getValue();
      expect(flowValue).toBe('hardware');

      // Set non-default data bits
      const dataSelect = await browser.$(SERIAL_DATA_BITS);
      await dataSelect.selectByAttribute('value', '7');
      const dataValue = await dataSelect.getValue();
      expect(dataValue).toBe('7');

      // Set non-default stop bits
      const stopSelect = await browser.$(SERIAL_STOP_BITS);
      await stopSelect.selectByAttribute('value', '2');
      const stopValue = await stopSelect.getValue();
      expect(stopValue).toBe('2');
    });
  });
});
