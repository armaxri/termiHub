// In-app update install actions of the update-checker slice (#5758).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UpdateInfo } from "@/types/connection";
import { useAppStore } from "./appStore";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);

const IN_APP_UPDATE: UpdateInfo = {
  available: true,
  latestVersion: "0.2.0",
  releaseUrl: "https://github.com/armaxri/termiHub/releases/tag/v0.2.0",
  releaseNotes: "",
  isSecurity: false,
  channel: "stable",
  outcome: "updateAvailable",
  installMethod: "inApp",
};

type ProgressHandler = (event: { payload: { downloaded: number; total: number | null } }) => void;

/** Capture the progress listener and count its unsubscribes. */
function captureProgress() {
  const state: { handler: ProgressHandler | null; unlistened: number } = {
    handler: null,
    unlistened: 0,
  };
  mockedListen.mockImplementation((name, handler) => {
    if (name === "app-update-download-progress") state.handler = handler as ProgressHandler;
    return Promise.resolve(() => {
      state.unlistened += 1;
    });
  });
  return state;
}

describe("in-app update install (#5758)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    mockedInvoke.mockReset();
    mockedListen.mockReset();
  });

  it("downloads the checked version, tracks progress, then waits for the restart click", async () => {
    const progress = captureProgress();
    let finish: () => void = () => {};
    mockedInvoke.mockImplementation((cmd) =>
      cmd === "download_app_update"
        ? new Promise<undefined>((resolve) => {
            finish = () => resolve(undefined);
          })
        : Promise.resolve(undefined)
    );
    useAppStore.setState({ updateCheckState: "available", updateInfo: IN_APP_UPDATE });

    const pending = useAppStore.getState().downloadAppUpdate();
    await vi.waitFor(() => expect(progress.handler).not.toBeNull());
    expect(useAppStore.getState().appUpdateInstall.phase).toBe("downloading");
    progress.handler?.({ payload: { downloaded: 50, total: 200 } });
    expect(useAppStore.getState().appUpdateInstall).toMatchObject({
      phase: "downloading",
      downloaded: 50,
      total: 200,
    });

    await vi.waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("download_app_update", { expectedVersion: "0.2.0" })
    );
    finish();
    await pending;
    expect(mockedInvoke).toHaveBeenCalledWith("download_app_update", { expectedVersion: "0.2.0" });
    expect(useAppStore.getState().appUpdateInstall.phase).toBe("ready");
    expect(progress.unlistened).toBe(1);
    // Nothing installed without the second click.
    expect(mockedInvoke).not.toHaveBeenCalledWith("install_app_update_and_restart");
  });

  it("refuses to download an update that installs from the release page", async () => {
    useAppStore.setState({
      updateCheckState: "available",
      updateInfo: { ...IN_APP_UPDATE, installMethod: "releasePage", releasePageReason: "portable" },
    });
    await expect(useAppStore.getState().downloadAppUpdate()).rejects.toThrow(/No in-app update/);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("returns to idle and rethrows when the download or its signature check fails", async () => {
    const progress = captureProgress();
    mockedInvoke.mockRejectedValue("The update download failed: signature mismatch");
    useAppStore.setState({ updateCheckState: "available", updateInfo: IN_APP_UPDATE });
    await expect(useAppStore.getState().downloadAppUpdate()).rejects.toBe(
      "The update download failed: signature mismatch"
    );
    expect(useAppStore.getState().appUpdateInstall.phase).toBe("idle");
    expect(progress.unlistened).toBe(1);
  });

  it("installs and restarts only from the ready phase", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await expect(useAppStore.getState().restartToInstallUpdate()).rejects.toThrow(
      /No downloaded update/
    );
    useAppStore.setState({
      appUpdateInstall: { phase: "ready", version: "0.2.0", downloaded: 10, total: 10 },
    });
    await useAppStore.getState().restartToInstallUpdate();
    expect(mockedInvoke).toHaveBeenCalledWith("install_app_update_and_restart");
    expect(useAppStore.getState().appUpdateInstall.phase).toBe("restarting");
  });

  it("starts over when the install fails", async () => {
    mockedInvoke.mockRejectedValue("The update could not be installed: read-only volume");
    useAppStore.setState({
      appUpdateInstall: { phase: "ready", version: "0.2.0", downloaded: 10, total: 10 },
    });
    await expect(useAppStore.getState().restartToInstallUpdate()).rejects.toMatch(/read-only/);
    expect(useAppStore.getState().appUpdateInstall.phase).toBe("idle");
  });
});
