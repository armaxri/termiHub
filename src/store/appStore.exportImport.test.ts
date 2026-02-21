import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock service modules before importing the store
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
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  monitoringOpen: vi.fn(),
  monitoringClose: vi.fn(),
  monitoringFetchStats: vi.fn(),
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  getDefaultShell: vi.fn(() => Promise.resolve(null)),
  connectAgent: vi.fn(),
  disconnectAgent: vi.fn(),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  listAgentDefinitions: vi.fn(() => Promise.resolve([])),
  saveAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(),
  getAgentCapabilities: vi.fn(),
  getTunnels: vi.fn(() => Promise.resolve([])),
  getTunnelStatuses: vi.fn(() => Promise.resolve([])),
  getCredentialStoreStatus: vi.fn(() => Promise.resolve({ mode: "none", status: "unavailable" })),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Dynamic import so mocks are applied first
const { useAppStore } = await import("@/store/appStore");

describe("Export/Import dialog state", () => {
  beforeEach(() => {
    useAppStore.setState({
      exportDialogOpen: false,
      importDialogOpen: false,
      importFileContent: undefined,
    });
  });

  it("setExportDialogOpen opens and closes the export dialog", () => {
    expect(useAppStore.getState().exportDialogOpen).toBe(false);

    useAppStore.getState().setExportDialogOpen(true);
    expect(useAppStore.getState().exportDialogOpen).toBe(true);

    useAppStore.getState().setExportDialogOpen(false);
    expect(useAppStore.getState().exportDialogOpen).toBe(false);
  });

  it("setImportDialog opens the import dialog with file content", () => {
    expect(useAppStore.getState().importDialogOpen).toBe(false);
    expect(useAppStore.getState().importFileContent).toBeUndefined();

    useAppStore.getState().setImportDialog(true, '{"version":"1","folders":[],"connections":[]}');
    expect(useAppStore.getState().importDialogOpen).toBe(true);
    expect(useAppStore.getState().importFileContent).toBe(
      '{"version":"1","folders":[],"connections":[]}'
    );
  });

  it("setImportDialog closes the import dialog and clears content", () => {
    useAppStore.getState().setImportDialog(true, "some-json");
    useAppStore.getState().setImportDialog(false);

    expect(useAppStore.getState().importDialogOpen).toBe(false);
    expect(useAppStore.getState().importFileContent).toBeUndefined();
  });
});
