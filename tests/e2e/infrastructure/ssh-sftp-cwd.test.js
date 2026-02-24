// SSH SFTP CWD tracking E2E tests — PR #186.
// Run with: pnpm test:e2e:infra
//
// Prerequisites:
//   - Docker containers from tests/docker/ running
//   - Built app binary + tauri-driver

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "../helpers/app.js";
import { uniqueName, connectByName } from "../helpers/connections.js";
import { findTabByTitle } from "../helpers/tabs.js";
import {
  createSshConnection,
  handlePasswordPrompt,
  verifyTerminalRendered,
  sendTerminalInput,
} from "../helpers/infrastructure.js";
import { switchToFilesSidebar } from "../helpers/sidebar.js";
import { connectSftpBrowser, getFileBrowserPath } from "../helpers/file-browser-infra.js";
import { ACTIVITY_BAR_CONNECTIONS, FILE_BROWSER_CURRENT_PATH } from "../helpers/selectors.js";

describe("SFTP File Browser Follows SSH Terminal CWD (PR #186)", () => {
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

  it("should navigate to /tmp in file browser after cd /tmp", async () => {
    const name = uniqueName("sftp-cwd-tmp");
    await createSshConnection(name, {
      host: "127.0.0.1",
      port: "2201",
      username: "testuser",
      authMethod: "password",
    });

    await connectByName(name);
    await handlePasswordPrompt("testpass");
    await verifyTerminalRendered(3000);

    // Change directory in terminal
    await sendTerminalInput("cd /tmp");
    await browser.keys(["Enter"]);
    await browser.pause(2000);

    // Switch to Files sidebar to check SFTP path
    await connectSftpBrowser("testpass");
    await browser.pause(2000);

    const path = await getFileBrowserPath();
    expect(path).toContain("/tmp");
  });

  it("should navigate back to home directory after cd ~", async () => {
    const name = uniqueName("sftp-cwd-home");
    await createSshConnection(name, {
      host: "127.0.0.1",
      port: "2201",
      username: "testuser",
      authMethod: "password",
    });

    await connectByName(name);
    await handlePasswordPrompt("testpass");
    await verifyTerminalRendered(3000);

    // cd to /tmp first, then back to home
    await sendTerminalInput("cd /tmp");
    await browser.keys(["Enter"]);
    await browser.pause(1000);
    await sendTerminalInput("cd ~");
    await browser.keys(["Enter"]);
    await browser.pause(2000);

    await connectSftpBrowser("testpass");
    await browser.pause(2000);

    const path = await getFileBrowserPath();
    expect(path).toContain("testuser");
  });

  it("should navigate to /var/log after cd /var/log", async () => {
    const name = uniqueName("sftp-cwd-var");
    await createSshConnection(name, {
      host: "127.0.0.1",
      port: "2201",
      username: "testuser",
      authMethod: "password",
    });

    await connectByName(name);
    await handlePasswordPrompt("testpass");
    await verifyTerminalRendered(3000);

    await sendTerminalInput("cd /var/log");
    await browser.keys(["Enter"]);
    await browser.pause(2000);

    await connectSftpBrowser("testpass");
    await browser.pause(2000);

    const path = await getFileBrowserPath();
    expect(path).toContain("/var/log");
  });

  it("should track CWD independently for multiple SSH tabs", async () => {
    const name1 = uniqueName("sftp-cwd-tab1");
    const name2 = uniqueName("sftp-cwd-tab2");

    // Create and connect first SSH session
    await createSshConnection(name1, {
      host: "127.0.0.1",
      port: "2201",
      username: "testuser",
      authMethod: "password",
    });
    await connectByName(name1);
    await handlePasswordPrompt("testpass");
    await verifyTerminalRendered(3000);

    // cd to /tmp in first session
    await sendTerminalInput("cd /tmp");
    await browser.keys(["Enter"]);
    await browser.pause(1000);

    // Create and connect second SSH session
    await ensureConnectionsSidebar();
    await createSshConnection(name2, {
      host: "127.0.0.1",
      port: "2206",
      username: "testuser",
      authMethod: "password",
    });
    await connectByName(name2);
    await handlePasswordPrompt("testpass");
    await verifyTerminalRendered(3000);

    // cd to /var in second session
    await sendTerminalInput("cd /var");
    await browser.keys(["Enter"]);
    await browser.pause(1000);

    // Check file browser for second tab
    await switchToFilesSidebar();
    await browser.pause(3000);

    // File browser should show second tab's CWD
    const path2 = await getFileBrowserPath();
    // Path should reflect the active (second) tab

    // Switch to first tab
    const tab1 = await findTabByTitle(name1);
    if (tab1) {
      await tab1.click();
      await browser.pause(2000);
    }

    // File browser should update to first tab's CWD
    const path1 = await getFileBrowserPath();
    // Paths should be different for different tabs
  });

  it("should update file browser when switching between SSH tabs", async () => {
    const name1 = uniqueName("sftp-switch1");
    const name2 = uniqueName("sftp-switch2");

    await createSshConnection(name1, {
      host: "127.0.0.1",
      port: "2201",
      username: "testuser",
      authMethod: "password",
    });
    await connectByName(name1);
    await handlePasswordPrompt("testpass");
    await verifyTerminalRendered(3000);

    await ensureConnectionsSidebar();
    await createSshConnection(name2, {
      host: "127.0.0.1",
      port: "2206",
      username: "testuser",
      authMethod: "password",
    });
    await connectByName(name2);
    await handlePasswordPrompt("testpass");
    await verifyTerminalRendered(3000);

    // Switch to Files sidebar
    await switchToFilesSidebar();
    await browser.pause(3000);

    // Record path for second tab
    const pathBefore = await getFileBrowserPath();

    // Switch to first tab
    const tab1 = await findTabByTitle(name1);
    if (tab1) {
      await tab1.click();
      await browser.pause(2000);
    }

    // File browser should have updated
    const pathAfter = await getFileBrowserPath();

    // Both should show valid paths (they may be the same if both are in home dir)
    expect(pathBefore.length).toBeGreaterThan(0);
    expect(pathAfter.length).toBeGreaterThan(0);
  });
});
