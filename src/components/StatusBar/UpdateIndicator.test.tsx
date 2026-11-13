/**
 * The status bar's update chip holds live state only (#5559): no permanent
 * version text on an up-to-date release build (the version lives in Settings ▸
 * About), an "Update v<latest>" chip while an update is available, and the
 * "develop" badge on a develop-branch build.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { resetAppInfoCache } from "@/hooks/useAppInfo";
import type { AppInfo } from "@/types/generated/AppInfo";
import type { UpdateInfo } from "@/types/generated/UpdateInfo";
import { UpdateIndicator } from "./UpdateIndicator";

const { invoke } = await import("@tauri-apps/api/core");
const mockedInvoke = vi.mocked(invoke);

const RELEASE: AppInfo = { version: "0.1.0", gitHash: "abc", isDev: false, buildBranch: "main" };

const UPDATE: UpdateInfo = {
  available: true,
  latestVersion: "0.2.0",
  releaseUrl: "https://example.invalid/r",
  releaseNotes: "",
  isSecurity: false,
  channel: "stable",
};

let container: HTMLDivElement;
let root: Root;

async function render(info: AppInfo): Promise<void> {
  mockedInvoke.mockImplementation((cmd) =>
    cmd === "get_app_info" ? Promise.resolve(info) : Promise.resolve(undefined)
  );
  await act(async () => {
    root.render(<UpdateIndicator />);
  });
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function chip(): HTMLElement | null {
  return container.querySelector("[data-testid='update-indicator']");
}

beforeEach(() => {
  resetAppInfoCache();
  useAppStore.setState(useAppStore.getInitialState());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("UpdateIndicator — live state only (#5559)", () => {
  it("shows nothing on an up-to-date release build", async () => {
    useAppStore.setState({ updateCheckState: "up-to-date", updateInfo: null });
    await render(RELEASE);
    expect(chip()).toBeNull();
    expect(container.textContent).not.toContain("0.1.0");
  });

  it("shows the available version, not the installed one, while an update is available", async () => {
    useAppStore.setState({ updateCheckState: "available", updateInfo: UPDATE });
    await render(RELEASE);
    expect(chip()?.textContent).toContain("Update v0.2.0");
    expect(chip()?.textContent).not.toContain("0.1.0");
    expect(container.querySelector("[data-testid='update-indicator-dot']")).not.toBeNull();
  });

  it("re-shows the update popup when clicked", async () => {
    useAppStore.setState({
      updateCheckState: "available",
      updateInfo: UPDATE,
      updateNotificationDismissed: true,
    });
    await render(RELEASE);
    act(() => chip()!.click());
    expect(useAppStore.getState().updateNotificationDismissed).toBe(false);
  });

  it("keeps the develop badge on a develop build, without the version text", async () => {
    useAppStore.setState({ updateCheckState: "up-to-date", updateInfo: null });
    await render({ ...RELEASE, buildBranch: "develop" });
    expect(container.querySelector("[data-testid='develop-branch-badge']")).not.toBeNull();
    expect(chip()?.textContent).toBe("develop");
  });
});
