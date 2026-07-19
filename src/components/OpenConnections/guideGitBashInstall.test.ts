/**
 * Tests for the guided Git-for-Windows install helpers (#1672). These reuse the
 * existing guided-terminal-install primitive rather than building new infra:
 * `guideGitForWindowsInstall` opens a local tab pre-loaded with the winget
 * command, and `openGitForWindowsDownload` deep-links the official installer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "@/store/appStore";
import { listAvailableShells } from "@/services/api";
import { GIT_FOR_WINDOWS_DOWNLOAD_URL, GIT_FOR_WINDOWS_WINGET_COMMAND } from "@/utils/gitBashSetup";
import {
  GIT_FOR_WINDOWS_TAB_TITLE,
  guideGitForWindowsInstall,
  openGitForWindowsDownload,
} from "./guideGitBashInstall";

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  listAvailableShells: vi.fn(),
}));

const mockedListShells = vi.mocked(listAvailableShells);
const mockedOpenUrl = vi.mocked(openUrl);

describe("guideGitForWindowsInstall", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens a local terminal tab pre-loaded with the winget install command", async () => {
    mockedListShells.mockResolvedValue(["powershell", "cmd"]);
    const addTab = vi.spyOn(useAppStore.getState(), "addTab").mockReturnValue("tab-1");

    await guideGitForWindowsInstall();

    expect(addTab).toHaveBeenCalledTimes(1);
    const [title, connectionType, config] = addTab.mock.calls[0];
    expect(title).toBe(GIT_FOR_WINDOWS_TAB_TITLE);
    expect(connectionType).toBe("local");
    expect(config).toMatchObject({
      type: "local",
      config: { shell: "powershell", initialCommand: GIT_FOR_WINDOWS_WINGET_COMMAND },
    });
    addTab.mockRestore();
  });

  it("throws without opening a tab when no local shell is available", async () => {
    mockedListShells.mockResolvedValue([]);
    const addTab = vi.spyOn(useAppStore.getState(), "addTab");

    await expect(guideGitForWindowsInstall()).rejects.toThrow();
    expect(addTab).not.toHaveBeenCalled();
    addTab.mockRestore();
  });
});

describe("openGitForWindowsDownload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens the official git-scm download page", async () => {
    await openGitForWindowsDownload();
    expect(mockedOpenUrl).toHaveBeenCalledWith(GIT_FOR_WINDOWS_DOWNLOAD_URL);
  });
});
