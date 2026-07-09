/**
 * Tests for the guided-Homebrew-install helper (#1117). On the macOS X-server
 * path, when XQuartz's automatic install needs Homebrew but it isn't installed,
 * termiHub opens a local terminal tab pre-loaded with the official Homebrew
 * installer so the user drives the real prompts. These assert the tab is opened
 * with the installer as its initial command, and that a missing local shell is
 * handled without opening a tab.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { guideHomebrewInstall } from "./guideHomebrewInstall";
import { useAppStore } from "@/store/appStore";
import { listAvailableShells } from "@/services/api";

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  listAvailableShells: vi.fn(),
}));

const mockedListShells = vi.mocked(listAvailableShells);

describe("guideHomebrewInstall", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens a local terminal tab pre-loaded with the installer command", async () => {
    mockedListShells.mockResolvedValue(["bash", "zsh"]);
    const addTab = vi.spyOn(useAppStore.getState(), "addTab").mockReturnValue("tab-1");
    const cmd = '/bin/bash -c "$(curl -fsSL https://example.test/install.sh)"';

    await guideHomebrewInstall(cmd);

    expect(addTab).toHaveBeenCalledTimes(1);
    const [, connectionType, config] = addTab.mock.calls[0];
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

    await expect(guideHomebrewInstall("brew-installer")).rejects.toThrow();
    expect(addTab).not.toHaveBeenCalled();
    addTab.mockRestore();
  });
});
