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

  it("renders the settings section", () => {
    act(() => {
      root.render(<PortableModeSettings />);
    });
    expect(container.querySelector('[data-testid="portable-mode-settings"]')).not.toBeNull();
  });

  it("shows Inactive status in installed mode", () => {
    useAppStore.setState({ isPortableMode: false, portableDataDir: null });
    act(() => {
      root.render(<PortableModeSettings />);
    });
    const status = container.querySelector('[data-testid="portable-mode-status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain("Inactive");
  });

  it("shows Active status in portable mode", () => {
    useAppStore.setState({ isPortableMode: true, portableDataDir: "/tmp/portable/data" });
    act(() => {
      root.render(<PortableModeSettings />);
    });
    const status = container.querySelector('[data-testid="portable-mode-status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain("Active");
  });

  it("shows the data directory path in portable mode", () => {
    useAppStore.setState({ isPortableMode: true, portableDataDir: "/tmp/portable/data" });
    act(() => {
      root.render(<PortableModeSettings />);
    });
    const dataDir = container.querySelector('[data-testid="portable-data-dir"]');
    expect(dataDir).not.toBeNull();
    expect(dataDir!.textContent).toBe("/tmp/portable/data");
  });

  it("hides data directory path in installed mode", () => {
    useAppStore.setState({ isPortableMode: false, portableDataDir: null });
    act(() => {
      root.render(<PortableModeSettings />);
    });
    expect(container.querySelector('[data-testid="portable-data-dir"]')).toBeNull();
  });

  it("shows info box about enabling portable mode in installed mode", () => {
    useAppStore.setState({ isPortableMode: false });
    act(() => {
      root.render(<PortableModeSettings />);
    });
    const text = container.textContent ?? "";
    expect(text).toContain("portable.marker");
    expect(text).toContain("data/");
  });

  it("shows export and import buttons", () => {
    act(() => {
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

  it("does not load config files in installed mode", async () => {
    const { listConfigFiles } = await import("@/services/api");
    const mockListConfigFiles = vi.mocked(listConfigFiles);

    useAppStore.setState({ isPortableMode: false, portableDataDir: null });

    act(() => {
      root.render(<PortableModeSettings />);
    });

    expect(mockListConfigFiles).not.toHaveBeenCalled();
  });
});
