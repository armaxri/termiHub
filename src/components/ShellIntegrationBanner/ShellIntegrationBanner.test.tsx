import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { ShellIntegrationStatus } from "@/types/connection";
import * as api from "@/services/api";
import { ShellIntegrationBanner } from "./ShellIntegrationBanner";
import { defaultShellIntegrationSettings } from "@/components/Settings/shellIntegrationEntries";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    getShellIntegrationStatus: vi.fn(),
    saveShellIntegrationSettings: vi.fn(),
    installShellIntegration: vi.fn(),
  };
});

const mockedApi = vi.mocked(api);

function status(overrides: Partial<ShellIntegrationStatus> = {}): ShellIntegrationStatus {
  return {
    registered: false,
    exePathMatches: true,
    stale: false,
    portable: false,
    detectedFileManagers: [],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(<ShellIntegrationBanner />);
  });
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

setupSettingsRegion();

describe("ShellIntegrationBanner", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings({ shellIntegration: defaultShellIntegrationSettings() });
    mockedApi.getShellIntegrationStatus.mockResolvedValue(status());
    mockedApi.saveShellIntegrationSettings.mockResolvedValue(status());
    mockedApi.installShellIntegration.mockResolvedValue(status({ registered: true }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows the banner when not registered and not dismissed", async () => {
    await render();
    expect(byTestId("shell-integration-banner")).not.toBeNull();
  });

  it("hides the banner once the integration is registered", async () => {
    mockedApi.getShellIntegrationStatus.mockResolvedValue(status({ registered: true }));
    await render();
    expect(byTestId("shell-integration-banner")).toBeNull();
  });

  it("hides the banner when previously dismissed", async () => {
    seedSettings({
      shellIntegration: {
        ...defaultShellIntegrationSettings(),
        firstLaunchBannerDismissed: true,
      },
    });
    await render();
    expect(byTestId("shell-integration-banner")).toBeNull();
  });

  it("dismisses for the session without persisting on Not now", async () => {
    await render();
    await act(async () => {
      byTestId("shell-integration-banner-not-now")?.click();
    });
    expect(byTestId("shell-integration-banner")).toBeNull();
    expect(mockedApi.saveShellIntegrationSettings).not.toHaveBeenCalled();
  });

  it("persists firstLaunchBannerDismissed on Don't ask again", async () => {
    await render();
    await act(async () => {
      byTestId("shell-integration-banner-dismiss")?.click();
    });
    expect(mockedApi.saveShellIntegrationSettings).toHaveBeenCalledTimes(1);
    expect(mockedApi.saveShellIntegrationSettings.mock.calls[0][0].firstLaunchBannerDismissed).toBe(
      true
    );
  });
});
