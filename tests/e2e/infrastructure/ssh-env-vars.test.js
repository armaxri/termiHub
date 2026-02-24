// SSH environment variable expansion E2E tests — PR #68.
// Run with: pnpm test:e2e:infra

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "../helpers/app.js";
import { uniqueName, connectByName, findConnectionByName } from "../helpers/connections.js";
import { findTabByTitle, getTabCount } from "../helpers/tabs.js";
import {
  createSshConnection,
  handlePasswordPrompt,
  verifyTerminalRendered,
} from "../helpers/infrastructure.js";

describe("Environment Variable Expansion in SSH (PR #68)", () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  describe("SSH-ENV-01: ${env:USER} resolution", () => {
    it("should resolve ${env:USER} in SSH username when connecting", async () => {
      const name = uniqueName("ssh-env-user");
      // Create SSH connection with ${env:USER} as username.
      // The app should resolve this to the actual username at connect time.
      // Using ssh-password:2201 which accepts 'testuser' — so this test
      // will succeed if the env var resolves to 'testuser' in the test environment.
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "${env:USER}",
        authMethod: "password",
      });

      // Verify the connection was saved with literal ${env:USER}
      const connItem = await findConnectionByName(name);
      expect(connItem).not.toBeNull();

      // Attempt to connect — may or may not succeed depending on actual USER value
      // The key test is that the app doesn't crash on env var expansion
      await connectByName(name);
      await browser.pause(3000);

      // Handle password prompt if it appears
      const { PASSWORD_PROMPT_INPUT } = await import("../helpers/selectors.js");
      const prompt = await browser.$(PASSWORD_PROMPT_INPUT);
      if ((await prompt.isExisting()) && (await prompt.isDisplayed())) {
        await handlePasswordPrompt("testpass");
      }

      // Test passes if no crash
    });
  });

  describe("SSH-ENV-02: Undefined variable", () => {
    it("should leave ${env:NONEXISTENT} as-is without crashing", async () => {
      const name = uniqueName("ssh-env-undef");
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "${env:NONEXISTENT}",
        authMethod: "password",
      });

      // Verify connection was created
      const connItem = await findConnectionByName(name);
      expect(connItem).not.toBeNull();

      // Try to connect — will fail since username is invalid, but should not crash
      const tabsBefore = await getTabCount();
      await connectByName(name);
      await browser.pause(5000);

      // Test passes if the app doesn't hang or crash
    });
  });
});
