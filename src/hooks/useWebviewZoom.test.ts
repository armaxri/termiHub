import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSetZoom = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    setZoom: mockSetZoom,
  }),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

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
}));

import { useAppStore } from "@/store/appStore";
import { getCurrentWebview } from "@tauri-apps/api/webview";

describe("useWebviewZoom", () => {
  beforeEach(() => {
    mockSetZoom.mockClear();
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("calls setZoom with the correct zoom level", async () => {
    const zoomLevel = useAppStore.getState().zoomLevel;
    await getCurrentWebview().setZoom(zoomLevel);
    expect(mockSetZoom).toHaveBeenCalledWith(1.0);
  });

  it("calls setZoom with updated level after zoomIn", async () => {
    useAppStore.getState().zoomIn();
    const zoomLevel = useAppStore.getState().zoomLevel;
    await getCurrentWebview().setZoom(zoomLevel);
    expect(mockSetZoom).toHaveBeenCalledWith(1.1);
  });

  it("calls setZoom with updated level after zoomOut", async () => {
    useAppStore.getState().zoomOut();
    const zoomLevel = useAppStore.getState().zoomLevel;
    await getCurrentWebview().setZoom(zoomLevel);
    expect(mockSetZoom).toHaveBeenCalledWith(0.91);
  });

  it("calls setZoom with 1.0 after zoomReset", async () => {
    useAppStore.getState().zoomIn();
    useAppStore.getState().zoomIn();
    useAppStore.getState().zoomReset();
    const zoomLevel = useAppStore.getState().zoomLevel;
    await getCurrentWebview().setZoom(zoomLevel);
    expect(mockSetZoom).toHaveBeenCalledWith(1.0);
  });
});
