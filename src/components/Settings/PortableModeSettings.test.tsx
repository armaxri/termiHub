import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  listConfigFiles: vi.fn(() => Promise.resolve([])),
  exportConfigToPortable: vi.fn(() =>
    Promise.resolve({ filesCopied: ["connections.json"], warnings: [] })
  ),
  importConfigFromPortable: vi.fn(() =>
    Promise.resolve({ filesCopied: ["connections.json"], warnings: [] })
  ),
}));

import { PortableModeSettings } from "./PortableModeSettings";

describe("PortableModeSettings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the settings section", async () => {
    await act(async () => {
      root.render(<PortableModeSettings />);
    });
    expect(container.querySelector('[data-testid="portable-mode-settings"]')).not.toBeNull();
  });

  it("shows Inactive status in installed mode", async () => {
    useAppStore.setState({ isPortableMode: false, portableDataDir: null });
    await act(async () => {
      root.render(<PortableModeSettings />);
    });
    const status = container.querySelector('[data-testid="portable-mode-status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain("Inactive");
  });

  it("shows Active status in portable mode", async () => {
    useAppStore.setState({ isPortableMode: true, portableDataDir: "/tmp/portable/data" });
    await act(async () => {
      root.render(<PortableModeSettings />);
    });
    const status = container.querySelector('[data-testid="portable-mode-status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain("Active");
  });

  it("shows the data directory path in portable mode", async () => {
    useAppStore.setState({ isPortableMode: true, portableDataDir: "/tmp/portable/data" });
    await act(async () => {
      root.render(<PortableModeSettings />);
    });
    const dataDir = container.querySelector('[data-testid="portable-data-dir"]');
    expect(dataDir).not.toBeNull();
    expect(dataDir!.textContent).toBe("/tmp/portable/data");
  });

  it("hides data directory path in installed mode", async () => {
    useAppStore.setState({ isPortableMode: false, portableDataDir: null });
    await act(async () => {
      root.render(<PortableModeSettings />);
    });
    expect(container.querySelector('[data-testid="portable-data-dir"]')).toBeNull();
  });

  it("shows info box about enabling portable mode in installed mode", async () => {
    useAppStore.setState({ isPortableMode: false });
    await act(async () => {
      root.render(<PortableModeSettings />);
    });
    const text = container.textContent ?? "";
    expect(text).toContain("portable.marker");
    expect(text).toContain("data/");
  });

  it("shows export and import buttons", async () => {
    await act(async () => {
      root.render(<PortableModeSettings />);
    });
    expect(container.querySelector('[data-testid="export-config-btn"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="import-config-btn"]')).not.toBeNull();
  });

  it("loads config file list when in portable mode", async () => {
    const { listConfigFiles } = await import("@/services/api");
    const mockListConfigFiles = vi.mocked(listConfigFiles);
    mockListConfigFiles.mockResolvedValue([
      { name: "connections.json", present: true },
      { name: "settings.json", present: false },
    ]);

    useAppStore.setState({ isPortableMode: true, portableDataDir: "/data" });

    await act(async () => {
      root.render(<PortableModeSettings />);
    });

    expect(mockListConfigFiles).toHaveBeenCalledWith("/data");
  });

  it("shows a persistent error toast when the config file list cannot be loaded (#4333)", async () => {
    const { listConfigFiles } = await import("@/services/api");
    const { toast } = await import("@/components/ui");
    const errorSpy = vi.spyOn(toast, "error");
    vi.mocked(listConfigFiles).mockRejectedValueOnce({ code: "io", message: "data dir gone" });
    useAppStore.setState({ isPortableMode: true, portableDataDir: "/data" });

    await act(async () => {
      root.render(<PortableModeSettings />);
    });

    expect(errorSpy).toHaveBeenCalledWith("Could not list portable config files", {
      description: "data dir gone",
    });
    errorSpy.mockRestore();
  });

  it("does not load config files in installed mode", async () => {
    const { listConfigFiles } = await import("@/services/api");
    const mockListConfigFiles = vi.mocked(listConfigFiles);

    useAppStore.setState({ isPortableMode: false, portableDataDir: null });

    await act(async () => {
      root.render(<PortableModeSettings />);
    });

    expect(mockListConfigFiles).not.toHaveBeenCalled();
  });

  it("renders a structured IPC error's message when export fails (#4104)", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { exportConfigToPortable } = await import("@/services/api");
    vi.mocked(open).mockResolvedValueOnce("/target");
    vi.mocked(exportConfigToPortable).mockRejectedValueOnce({
      code: "io_error",
      message: "target directory is read-only",
    });

    await act(async () => {
      root.render(<PortableModeSettings />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="export-config-btn"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="migration-confirm"]')!.click();
    });

    const result = container.querySelector('[data-testid="migration-result"]');
    expect(result?.textContent).toContain("target directory is read-only");
    expect(result?.textContent).not.toContain("[object Object]");
  });
});
