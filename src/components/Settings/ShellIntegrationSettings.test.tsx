import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { ShellIntegrationStatus } from "@/types/connection";
import * as api from "@/services/api";
import { ShellIntegrationSettings } from "./ShellIntegrationSettings";
import { defaultShellIntegrationSettings } from "./shellIntegrationEntries";

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
    uninstallShellIntegration: vi.fn(),
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
    root.render(
      <TooltipProvider delayDuration={0}>
        <ShellIntegrationSettings />
      </TooltipProvider>
    );
  });
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

setupSettingsRegion();

describe("ShellIntegrationSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings({ shellIntegration: defaultShellIntegrationSettings() });
    mockedApi.getShellIntegrationStatus.mockResolvedValue(status());
    mockedApi.saveShellIntegrationSettings.mockResolvedValue(status());
    mockedApi.installShellIntegration.mockResolvedValue(status({ registered: true }));
    mockedApi.uninstallShellIntegration.mockResolvedValue(status({ registered: false }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the registration status card as Not registered", async () => {
    await render();
    expect(byTestId("shell-integration-status-card")).not.toBeNull();
    expect(byTestId("shell-integration-status-text")?.textContent).toBe("Not registered");
  });

  it("shows Registered when the status reports it", async () => {
    mockedApi.getShellIntegrationStatus.mockResolvedValue(status({ registered: true }));
    await render();
    expect(byTestId("shell-integration-status-text")?.textContent).toBe("Registered");
  });

  it("surfaces the staleness banner when the executable moved", async () => {
    mockedApi.getShellIntegrationStatus.mockResolvedValue(
      status({
        registered: true,
        stale: true,
        registeredExePath: "/old/th",
        currentExePath: "/new/th",
      })
    );
    await render();
    expect(byTestId("shell-integration-stale-banner")).not.toBeNull();
  });

  it("triggers registration when Reinstall is clicked", async () => {
    await render();
    await act(async () => {
      byTestId("shell-integration-reinstall")?.click();
    });
    expect(mockedApi.installShellIntegration).toHaveBeenCalledTimes(1);
  });

  it("persists a new entry added through the editor", async () => {
    await render();
    await act(async () => {
      byTestId("shell-integration-add-entry")?.click();
    });
    // Editor modal is portalled; its Save button commits the default entry.
    await act(async () => {
      byTestId("shell-integration-entry-save")?.click();
    });
    expect(mockedApi.saveShellIntegrationSettings).toHaveBeenCalledTimes(1);
    const savedArg = mockedApi.saveShellIntegrationSettings.mock.calls[0][0];
    expect(savedArg.entries).toHaveLength(1);
    expect(savedArg.entries[0].name).toBe("Open in termiHub");
  });

  it("persists deletion of an existing entry", async () => {
    seedSettings({
      shellIntegration: {
        ...defaultShellIntegrationSettings(),
        entries: [
          {
            id: "e1",
            name: "Open in termiHub",
            visibility: "always",
            showFor: { folders: true, files: false, folderBackground: false },
          },
        ],
      },
    });
    await render();
    await act(async () => {
      byTestId("shell-integration-entry-delete-e1")?.click();
    });
    expect(mockedApi.saveShellIntegrationSettings).toHaveBeenCalledTimes(1);
    expect(mockedApi.saveShellIntegrationSettings.mock.calls[0][0].entries).toHaveLength(0);
  });

  it("renders the Linux file-manager toggles on Linux", async () => {
    // jsdom's user agent contains neither "Windows" nor "Macintosh" → treated as Linux.
    await render();
    expect(byTestId("shell-integration-linux")).not.toBeNull();
  });
});
