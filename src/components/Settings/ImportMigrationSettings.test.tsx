import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { readTextFile } from "@tauri-apps/plugin-fs";
import {
  discoverMobaxtermConfigs,
  importInventoryHosts,
  importSshConfigConnections,
} from "@/services/api";
import { open as openFileDialog } from "@/services/nativeDialog";
import { toast } from "@/components/ui";
import { ImportMigrationSettings } from "./ImportMigrationSettings";

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  discoverMobaxtermConfigs: vi.fn(),
  importInventoryHosts: vi.fn(),
  importSshConfigConnections: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@/services/nativeDialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: vi.fn() }));
vi.mock("@/utils/frontendLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/frontendLog")>()),
  frontendError: vi.fn(),
}));

const mockedDiscover = vi.mocked(discoverMobaxtermConfigs);
const mockedOpen = vi.mocked(openFileDialog);
const mockedRead = vi.mocked(readTextFile);
const mockedInventory = vi.mocked(importInventoryHosts);

let container: HTMLDivElement;
let root: Root;

async function renderSettings() {
  await act(async () => {
    root.render(<ImportMigrationSettings />);
  });
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function q(testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testid}"]`);
}

describe("ImportMigrationSettings", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("names the discovered MobaXterm configuration", async () => {
    mockedDiscover.mockResolvedValue([
      { path: "C:\\Users\\a\\AppData\\Roaming\\MobaXterm\\MobaXterm.ini", source: "installed" },
    ]);
    await renderSettings();
    expect(q("import-migration-mobaxterm-hint")?.textContent).toContain(
      "Found MobaXterm configuration at C:\\Users\\a\\AppData\\Roaming\\MobaXterm\\MobaXterm.ini"
    );
  });

  it("explains the manual pick when nothing is found or discovery fails", async () => {
    mockedDiscover.mockResolvedValue([]);
    await renderSettings();
    expect(q("import-migration-mobaxterm-hint")?.textContent).toContain(
      "No MobaXterm configuration was found"
    );

    act(() => root.unmount());
    root = createRoot(container);
    mockedDiscover.mockRejectedValue("boom");
    await renderSettings();
    expect(q("import-migration-mobaxterm-hint")?.textContent).toContain(
      "No MobaXterm configuration was found"
    );
  });

  it("opens the MobaXterm import dialog through the store", async () => {
    mockedDiscover.mockResolvedValue([]);
    await renderSettings();
    expect(useAppStore.getState().mobaxtermImportOpen).toBe(false);
    await act(async () => {
      q("import-migration-mobaxterm-btn")!.click();
    });
    expect(useAppStore.getState().mobaxtermImportOpen).toBe(true);
  });

  it("is the single home for every import: one section per importer", async () => {
    mockedDiscover.mockResolvedValue([]);
    await renderSettings();
    for (const id of [
      "import-migration-ssh-config",
      "import-migration-inventory",
      "import-migration-json",
      "import-migration-mobaxterm",
      "import-migration-backup",
    ]) {
      expect(q(id), id).not.toBeNull();
    }
  });

  it("opens the ~/.ssh/config bulk importer in place", async () => {
    mockedDiscover.mockResolvedValue([]);
    await renderSettings();
    expect(document.querySelector('[data-testid="bulk-ssh-import-dialog"]')).toBeNull();
    await act(async () => {
      q("import-migration-ssh-config-btn")!.click();
    });
    expect(document.querySelector('[data-testid="bulk-ssh-import-dialog"]')).not.toBeNull();
    expect(importSshConfigConnections).toHaveBeenCalled();
  });

  it("onboards hosts from a picked inventory file", async () => {
    mockedDiscover.mockResolvedValue([]);
    mockedOpen.mockResolvedValue("/tmp/hosts.csv");
    mockedInventory.mockResolvedValue([{ host: "10.0.0.1" } as never]);
    await renderSettings();
    await act(async () => {
      q("import-migration-csv-btn")!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedInventory).toHaveBeenCalledWith("/tmp/hosts.csv");
    expect(document.querySelector('[data-testid="fleet-onboard-dialog"]')).not.toBeNull();
  });

  it("tells the user when the inventory file has no hosts", async () => {
    mockedDiscover.mockResolvedValue([]);
    mockedOpen.mockResolvedValue("/tmp/empty.csv");
    mockedInventory.mockResolvedValue([]);
    const info = vi.spyOn(toast, "info");
    await renderSettings();
    await act(async () => {
      q("import-migration-csv-btn")!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(info).toHaveBeenCalledWith("No hosts found in that file.");
    expect(document.querySelector('[data-testid="fleet-onboard-dialog"]')).toBeNull();
  });

  it("imports a connections JSON file through the store's import dialog", async () => {
    mockedDiscover.mockResolvedValue([]);
    mockedOpen.mockResolvedValue("/tmp/connections.json");
    mockedRead.mockResolvedValue('{"version":"1"}');
    const setImportDialog = vi.fn();
    useAppStore.setState({ setImportDialog });
    await renderSettings();
    await act(async () => {
      q("import-migration-json-import-btn")!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedRead).toHaveBeenCalledWith("/tmp/connections.json");
    expect(setImportDialog).toHaveBeenCalledWith(true, '{"version":"1"}');
  });

  it("does nothing when the JSON file picker is cancelled", async () => {
    mockedDiscover.mockResolvedValue([]);
    mockedOpen.mockResolvedValue(null);
    const setImportDialog = vi.fn();
    useAppStore.setState({ setImportDialog });
    await renderSettings();
    await act(async () => {
      q("import-migration-json-import-btn")!.click();
    });
    expect(mockedRead).not.toHaveBeenCalled();
    expect(setImportDialog).not.toHaveBeenCalled();
  });

  it("opens the export dialog through the store", async () => {
    mockedDiscover.mockResolvedValue([]);
    await renderSettings();
    expect(useAppStore.getState().exportDialogOpen).toBe(false);
    await act(async () => {
      q("import-migration-json-export-btn")!.click();
    });
    expect(useAppStore.getState().exportDialogOpen).toBe(true);
  });

  it("links to Settings → Backup & Restore", async () => {
    mockedDiscover.mockResolvedValue([]);
    const openSettingsTab = vi.fn();
    useAppStore.setState({ openSettingsTab });
    await renderSettings();
    await act(async () => {
      q("import-migration-backup-link")!.click();
    });
    expect(openSettingsTab).toHaveBeenCalledWith({ category: "backup" });
  });
});
