import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { DEFAULT_LAYOUT, LAYOUT_PRESETS } from "@/types/connection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSaveSettings = vi.fn<(...args: any[]) => Promise<void>>(() => Promise.resolve());

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
  getCredentialStoreStatus: vi.fn(() =>
    Promise.resolve({ mode: "none", status: "unavailable", keychainAvailable: false })
  ),
}));

vi.mock("@/services/tunnelApi", () => ({
  getTunnels: vi.fn(() => Promise.resolve([])),
  saveTunnel: vi.fn(),
  deleteTunnel: vi.fn(),
  startTunnel: vi.fn(),
  stopTunnel: vi.fn(),
  getTunnelStatuses: vi.fn(() => Promise.resolve([])),
}));

import { useAppStore } from "./appStore";

describe("appStore — layout state", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initializes layoutConfig with DEFAULT_LAYOUT", () => {
    const state = useAppStore.getState();
    expect(state.layoutConfig).toEqual(DEFAULT_LAYOUT);
  });

  it("initializes layoutDialogOpen as false", () => {
    const state = useAppStore.getState();
    expect(state.layoutDialogOpen).toBe(false);
  });

  it("setLayoutDialogOpen toggles the dialog state", () => {
    useAppStore.getState().setLayoutDialogOpen(true);
    expect(useAppStore.getState().layoutDialogOpen).toBe(true);

    useAppStore.getState().setLayoutDialogOpen(false);
    expect(useAppStore.getState().layoutDialogOpen).toBe(false);
  });

  it("updateLayoutConfig merges partial update into current config", () => {
    useAppStore.getState().updateLayoutConfig({ statusBarVisible: false });

    const state = useAppStore.getState();
    expect(state.layoutConfig).toEqual({
      ...DEFAULT_LAYOUT,
      statusBarVisible: false,
    });
  });

  it("updateLayoutConfig debounce-persists settings after 300ms", () => {
    useAppStore.getState().updateLayoutConfig({ statusBarVisible: false });

    // Not persisted yet
    expect(mockSaveSettings).not.toHaveBeenCalled();

    // Advance past debounce
    vi.advanceTimersByTime(300);

    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    const savedSettings = mockSaveSettings.mock.calls[0][0];
    expect(savedSettings.layout).toEqual({
      ...DEFAULT_LAYOUT,
      statusBarVisible: false,
    });
  });

  it("updateLayoutConfig debounces multiple rapid calls", () => {
    useAppStore.getState().updateLayoutConfig({ statusBarVisible: false });
    vi.advanceTimersByTime(100);
    useAppStore.getState().updateLayoutConfig({ sidebarVisible: false });
    vi.advanceTimersByTime(100);
    useAppStore.getState().updateLayoutConfig({ activityBarPosition: "right" });

    // Nothing persisted yet
    expect(mockSaveSettings).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    // Only one persist call with the last updateLayoutConfig's value
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
  });

  it("applyLayoutPreset sets config from LAYOUT_PRESETS", () => {
    useAppStore.getState().applyLayoutPreset("zen");

    const state = useAppStore.getState();
    expect(state.layoutConfig).toEqual(LAYOUT_PRESETS["zen"]);
  });

  it("applyLayoutPreset debounce-persists settings after 300ms", () => {
    useAppStore.getState().applyLayoutPreset("focus");

    expect(mockSaveSettings).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    const savedSettings = mockSaveSettings.mock.calls[0][0];
    expect(savedSettings.layout).toEqual(LAYOUT_PRESETS["focus"]);
  });

  it("applyLayoutPreset ignores unknown presets", () => {
    const before = useAppStore.getState().layoutConfig;
    useAppStore.getState().applyLayoutPreset("nonexistent" as "default");

    expect(useAppStore.getState().layoutConfig).toEqual(before);
  });

  it("loadFromBackend loads layout from settings", async () => {
    const { getSettings } = await import("@/services/storage");
    const customLayout = {
      activityBarPosition: "top" as const,
      sidebarPosition: "right" as const,
      sidebarVisible: false,
      statusBarVisible: false,
    };
    vi.mocked(getSettings).mockResolvedValueOnce({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
      layout: customLayout,
    });

    await useAppStore.getState().loadFromBackend();

    expect(useAppStore.getState().layoutConfig).toEqual(customLayout);
  });

  it("loadFromBackend falls back to DEFAULT_LAYOUT when settings.layout is undefined", async () => {
    const { getSettings } = await import("@/services/storage");
    vi.mocked(getSettings).mockResolvedValueOnce({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    });

    await useAppStore.getState().loadFromBackend();

    expect(useAppStore.getState().layoutConfig).toEqual(DEFAULT_LAYOUT);
  });
});
