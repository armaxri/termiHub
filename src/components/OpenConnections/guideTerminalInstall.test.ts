/**
 * Tests for the guided-terminal-install helper (#1309, generalized in #1312).
 * For a `guidedTerminal` install-mode error (today the macOS brew-absent path),
 * termiHub opens a local terminal tab pre-loaded with the dependency's installer
 * so the user drives the real prompts. These assert the tab is opened with the
 * caller-supplied title and the installer as its initial command, and that a
 * missing local shell is handled without opening a tab.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { guideTerminalInstall } from "./guideTerminalInstall";
import { useAppStore } from "@/store/appStore";
import { listAvailableShells } from "@/services/api";

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  listAvailableShells: vi.fn(),
}));

const mockedListShells = vi.mocked(listAvailableShells);

describe("guideTerminalInstall", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens a local terminal tab with the given title and installer command", async () => {
    mockedListShells.mockResolvedValue(["bash", "zsh"]);
    const addTab = vi.spyOn(useAppStore.getState(), "addTab").mockReturnValue("tab-1");
    const cmd = '/bin/bash -c "$(curl -fsSL https://example.test/install.sh)"';

    await guideTerminalInstall(cmd, "Install Homebrew");

    expect(addTab).toHaveBeenCalledTimes(1);
    const [title, connectionType, config] = addTab.mock.calls[0];
    expect(title).toBe("Install Homebrew");
    expect(connectionType).toBe("local");
    expect(config).toMatchObject({
      type: "local",
      config: { shell: "bash", initialCommand: cmd },
    });
    addTab.mockRestore();
  });

  it("does not open a tab when no local shell is available", async () => {
    mockedListShells.mockResolvedValue([]);
    const addTab = vi.spyOn(useAppStore.getState(), "addTab");

    await expect(guideTerminalInstall("installer", "Install Foo")).rejects.toThrow();
    expect(addTab).not.toHaveBeenCalled();
    addTab.mockRestore();
  });
});
