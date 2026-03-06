// Config recovery test helpers.

/**
 * Get the platform-specific config directory path.
 * Note: This returns the expected path; actual filesystem access
 * requires Tauri IPC commands.
 */
export function getExpectedConfigDir() {
  if (process.platform === "win32") {
    return `${process.env.APPDATA}\\termihub`;
  }
  if (process.platform === "darwin") {
    return `${process.env.HOME}/Library/Application Support/termihub`;
  }
  return `${process.env.HOME}/.config/termihub`;
}

/**
 * Verify the app recovered from a config issue by checking
 * that the main UI elements are displayed.
 */
export async function verifyAppRecovery() {
  const root = await browser.$("#root");
  expect(await root.isDisplayed()).toBe(true);

  const activityBar = await browser.$('[data-testid="activity-bar-connections"]');
  expect(await activityBar.isDisplayed()).toBe(true);
}
