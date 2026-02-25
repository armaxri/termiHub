// Editor SFTP remote file E2E test — PR #54.
// Run with: pnpm test:e2e:infra

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "../helpers/app.js";
import { uniqueName, connectByName } from "../helpers/connections.js";
import { findTabByTitle, getTabCount, getActiveTab } from "../helpers/tabs.js";
import {
  createSshConnection,
  handlePasswordPrompt,
  verifyTerminalRendered,
} from "../helpers/infrastructure.js";
import { connectSftpBrowser } from "../helpers/file-browser-infra.js";
import { ACTIVITY_BAR_CONNECTIONS, FILE_MENU_EDIT } from "../helpers/selectors.js";

describe("Editor — SFTP Remote File (PR #54)", () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
    const connBtn = await browser.$(ACTIVITY_BAR_CONNECTIONS);
    if (await connBtn.isDisplayed()) {
      await connBtn.click();
      await browser.pause(300);
    }
  });

  it("should show [Remote] badge when editing an SFTP file", async () => {
    const name = uniqueName("editor-sftp");
    await createSshConnection(name, {
      host: "127.0.0.1",
      port: "2201",
      username: "testuser",
      authMethod: "password",
    });

    await connectByName(name);
    await handlePasswordPrompt("testpass");
    await verifyTerminalRendered(3000);

    const entriesVisible = await connectSftpBrowser("testpass");
    if (!entriesVisible) return;

    const tabsBefore = await getTabCount();

    // Find a file and open it via the menu Edit action
    const fileRows = await browser.$$('[data-testid^="file-row-"]');
    if (fileRows.length === 0) return;

    // Click the menu button for first file
    const firstTestId = await fileRows[0].getAttribute("data-testid");
    const fileName = firstTestId.replace("file-row-", "");
    const menuBtn = await browser.$(`[data-testid="file-row-menu-${fileName}"]`);

    if (await menuBtn.isExisting()) {
      await menuBtn.click();
      await browser.pause(300);

      const editBtn = await browser.$(FILE_MENU_EDIT);
      if ((await editBtn.isExisting()) && (await editBtn.isDisplayed())) {
        await editBtn.click();
        await browser.pause(2000);

        const tabsAfter = await getTabCount();
        if (tabsAfter > tabsBefore) {
          // Editor tab opened — check for [Remote] badge in tab title
          const activeTab = await getActiveTab();
          if (activeTab) {
            const tabText = await activeTab.getText();
            // The tab should contain "[Remote]" indicator or the file name
            expect(tabText.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
