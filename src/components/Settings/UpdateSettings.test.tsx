import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { UpdateSettings } from "./UpdateSettings";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

const { openUrl } = await import("@tauri-apps/plugin-opener");
const mockedOpenUrl = vi.mocked(openUrl);

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(<UpdateSettings />);
  });
}

function query(testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

setupSettingsRegion();

describe("UpdateSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    mockedInvoke.mockResolvedValue(undefined);
    mockedOpenUrl.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("renders 'Check Now' as a real button using the shared primitive", async () => {
    await render();
    const btn = query("update-check-now") as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn?.tagName).toBe("BUTTON");
    expect(btn?.className).toContain("ui-btn");
  });

  it("triggers an update check when 'Check Now' is clicked", async () => {
    const checkForUpdates = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ checkForUpdates });
    await render();
    await act(async () => {
      (query("update-check-now") as HTMLElement).click();
    });
    expect(checkForUpdates).toHaveBeenCalledWith(true);
  });

  it("shows 'Open Downloads Page' when an update is available", async () => {
    useAppStore.setState({
      updateCheckState: "available",
      updateInfo: {
        available: true,
        latestVersion: "9.9.9",
        releaseUrl: "https://example.com/release",
        releaseNotes: "",
        isSecurity: false,
      },
    });
    await render();
    const btn = query("update-open-downloads") as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn?.className).toContain("ui-btn--primary");
  });

  it("opens the release URL when 'Open Downloads Page' is clicked", async () => {
    useAppStore.setState({
      updateCheckState: "available",
      updateInfo: {
        available: true,
        latestVersion: "9.9.9",
        releaseUrl: "https://example.com/release",
        releaseNotes: "",
        isSecurity: false,
      },
    });
    await render();
    await act(async () => {
      (query("update-open-downloads") as HTMLElement).click();
    });
    expect(mockedOpenUrl).toHaveBeenCalledWith("https://example.com/release");
  });

  it("does not hand a disallowed-scheme release URL to the OS opener (SEC-012)", async () => {
    useAppStore.setState({
      updateCheckState: "available",
      updateInfo: {
        available: true,
        latestVersion: "9.9.9",
        releaseUrl: "file:///etc/passwd",
        releaseNotes: "",
        isSecurity: false,
      },
    });
    await render();
    await act(async () => {
      (query("update-open-downloads") as HTMLElement).click();
    });
    expect(mockedOpenUrl).not.toHaveBeenCalled();
  });

  it("renders a 'Clear' button for a skipped version and clears it", async () => {
    const clearSkippedUpdateVersion = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ clearSkippedUpdateVersion });
    seedSettings({ updates: { autoCheck: true, skippedVersion: "1.0.0" } });
    await render();
    const btn = query("update-clear-skipped") as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    await act(async () => {
      btn?.click();
    });
    expect(clearSkippedUpdateVersion).toHaveBeenCalled();
  });
});
