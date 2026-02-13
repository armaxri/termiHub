// tests/e2e/terminal-creation.test.js
describe('Terminal Creation and Management', () => {
  describe('Local Shell Terminal', () => {
    it('should create and open a bash terminal', async () => {
      // Open connections sidebar
      const activityBar = await browser.$('[data-testid="activity-bar-connections"]');
      await activityBar.waitForDisplayed({ timeout: 5000 });
      await activityBar.click();

      // Click "New Connection" button
      const newConnBtn = await browser.$('[data-testid="new-connection-btn"]');
      await newConnBtn.waitForDisplayed();
      await newConnBtn.click();

      // Select "Local Shell" connection type
      const localType = await browser.$('[data-testid="connection-type-local"]');
      await localType.waitForDisplayed();
      await localType.click();

      // Select bash shell (if available)
      const bashOption = await browser.$('[data-testid="shell-type-bash"]');
      if (await bashOption.isDisplayed()) {
        await bashOption.click();
      }

      // Enter connection name
      const nameInput = await browser.$('[data-testid="connection-name-input"]');
      await nameInput.setValue('E2E Test Bash');

      // Save connection
      const saveBtn = await browser.$('[data-testid="save-connection-btn"]');
      await saveBtn.click();

      // Verify connection appears in list
      const connection = await browser.$('[data-testid="connection-E2E Test Bash"]');
      await connection.waitForDisplayed({ timeout: 3000 });
      expect(await connection.isDisplayed()).toBe(true);

      // Double-click to open terminal
      await connection.doubleClick();

      // Verify terminal tab opened
      const tab = await browser.$('[data-testid="tab-E2E Test Bash"]');
      await tab.waitForDisplayed({ timeout: 5000 });
      expect(await tab.isDisplayed()).toBe(true);

      // Verify terminal viewport is active
      const terminal = await browser.$('[data-testid="terminal-viewport"]');
      await terminal.waitForDisplayed();
      expect(await terminal.isDisplayed()).toBe(true);
    });

    it('should allow typing commands in terminal', async () => {
      // Assume terminal is already open from previous test
      const terminal = await browser.$('[data-testid="terminal-viewport"]');
      await terminal.waitForDisplayed();

      // Click to focus
      await terminal.click();

      // Type command
      await browser.keys(['e', 'c', 'h', 'o', ' ', 't', 'e', 's', 't']);
      await browser.keys('Enter');

      // Wait a bit for output
      await browser.pause(1000);

      // Note: Actual output verification would require reading terminal content
      // This is more complex and might need custom Tauri commands
    });
  });

  describe('SSH Terminal', () => {
    it('should show SSH configuration form', async () => {
      // Open new connection dialog
      await browser.$('[data-testid="new-connection-btn"]').click();

      // Select SSH type
      const sshType = await browser.$('[data-testid="connection-type-ssh"]');
      await sshType.waitForDisplayed();
      await sshType.click();

      // Verify SSH-specific fields appear
      const hostInput = await browser.$('[data-testid="ssh-host-input"]');
      const portInput = await browser.$('[data-testid="ssh-port-input"]');
      const usernameInput = await browser.$('[data-testid="ssh-username-input"]');

      expect(await hostInput.isDisplayed()).toBe(true);
      expect(await portInput.isDisplayed()).toBe(true);
      expect(await usernameInput.isDisplayed()).toBe(true);
    });

    it('should show X11 forwarding options', async () => {
      // Assuming SSH form is already open
      const x11Checkbox = await browser.$('[data-testid="ssh-enable-x11"]');
      await x11Checkbox.waitForDisplayed();

      // Enable X11 forwarding
      await x11Checkbox.click();

      // Verify X11 status panel appears
      const x11Status = await browser.$('[data-testid="x11-status-panel"]');
      await x11Status.waitForDisplayed();
      expect(await x11Status.isDisplayed()).toBe(true);
    });
  });

  describe('Serial Port Connection', () => {
    it('should show serial port configuration', async () => {
      await browser.$('[data-testid="new-connection-btn"]').click();

      const serialType = await browser.$('[data-testid="connection-type-serial"]');
      await serialType.waitForDisplayed();
      await serialType.click();

      // Verify serial-specific fields
      const portSelect = await browser.$('[data-testid="serial-port-select"]');
      const baudRateSelect = await browser.$('[data-testid="serial-baud-rate-select"]');

      expect(await portSelect.isDisplayed()).toBe(true);
      expect(await baudRateSelect.isDisplayed()).toBe(true);
    });
  });

  describe('Tab Management', () => {
    beforeEach(async () => {
      // Create 3 test terminals
      for (let i = 1; i <= 3; i++) {
        await browser.$('[data-testid="new-connection-btn"]').click();
        await browser.$('[data-testid="connection-type-local"]').click();
        await browser.$('[data-testid="connection-name-input"]').setValue(`Tab ${i}`);
        await browser.$('[data-testid="save-connection-btn"]').click();
        await browser.$(`[data-testid="connection-Tab ${i}"]`).doubleClick();
      }
    });

    it('should show multiple tabs', async () => {
      const tab1 = await browser.$('[data-testid="tab-Tab 1"]');
      const tab2 = await browser.$('[data-testid="tab-Tab 2"]');
      const tab3 = await browser.$('[data-testid="tab-Tab 3"]');

      expect(await tab1.isDisplayed()).toBe(true);
      expect(await tab2.isDisplayed()).toBe(true);
      expect(await tab3.isDisplayed()).toBe(true);
    });

    it('should switch between tabs when clicked', async () => {
      const tab2 = await browser.$('[data-testid="tab-Tab 2"]');
      await tab2.click();

      // Verify tab is now active
      const activeClass = await tab2.getAttribute('class');
      expect(activeClass).toContain('active');
    });

    it('should close tab when close button clicked', async () => {
      const closeBtn = await browser.$('[data-testid="tab-Tab 1"] [data-testid="tab-close-btn"]');
      await closeBtn.click();

      // Verify tab is gone
      const tab1 = await browser.$('[data-testid="tab-Tab 1"]');
      expect(await tab1.isDisplayed()).toBe(false);
    });

    it('should support drag and drop to reorder tabs', async () => {
      const tab1 = await browser.$('[data-testid="tab-Tab 1"]');
      const tab3 = await browser.$('[data-testid="tab-Tab 3"]');

      // Drag tab1 to tab3 position
      await tab1.dragAndDrop(tab3);

      // Verify order changed
      const tabs = await browser.$$('[data-testid^="tab-"]');
      const order = await Promise.all(tabs.map(t => t.getText()));

      // Tab 1 should now be after Tab 3
      expect(order.indexOf('Tab 1')).toBeGreaterThan(order.indexOf('Tab 3'));
    });
  });

  describe('Split View', () => {
    it('should split terminal view horizontally', async () => {
      // Open a terminal first
      await browser.$('[data-testid="new-connection-btn"]').click();
      await browser.$('[data-testid="connection-type-local"]').click();
      await browser.$('[data-testid="connection-name-input"]').setValue('Split Test');
      await browser.$('[data-testid="save-connection-btn"]').click();
      await browser.$('[data-testid="connection-Split Test"]').doubleClick();

      // Click split view button
      const splitBtn = await browser.$('[data-testid="split-horizontal-btn"]');
      await splitBtn.waitForDisplayed();
      await splitBtn.click();

      // Verify two terminal panes exist
      const panes = await browser.$$('[data-testid="terminal-pane"]');
      expect(panes.length).toBe(2);
    });
  });

  describe('Connection Organization', () => {
    it('should create folder for connections', async () => {
      const newFolderBtn = await browser.$('[data-testid="new-folder-btn"]');
      await newFolderBtn.waitForDisplayed();
      await newFolderBtn.click();

      const folderNameInput = await browser.$('[data-testid="folder-name-input"]');
      await folderNameInput.setValue('Test Equipment');

      const saveFolderBtn = await browser.$('[data-testid="save-folder-btn"]');
      await saveFolderBtn.click();

      // Verify folder appears
      const folder = await browser.$('[data-testid="folder-Test Equipment"]');
      expect(await folder.isDisplayed()).toBe(true);
    });

    it('should drag connection into folder', async () => {
      // Assuming folder and connection exist
      const connection = await browser.$('[data-testid="connection-E2E Test Bash"]');
      const folder = await browser.$('[data-testid="folder-Test Equipment"]');

      await connection.dragAndDrop(folder);

      // Expand folder
      const folderExpand = await browser.$('[data-testid="folder-Test Equipment-expand"]');
      await folderExpand.click();

      // Verify connection is now inside folder
      const connectionInFolder = await browser.$('[data-testid="folder-Test Equipment"] [data-testid="connection-E2E Test Bash"]');
      expect(await connectionInFolder.isDisplayed()).toBe(true);
    });
  });

  afterEach(async () => {
    // Cleanup: Close all tabs, delete test connections
    // This prevents test pollution
    const closeBtns = await browser.$$('[data-testid$="-close-btn"]');
    for (const btn of closeBtns) {
      if (await btn.isDisplayed()) {
        await btn.click();
      }
    }
  });
});
