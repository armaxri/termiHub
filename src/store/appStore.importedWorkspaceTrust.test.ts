/**
 * Store actions that confirm held imported workspace commands and inline
 * connection configs (#4434).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSaveSettings = vi.fn<(...args: any[]) => Promise<void>>(() => Promise.resolve());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSendInput = vi.fn<(...args: any[]) => Promise<void>>(() => Promise.resolve());

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
  saveSettings: (...args: unknown[]) => mockSaveSettings(...args),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
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
  sessionGetCapabilities: vi.fn(() => Promise.resolve({ monitoring: false, fileBrowser: false })),
  sessionMonitoringOpen: vi.fn(() => Promise.resolve()),
  sessionMonitoringClose: vi.fn(() => Promise.resolve()),
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  getDefaultShell: vi.fn(() => Promise.resolve(null)),
  connectAgent: vi.fn(),
  disconnectAgent: vi.fn(),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  listAgentDefinitions: vi.fn(() => Promise.resolve([])),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(),
  deleteAgentFolder: vi.fn(),
  getCredentialStoreStatus: vi.fn(() => Promise.resolve({ mode: "none", status: "unavailable" })),
  sendInput: (...args: unknown[]) => mockSendInput(...args),
}));

vi.mock("@/services/tunnelApi", () => ({
  getTunnels: vi.fn(() => Promise.resolve([])),
  saveTunnel: vi.fn(),
  deleteTunnel: vi.fn(),
  startTunnel: vi.fn(),
  stopTunnel: vi.fn(),
  getTunnelStatuses: vi.fn(() => Promise.resolve([])),
}));

import type { ConnectionConfig } from "@/types/terminal";
import { useAppStore } from "./appStore";
import { layoutState } from "@/test/layoutState";
import { currentSettingsView } from "./settingsBridge";
import { seedSettings, setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { importedCommandKey, importedConnectionKey } from "@/services/workspaceImportTrust";

const LOCAL_CONFIG: ConnectionConfig = { type: "local", config: { shell: "zsh" } };

function seedTab(patch: Record<string, unknown>): string {
  const id = layoutState().addTab("Shell", "local", LOCAL_CONFIG);
  useAppStore.setState((s) => ({
    tabContent: { ...s.tabContent, [id]: { ...s.tabContent[id], ...patch } },
  }));
  return id;
}

function allowlist(): string[] | undefined {
  return currentSettingsView().workspaceImportAllowlist;
}

setupSettingsRegion();

describe("appStore — imported workspace confirmations (#4434)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  it("does not type a held imported command until it is confirmed", async () => {
    const id = seedTab({ pendingImportedCommand: "make deploy", sessionId: "s1" });
    expect(mockSendInput).not.toHaveBeenCalled();

    await useAppStore.getState().confirmImportedTabCommand(id);

    expect(mockSendInput).toHaveBeenCalledWith("s1", "make deploy\n");
    expect(allowlist()).toEqual([await importedCommandKey("make deploy")]);
    const tab = useAppStore.getState().tabContent[id];
    expect(tab.pendingImportedCommand).toBeUndefined();
    expect(tab.initialCommand).toBe("make deploy");
  });

  it("does nothing before the session exists", async () => {
    const id = seedTab({ pendingImportedCommand: "make deploy", sessionId: null });
    await useAppStore.getState().confirmImportedTabCommand(id);
    expect(mockSendInput).not.toHaveBeenCalled();
    expect(allowlist() ?? []).toEqual([]);
    expect(useAppStore.getState().tabContent[id].pendingImportedCommand).toBe("make deploy");
  });

  it("dismissing drops the held command without running it", () => {
    const id = seedTab({ pendingImportedCommand: "make deploy", sessionId: "s1" });
    useAppStore.getState().dismissImportedTabCommand(id);
    expect(mockSendInput).not.toHaveBeenCalled();
    expect(useAppStore.getState().tabContent[id].pendingImportedCommand).toBeUndefined();
  });

  it("confirming a held inline config releases the tab and remembers the config", async () => {
    const id = seedTab({ pendingImportedConnection: true });
    await useAppStore.getState().confirmImportedTabConnection(id);
    expect(useAppStore.getState().tabContent[id].pendingImportedConnection).toBeUndefined();
    expect(allowlist()).toEqual([await importedConnectionKey(LOCAL_CONFIG)]);
  });

  it("keeps earlier confirmations when adding a new one", async () => {
    seedSettings({ workspaceImportAllowlist: ["cmd:old"] });
    const id = seedTab({ pendingImportedCommand: "ls", sessionId: "s1" });
    await useAppStore.getState().confirmImportedTabCommand(id);
    expect(allowlist()).toEqual(["cmd:old", await importedCommandKey("ls")]);
  });
});
