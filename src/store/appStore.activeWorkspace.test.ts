/**
 * #3517: the active workspace survives a restart via the last session, and
 * `activeWorkspaceName` follows the backend's active workspace (cleared when it
 * is deleted, renamed with it).
 */
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
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

// Multi-window aggregation/restore commands (#1925). Untyped wrappers so the
// resolved values can be set per-test.
const openWindow = vi.fn();
const reportWindowLayout = vi.fn();
const collectWindowLayouts = vi.fn();
const takePendingWindowRestore = vi.fn();

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  openWindow: (...args: unknown[]) => openWindow(...args),
  reportWindowLayout: (...args: unknown[]) => reportWindowLayout(...args),
  collectWindowLayouts: (...args: unknown[]) => collectWindowLayouts(...args),
  takePendingWindowRestore: (...args: unknown[]) => takePendingWindowRestore(...args),
}));

vi.mock("@/services/lastSessionApi", () => ({
  saveLastSession: vi.fn(() => Promise.resolve()),
  loadLastSession: vi.fn(() => Promise.resolve(null)),
  clearLastSession: vi.fn(() => Promise.resolve()),
}));

// The restore-mode decision logic now lives in `core::restore_mode`, reached
// over IPC (#2200) and thus unavailable in this JS test. Mock the async decision
// boundary; `resolveRestoreMode` mirrors the core guard so the mode-driven
// save/skip branches stay input-driven. Parity with the retired TS logic is
// proven by the Rust golden vectors (`core/tests/restore_mode_golden.rs`).
vi.mock("@/utils/restoreMode", () => ({
  resolveRestoreMode: vi.fn(
    async (s: { restoreLastSessionMode?: string; restoreLastSessionOnStartup?: boolean }) => {
      const m = s.restoreLastSessionMode;
      if (m === "never" || m === "ask" || m === "always") return m;
      if (s.restoreLastSessionOnStartup === false) return "never";
      return "ask";
    }
  ),
  summarizeLastSession: vi.fn(async () => ({ tabCount: 0, tabs: [] })),
  filterSessionBySelection: vi.fn(async (session: unknown) => session),
}));

// Spy on the shared toast hub so restore-failure feedback (G3, #1146) is observable.
vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    promise: vi.fn(),
    dismiss: vi.fn(),
  },
}));

// The workspace backend: `set_active_workspace` rejects an unknown id, like the
// real command; `get_active_workspace` returns what was last set.
const knownWorkspaces = new Map<string, string>();
let backendActive: ActiveWorkspaceInfo | null = null;
const mockSetActive = vi.fn(async (id: string | null) => {
  if (id !== null && !knownWorkspaces.has(id)) throw new Error(`Workspace not found: ${id}`);
  backendActive = id === null ? null : { id, name: knownWorkspaces.get(id) ?? id };
});
vi.mock("@/services/workspaceApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/workspaceApi")>()),
  setActiveWorkspace: (id: string | null) => mockSetActive(id),
  getActiveWorkspace: async () => backendActive,
}));

import { useAppStore } from "./appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { loadLastSession } from "@/services/lastSessionApi";
import { getActiveWorkspace, setActiveWorkspaceLocal } from "@/services/workspaceSettings";
import type { LastSession } from "@/types/lastSession";
import type { ActiveWorkspaceInfo } from "@/types/workspace";

const mockLoad = vi.mocked(loadLastSession);

setupConnectionsRegion();
setupSettingsRegion();
setupAgentsRegion();

function sessionWith(activeWorkspaceId?: string): LastSession {
  return {
    version: "1",
    activeGroupIndex: 0,
    tabGroups: [
      {
        name: "Restored",
        layout: {
          type: "leaf",
          tabs: [{ inlineConfig: { type: "local", config: { shell: "bash" } }, title: "Shell" }],
        },
      },
    ],
    ...(activeWorkspaceId ? { activeWorkspaceId } : {}),
  };
}

describe("active workspace across restarts (#3517)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    knownWorkspaces.clear();
    knownWorkspaces.set("ws-1", "Prod");
    backendActive = null;
    setActiveWorkspaceLocal(null);
    takePendingWindowRestore.mockResolvedValue(null);
    collectWindowLayouts.mockResolvedValue([]);
    useAppStore.setState({ defaultShell: "bash", activeWorkspaceName: null });
    seedSettings({ restoreLastSessionOnStartup: true });
    seedConnectionsRegion({ connections: [] });
  });

  it("re-activates the session's workspace on restore", async () => {
    mockLoad.mockResolvedValue(sessionWith("ws-1"));

    expect(await useAppStore.getState().restoreLastSession()).toBe(true);

    expect(mockSetActive).toHaveBeenCalledWith("ws-1");
    expect(getActiveWorkspace()?.id).toBe("ws-1");
    expect(useAppStore.getState().activeWorkspaceName).toBe("Prod");
  });

  it("does not re-activate a workspace the backend already re-activated at startup", async () => {
    setActiveWorkspaceLocal({ id: "ws-1", name: "Prod" });
    mockLoad.mockResolvedValue(sessionWith("ws-1"));

    await useAppStore.getState().restoreLastSession();

    expect(mockSetActive).not.toHaveBeenCalled();
    expect(useAppStore.getState().activeWorkspaceName).toBe("Prod");
  });

  it("restores with none active when the recorded workspace no longer exists", async () => {
    mockLoad.mockResolvedValue(sessionWith("deleted"));

    expect(await useAppStore.getState().restoreLastSession()).toBe(true);

    expect(mockSetActive).toHaveBeenCalledWith("deleted");
    expect(getActiveWorkspace()).toBeNull();
    expect(useAppStore.getState().activeWorkspaceName).toBeNull();
  });

  it("leaves the active workspace alone for a session saved without one", async () => {
    mockLoad.mockResolvedValue(sessionWith());

    await useAppStore.getState().restoreLastSession();

    expect(mockSetActive).not.toHaveBeenCalled();
    expect(getActiveWorkspace()).toBeNull();
  });

  it("clears activeWorkspaceName when the active workspace is deleted (broadcast)", () => {
    setActiveWorkspaceLocal({ id: "ws-1", name: "Prod" });
    expect(useAppStore.getState().activeWorkspaceName).toBe("Prod");

    // `delete_workspace` of the active one broadcasts `null`.
    setActiveWorkspaceLocal(null);

    expect(useAppStore.getState().activeWorkspaceName).toBeNull();
  });

  it("follows a rename of the active workspace (broadcast)", () => {
    setActiveWorkspaceLocal({ id: "ws-1", name: "Prod" });
    setActiveWorkspaceLocal({ id: "ws-1", name: "Production" });
    expect(useAppStore.getState().activeWorkspaceName).toBe("Production");
  });
});
