import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider, toast } from "@/components/ui";
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

  it("renders the status card as not added to the file manager (#5845)", async () => {
    await render();
    expect(byTestId("shell-integration-status-card")).not.toBeNull();
    expect(byTestId("shell-integration-status-text")?.textContent).toBe(
      "Not added to your file manager"
    );
  });

  it("shows Added when the status reports it is registered", async () => {
    mockedApi.getShellIntegrationStatus.mockResolvedValue(status({ registered: true }));
    await render();
    expect(byTestId("shell-integration-status-text")?.textContent).toBe(
      "Added to your file manager"
    );
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

  it("offers only Add when nothing is registered (#5616, #5845)", async () => {
    await render();
    const primary = byTestId("shell-integration-reinstall");
    expect(primary?.textContent).toBe("Add to your file manager");
    expect(byTestId("shell-integration-uninstall")).toBeNull();
  });

  it("offers Update and Remove once registered (#5616, #5845)", async () => {
    mockedApi.getShellIntegrationStatus.mockResolvedValue(status({ registered: true }));
    await render();
    expect(byTestId("shell-integration-reinstall")?.textContent).toBe("Update");
    const uninstall = byTestId("shell-integration-uninstall") as HTMLButtonElement | null;
    expect(uninstall?.textContent).toBe("Remove from your file manager");
    expect(uninstall?.disabled).toBe(false);
  });

  it("switches the actions after Add and after Remove (#5616)", async () => {
    await render();
    await act(async () => {
      byTestId("shell-integration-reinstall")?.click();
    });
    expect(byTestId("shell-integration-reinstall")?.textContent).toBe("Update");
    expect(byTestId("shell-integration-uninstall")).not.toBeNull();
    await act(async () => {
      byTestId("shell-integration-uninstall")?.click();
    });
    expect(mockedApi.uninstallShellIntegration).toHaveBeenCalledTimes(1);
    expect(byTestId("shell-integration-reinstall")?.textContent).toBe("Add to your file manager");
    expect(byTestId("shell-integration-uninstall")).toBeNull();
  });

  it("titles the section Open in termiHub, the menu entry it adds (#5616, #5845)", async () => {
    await render();
    const title = document.querySelector(".settings-section__heading");
    expect(title?.textContent).toBe("Open in termiHub");
    expect(byTestId("settings-shell-integration")?.textContent).toContain("right-click menu");
  });

  it("triggers registration when Add is clicked", async () => {
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

  it("toasts a structured IPC error's message when saving fails (#4104)", async () => {
    const errorSpy = vi.spyOn(toast, "error").mockReturnValue("id");
    // Tauri rejects a command error as a `{ code, message }` envelope, not an Error.
    mockedApi.saveShellIntegrationSettings.mockRejectedValue({
      code: "io_error",
      message: "registry key is locked",
    });
    await render();
    await act(async () => {
      byTestId("shell-integration-add-entry")?.click();
    });
    await act(async () => {
      byTestId("shell-integration-entry-save")?.click();
    });
    expect(errorSpy).toHaveBeenCalledWith("Could not save the “Open in termiHub” settings", {
      description: "registry key is locked",
    });
    errorSpy.mockRestore();
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

  describe("plain wording (#5845)", () => {
    const entry = (id: string) => ({
      id,
      name: `Entry ${id}`,
      visibility: "always" as const,
      showFor: { folders: true, files: false, folderBackground: false },
    });

    it("hides the reorder hint while the list is empty", async () => {
      await render();
      expect(byTestId("shell-integration-entries-empty")).not.toBeNull();
      expect(byTestId("shell-integration-entries-hint")).toBeNull();
      expect(byTestId("settings-shell-integration")?.textContent).not.toContain("Drag the handle");
    });

    it("names only the default with one entry, and how to reorder from two", async () => {
      seedSettings({
        shellIntegration: { ...defaultShellIntegrationSettings(), entries: [entry("e1")] },
      });
      await render();
      expect(byTestId("shell-integration-entries-hint")?.textContent).toBe(
        "The first “Always” entry is the default."
      );
      act(() => root.unmount());
      root = createRoot(container);
      seedSettings({
        shellIntegration: {
          ...defaultShellIntegrationSettings(),
          entries: [entry("e1"), entry("e2")],
        },
      });
      await render();
      expect(byTestId("shell-integration-entries-hint")?.textContent).toContain(
        "Drag the handle or use the arrow buttons to reorder."
      );
    });

    it("asks what opens a folder instead of naming a fallback", async () => {
      await render();
      const section = byTestId("settings-shell-integration")?.textContent ?? "";
      expect(section).toContain("When opening a folder");
      expect(section).not.toContain("Fallback");
      const select = byTestId("shell-integration-fallback");
      expect(select?.getAttribute("aria-label")).toBe("When opening a folder");
      expect(select?.textContent).toContain("Ask which session");
      expect(byTestId("shell-integration-fallback-help")).not.toBeNull();
    });

    it("says the same place in the status and its button", async () => {
      await render();
      const statusText = byTestId("shell-integration-status-text")?.textContent ?? "";
      const button = byTestId("shell-integration-reinstall")?.textContent ?? "";
      expect(statusText).toBe("Not added to your file manager");
      expect(button).toBe("Add to your file manager");
      expect(byTestId("shell-integration-status-text")?.dataset.registered).toBe("false");
    });
  });

  describe("reordering without a pointer (A11Y2-003, #4329)", () => {
    const entry = (id: string) => ({
      id,
      name: `Entry ${id}`,
      visibility: "always" as const,
      showFor: { folders: true, files: false, folderBackground: false },
    });

    beforeEach(() => {
      seedSettings({
        shellIntegration: {
          ...defaultShellIntegrationSettings(),
          entries: [entry("e1"), entry("e2"), entry("e3")],
        },
      });
    });

    const savedOrder = () =>
      mockedApi.saveShellIntegrationSettings.mock.calls[0][0].entries.map(
        (e: { id: string }) => e.id
      );

    it("Move down swaps an entry with the next one", async () => {
      await render();
      await act(async () => {
        byTestId("shell-integration-entry-move-down-e1")?.click();
      });
      expect(savedOrder()).toEqual(["e2", "e1", "e3"]);
    });

    it("Move up swaps an entry with the previous one", async () => {
      await render();
      await act(async () => {
        byTestId("shell-integration-entry-move-up-e3")?.click();
      });
      expect(savedOrder()).toEqual(["e1", "e3", "e2"]);
    });

    it("disables Move up on the first entry and Move down on the last", async () => {
      await render();
      expect((byTestId("shell-integration-entry-move-up-e1") as HTMLButtonElement).disabled).toBe(
        true
      );
      expect((byTestId("shell-integration-entry-move-down-e3") as HTMLButtonElement).disabled).toBe(
        true
      );
      expect((byTestId("shell-integration-entry-move-down-e1") as HTMLButtonElement).disabled).toBe(
        false
      );
    });

    it("labels the move buttons with the entry they act on", async () => {
      await render();
      expect(byTestId("shell-integration-entry-move-up-e2")?.getAttribute("aria-label")).toBe(
        "Move Entry e2 up"
      );
      expect(byTestId("shell-integration-entry-move-down-e2")?.getAttribute("aria-label")).toBe(
        "Move Entry e2 down"
      );
    });
  });

  it("renders the Linux file-manager toggles on Linux", async () => {
    // jsdom's user agent contains neither "Windows" nor "Macintosh" → treated as Linux.
    await render();
    expect(byTestId("shell-integration-linux")).not.toBeNull();
  });

  it("hides the staleness banner for a portable build whose executable moved", async () => {
    // Portable exemption: a portable binary travels with its data/ dir, so a
    // moved executable is expected and must not prompt a reinstall.
    mockedApi.getShellIntegrationStatus.mockResolvedValue(
      status({
        registered: true,
        stale: true,
        portable: true,
        registeredExePath: "/media/old/th",
        currentExePath: "/media/new/th",
      })
    );
    await render();
    expect(byTestId("shell-integration-status-text")?.textContent).toBe(
      "Added to your file manager"
    );
    expect(byTestId("shell-integration-stale-banner")).toBeNull();
    expect(byTestId("shell-integration-stale-badge")).toBeNull();
  });

  describe("Linux file-manager detection annotation (#1397)", () => {
    it("shows the detected name and version for each detected manager", async () => {
      mockedApi.getShellIntegrationStatus.mockResolvedValue(
        status({
          detectedFileManagers: [
            { id: "nautilus", name: "Nautilus", detected: true, version: "46.2" },
            { id: "kde", name: "Dolphin", detected: true, version: "24.08.1" },
            { id: "thunar", name: "Thunar", detected: true, version: "4.18.4" },
          ],
        })
      );
      await render();
      expect(byTestId("shell-integration-linux-nautilus-detection")?.textContent).toBe(
        "— detected: Nautilus 46.2"
      );
      expect(byTestId("shell-integration-linux-kde-detection")?.textContent).toBe(
        "— detected: Dolphin 24.08.1"
      );
      expect(byTestId("shell-integration-linux-thunar-detection")?.textContent).toBe(
        "— detected: Thunar 4.18.4"
      );
    });

    it("omits the version when a detected manager reports none", async () => {
      mockedApi.getShellIntegrationStatus.mockResolvedValue(
        status({
          detectedFileManagers: [{ id: "thunar", name: "Thunar", detected: true }],
        })
      );
      await render();
      expect(byTestId("shell-integration-linux-thunar-detection")?.textContent).toBe(
        "— detected: Thunar"
      );
    });

    it("shows not detected for a manager reported absent or missing from the status", async () => {
      mockedApi.getShellIntegrationStatus.mockResolvedValue(
        status({
          detectedFileManagers: [
            { id: "nautilus", name: "Nautilus", detected: true, version: "46.2" },
            { id: "kde", name: "Dolphin", detected: false },
          ],
        })
      );
      await render();
      expect(byTestId("shell-integration-linux-nautilus-detection")?.textContent).toBe(
        "— detected: Nautilus 46.2"
      );
      // Reported but not detected.
      expect(byTestId("shell-integration-linux-kde-detection")?.textContent).toBe("— not detected");
      // Not in the status at all.
      expect(byTestId("shell-integration-linux-thunar-detection")?.textContent).toBe(
        "— not detected"
      );
    });
  });
});
