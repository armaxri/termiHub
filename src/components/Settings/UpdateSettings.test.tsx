import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { UpdateSettings } from "./UpdateSettings";
import { checkA11y } from "@/test/axe";
import { pressRadioArrow } from "@/test/radioKeyboard";

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
        channel: "stable",
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
        channel: "stable",
      },
    });
    await render();
    await act(async () => {
      (query("update-open-downloads") as HTMLElement).click();
    });
    expect(mockedOpenUrl).toHaveBeenCalledWith("https://example.com/release");
  });

  it("shows the newer develop build and an 'Open Download Page' button (#5023)", async () => {
    useAppStore.setState({
      updateCheckState: "available",
      updateInfo: {
        available: true,
        latestVersion: "0e3504c",
        releaseUrl: "https://github.com/armaxri/termiHub/releases/tag/dev-develop-latest",
        releaseNotes: "",
        isSecurity: false,
        channel: "develop",
        buildCommit: "0e3504c",
        buildPublishedAt: "2026-10-26T23:31:19+00:00",
      },
    });
    await render();
    expect(container.textContent).toContain("Latest develop build");
    expect(query("update-latest-version")?.textContent).toMatch(/^Built .+ from 0e3504c$/);
    const btn = query("update-open-downloads") as HTMLButtonElement;
    expect(btn.textContent).toBe("Open Download Page");
    await act(async () => {
      btn.click();
    });
    expect(mockedOpenUrl).toHaveBeenCalledWith(
      "https://github.com/armaxri/termiHub/releases/tag/dev-develop-latest"
    );
  });

  it("says 'Not checked for this build' when the build does not check", async () => {
    useAppStore.setState({
      updateCheckState: "up-to-date",
      updateInfo: {
        available: false,
        latestVersion: "0.1.0-dev",
        releaseUrl: "",
        releaseNotes: "",
        isSecurity: false,
        channel: "none",
      },
    });
    await render();
    expect(query("update-latest-version")?.textContent).toBe("Not checked for this build");
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
        channel: "stable",
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

  describe("auto-check selector semantics (UISF2-002)", () => {
    it("is a radiogroup named by its section heading", async () => {
      await render();
      const group = query("update-auto-check-group") as HTMLElement;
      expect(group.getAttribute("role")).toBe("radiogroup");
      const labelId = group.getAttribute("aria-labelledby") as string;
      expect(document.getElementById(labelId)?.textContent).toBe("Auto-check for updates");
      expect(query("update-auto-check-on")?.getAttribute("role")).toBe("radio");
      expect(query("update-auto-check-on")?.getAttribute("aria-checked")).toBe("true");
      expect(query("update-auto-check-off")?.getAttribute("aria-checked")).toBe("false");
    });

    it("selects 'Never' with the arrow key and persists it", async () => {
      await render();
      const on = query("update-auto-check-on") as HTMLElement;
      act(() => on.focus());
      await pressRadioArrow(on, "ArrowDown");
      expect(document.activeElement).toBe(query("update-auto-check-off"));
      expect(mockedInvoke).toHaveBeenCalledWith("set_update_auto_check", { enabled: false });
    });

    it("has no a11y violations", async () => {
      await render();
      expect(await checkA11y(container)).toHaveNoViolations();
    });
  });
});
