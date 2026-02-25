// Encrypted export/import dialog tests.
// Covers: EXP-ENC-01 through EXP-ENC-04 (PR #322).

import { waitForAppReady, closeAllTabs } from "./helpers/app.js";
import {
  ACTIVITY_BAR_SETTINGS,
  SETTINGS_MENU_EXPORT,
  EXPORT_PASSWORD,
  EXPORT_CONFIRM_PASSWORD,
  EXPORT_SUBMIT,
} from "./helpers/selectors.js";

/**
 * Open the Export Connections dialog via the settings gear dropdown.
 */
async function openExportDialog() {
  const gear = await browser.$(ACTIVITY_BAR_SETTINGS);
  await gear.waitForDisplayed({ timeout: 5000 });
  await gear.click();
  await browser.pause(300);

  const exportItem = await browser.$(SETTINGS_MENU_EXPORT);
  await exportItem.waitForDisplayed({ timeout: 3000 });
  await exportItem.click();
  await browser.pause(300);
}

/**
 * Select the "With credentials (encrypted)" radio option in the export dialog.
 */
async function selectEncryptedMode() {
  const radioLabels = await browser.$$(".export-dialog__radio-label");
  for (const label of radioLabels) {
    const text = await label.getText();
    if (text.includes("With credentials")) {
      await label.click();
      await browser.pause(300);
      return;
    }
  }
  throw new Error('Could not find "With credentials (encrypted)" radio option');
}

/**
 * Close the export dialog by pressing Escape or clicking Cancel.
 */
async function closeExportDialog() {
  await browser.keys("Escape");
  await browser.pause(300);
}

describe("Encrypted Export/Import (PR #322)", () => {
  before(async () => {
    await waitForAppReady();
  });

  afterEach(async () => {
    // Dismiss any open dialog
    await browser.keys("Escape");
    await browser.pause(200);
    await closeAllTabs();
  });

  describe("EXP-ENC-01: Export dialog default state", () => {
    it('should open export dialog with "Without credentials" selected by default', async () => {
      await openExportDialog();

      // The export dialog title should be visible
      const title = await browser.$(".export-dialog__title");
      await title.waitForDisplayed({ timeout: 3000 });
      expect(await title.getText()).toContain("Export Connections");

      // "Without credentials" radio should be checked by default
      const radioLabels = await browser.$$(".export-dialog__radio-label");
      let plainChecked = false;
      for (const label of radioLabels) {
        const text = await label.getText();
        if (text.includes("Without credentials")) {
          const radio = await label.$('input[type="radio"]');
          plainChecked = await radio.isSelected();
        }
      }
      expect(plainChecked).toBe(true);

      // Password fields should NOT be visible in plain mode
      const passwordInput = await browser.$(EXPORT_PASSWORD);
      const passwordVisible =
        (await passwordInput.isExisting()) && (await passwordInput.isDisplayed());
      expect(passwordVisible).toBe(false);

      await closeExportDialog();
    });
  });

  describe("EXP-ENC-02: Encrypted mode shows password fields", () => {
    it('should show password fields and warning when selecting "With credentials (encrypted)"', async () => {
      await openExportDialog();
      await selectEncryptedMode();

      // Password input should now be visible
      const passwordInput = await browser.$(EXPORT_PASSWORD);
      await passwordInput.waitForDisplayed({ timeout: 3000 });
      expect(await passwordInput.isDisplayed()).toBe(true);

      // Confirm password input should be visible
      const confirmInput = await browser.$(EXPORT_CONFIRM_PASSWORD);
      expect(await confirmInput.isDisplayed()).toBe(true);

      // Warning text about AES-256-GCM encryption should be visible
      const warning = await browser.$(".export-dialog__warning");
      expect(await warning.isDisplayed()).toBe(true);
      const warningText = await warning.getText();
      expect(warningText).toContain("encrypted");

      await closeExportDialog();
    });
  });

  describe("EXP-ENC-03: Short password validation", () => {
    it('should show "Password must be at least 8 characters" for short passwords', async () => {
      await openExportDialog();
      await selectEncryptedMode();

      // Type a password shorter than 8 characters
      const passwordInput = await browser.$(EXPORT_PASSWORD);
      await passwordInput.waitForDisplayed({ timeout: 3000 });
      await passwordInput.setValue("short");
      await browser.pause(300);

      // Error message should be displayed
      const errorEl = await browser.$(".export-dialog__error");
      await errorEl.waitForDisplayed({ timeout: 3000 });
      const errorText = await errorEl.getText();
      expect(errorText).toContain("Password must be at least 8 characters");

      // Submit button should be disabled
      const submitBtn = await browser.$(EXPORT_SUBMIT);
      expect(await submitBtn.isEnabled()).toBe(false);

      await closeExportDialog();
    });
  });

  describe("EXP-ENC-04: Mismatched password validation", () => {
    it('should show "Passwords do not match" when passwords differ', async () => {
      await openExportDialog();
      await selectEncryptedMode();

      // Type a valid-length password
      const passwordInput = await browser.$(EXPORT_PASSWORD);
      await passwordInput.waitForDisplayed({ timeout: 3000 });
      await passwordInput.setValue("validpassword123");
      await browser.pause(200);

      // Type a different confirm password
      const confirmInput = await browser.$(EXPORT_CONFIRM_PASSWORD);
      await confirmInput.setValue("differentpassword");
      await browser.pause(300);

      // Error message should be displayed
      const errorEl = await browser.$(".export-dialog__error");
      await errorEl.waitForDisplayed({ timeout: 3000 });
      const errorText = await errorEl.getText();
      expect(errorText).toContain("Passwords do not match");

      // Submit button should be disabled
      const submitBtn = await browser.$(EXPORT_SUBMIT);
      expect(await submitBtn.isEnabled()).toBe(false);

      await closeExportDialog();
    });
  });
});
