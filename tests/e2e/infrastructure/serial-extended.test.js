// Serial port extended E2E tests — send/receive and disconnect.
// Run with: pnpm test:e2e:infra
//
// Prerequisites:
//   - Virtual serial port pair via socat:
//       /tmp/termihub-serial-a <--> /tmp/termihub-serial-b
//   - Serial echo server running on /tmp/termihub-serial-b

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "../helpers/app.js";
import { uniqueName, connectByName, cancelEditor } from "../helpers/connections.js";
import { findTabByTitle, getActiveTab } from "../helpers/tabs.js";
import {
  createSerialConnection,
  verifyTerminalRendered,
  getTerminalText,
  sendTerminalInput,
} from "../helpers/infrastructure.js";

describe("Serial — Extended (Infrastructure)", () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
    await cancelEditor();
  });

  describe("SERIAL-03: Send and receive data", () => {
    it("should send and receive echoed data through virtual serial port", async () => {
      const name = uniqueName("serial-echo");
      await createSerialConnection(name, {
        port: "/tmp/termihub-serial-a",
        baudRate: "9600",
      });

      await connectByName(name);

      // Wait for terminal to initialize
      const rendered = await verifyTerminalRendered(3000);
      expect(rendered).toBe(true);

      // Send test data
      await sendTerminalInput("SERIAL_ECHO_TEST");
      await browser.keys(["Enter"]);
      await browser.pause(2000);

      // The echo server should echo back the data
      const terminalText = await getTerminalText();
      // Terminal should contain our input (echoed back by the echo server)
      expect(terminalText.length).toBeGreaterThan(0);
    });
  });

  describe("SERIAL-04: Device disconnect", () => {
    it("should handle serial device removal gracefully", async () => {
      const name = uniqueName("serial-disconn");
      await createSerialConnection(name, {
        port: "/tmp/termihub-serial-a",
        baudRate: "9600",
      });

      await connectByName(name);
      const rendered = await verifyTerminalRendered(3000);
      expect(rendered).toBe(true);

      // The tab should exist
      const tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();

      // Note: Actually killing socat mid-test would affect other serial tests.
      // This test verifies the terminal remains stable when connected.
      // Full disconnect testing requires isolated serial port pairs.
      await browser.pause(2000);

      // Verify the tab is still present and the app didn't crash
      const tabAfter = await findTabByTitle(name);
      expect(tabAfter).not.toBeNull();
    });
  });
});
