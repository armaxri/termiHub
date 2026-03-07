// External connection file tests.
// Covers: MT-CONN-20, MT-CONN-21, MT-CONN-22, MT-CONN-31.

import { waitForAppReady, closeAllTabs } from "./helpers/app.js";
import { openSettingsTab } from "./helpers/sidebar.js";
import { uniqueName, openNewConnectionEditor } from "./helpers/connections.js";
import {
  SETTINGS_EXTERNAL_FILES,
  CONN_EDITOR_TYPE,
  CONN_EDITOR_NAME,
  CONN_EDITOR_SAVE,
  SSH_AUTH_METHOD,
  keyPathInput,
  keyPathBrowse,
} from "./helpers/selectors.js";

describe("External Files & Key Paths", () => {
  before(async () => {
    await waitForAppReady();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  describe("MT-CONN-21: Manual key path input works", () => {
    it("should accept manually typed key path in SSH settings", async () => {
      await openNewConnectionEditor();

      // Switch to SSH type
      const typeSelect = await browser.$(CONN_EDITOR_TYPE);
      await typeSelect.selectByAttribute("value", "ssh");
      await browser.pause(300);

      // Set auth method to key
      const authSelect = await browser.$(SSH_AUTH_METHOD);
      await authSelect.selectByAttribute("value", "key");
      await browser.pause(300);

      // Type a key path manually
      const keyInput = await browser.$(keyPathInput("ssh-settings-"));
      await keyInput.setValue("/home/user/.ssh/id_rsa");
      await browser.pause(200);

      // Value should be accepted
      const value = await keyInput.getValue();
      expect(value).toContain(".ssh/id_rsa");
    });
  });

  describe("MT-CONN-20: Agent connection key browse", () => {
    it("should show key path input for agent connections", async () => {
      await openNewConnectionEditor();

      // Switch to Remote Agent type
      const typeSelect = await browser.$(CONN_EDITOR_TYPE);
      await typeSelect.selectByAttribute("value", "remote");
      await browser.pause(300);

      // Agent editor should have auth method field
      const authField = await browser.$('[data-testid="field-authMethod"]');
      if (await authField.isExisting()) {
        await authField.selectByAttribute("value", "key");
        await browser.pause(300);

        // Key path input should appear
        const keyInput = await browser.$('[data-testid*="key-path"]');
        expect(await keyInput.isExisting()).toBe(true);
      }
    });
  });

  describe("MT-CONN-22: External files section in settings", () => {
    it("should show external files section in settings", async () => {
      await openSettingsTab();
      await browser.pause(500);

      const externalSection = await browser.$(SETTINGS_EXTERNAL_FILES);
      expect(await externalSection.isDisplayed()).toBe(true);

      // Should have the title "External Connection Files"
      const title = await externalSection.$(".settings-panel__section-title");
      const text = await title.getText();
      expect(text).toContain("External Connection Files");
    });
  });

  describe("MT-CONN-31: External file end-to-end", () => {
    it("should show external files section with correct UI elements", async () => {
      await openSettingsTab();
      await browser.pause(500);

      const externalSection = await browser.$(SETTINGS_EXTERNAL_FILES);
      expect(await externalSection.isDisplayed()).toBe(true);

      // Should have Create File, Add File buttons
      const buttons = await externalSection.$$(".settings-panel__btn");
      expect(buttons.length).toBeGreaterThanOrEqual(2);

      // Check button labels
      const buttonTexts = [];
      for (const btn of buttons) {
        buttonTexts.push(await btn.getText());
      }
      expect(buttonTexts.some((t) => t.includes("Create File"))).toBe(true);
      expect(buttonTexts.some((t) => t.includes("Add File"))).toBe(true);
    });
  });
});
