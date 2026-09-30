/**
 * Branch coverage for the startup slice (#2979): `loadFromBackend`'s best-effort
 * guards (region subscribe throws, external-file errors, custom language
 * registration, shell detection fallbacks, recovery warnings, event-subscription
 * failures), the persistent-session state fold it registers, and
 * `refreshConnectionTypes`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PersistentSessionStateChange } from "@/services/events";

const m = vi.hoisted(() => ({
  loadConnections: vi.fn(),
  getSettings: vi.fn(),
  getRecoveryWarnings: vi.fn(),
  getConnectionTypes: vi.fn(),
  listAvailableShells: vi.fn(),
  getDefaultShell: vi.fn(),
  onConnectionIdsChanged: vi.fn(),
  onPersistentSessionStateChanged: vi.fn(),
  onThemeChange: vi.fn(),
  ensureConnectionsSubscribed: vi.fn(),
  ensureSettingsSubscribed: vi.fn(),
  ensureAgentsSubscribed: vi.fn(),
  registerAdditionalLanguagePackages: vi.fn(),
  registerCustomGrammars: vi.fn(),
  frontendLog: vi.fn(),
}));

vi.mock("@/themes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/themes")>()),
  applyTheme: vi.fn(),
  onThemeChange: (cb: () => void) => m.onThemeChange(cb),
}));

vi.mock("@/services/storage", () => ({
  loadConnections: () => m.loadConnections(),
  getSettings: () => m.getSettings(),
  getRecoveryWarnings: () => m.getRecoveryWarnings(),
  saveSettings: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  persistConnection: vi.fn(() => Promise.resolve("id")),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  getConnectionTypes: () => m.getConnectionTypes(),
  listAvailableShells: () => m.listAvailableShells(),
  getDefaultShell: () => m.getDefaultShell(),
}));

vi.mock("@/services/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/events")>()),
  onConnectionIdsChanged: (cb: unknown) => m.onConnectionIdsChanged(cb),
  onPersistentSessionStateChanged: (cb: unknown) => m.onPersistentSessionStateChanged(cb),
}));

vi.mock("@/services/workspaceSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/workspaceSettings")>()),
  primeActiveWorkspace: vi.fn(() => Promise.resolve()),
  applyEffectiveTheme: vi.fn(),
}));

vi.mock("@/store/connectionsBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/connectionsBridge")>()),
  ensureConnectionsSubscribed: () => m.ensureConnectionsSubscribed(),
}));
vi.mock("@/store/settingsBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/settingsBridge")>()),
  ensureSettingsSubscribed: () => m.ensureSettingsSubscribed(),
}));
vi.mock("@/store/agentsBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/agentsBridge")>()),
  ensureAgentsSubscribed: () => m.ensureAgentsSubscribed(),
}));

vi.mock("@/utils/monacoCustomLanguages", () => ({
  registerAdditionalLanguagePackages: (p: unknown) => m.registerAdditionalLanguagePackages(p),
  registerCustomGrammars: (g: unknown) => m.registerCustomGrammars(g),
}));

vi.mock("@/utils/frontendLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/frontendLog")>()),
  frontendLog: (...args: unknown[]) => m.frontendLog(...args),
}));

import { useAppStore } from "./appStore";

const noop = () => Promise.resolve();

function baseSettings(extra: Record<string, unknown> = {}) {
  return {
    version: "1",
    externalConnectionFiles: [],
    powerMonitoringEnabled: true,
    fileBrowserEnabled: true,
    ...extra,
  };
}

/** Whether any frontendLog line contains `text`. */
function logged(text: string): boolean {
  return m.frontendLog.mock.calls.some(([, msg]) => String(msg).includes(text));
}

describe("startupSlice — branch coverage (#2979)", () => {
  beforeEach(() => {
    for (const fn of Object.values(m)) fn.mockReset();
    m.loadConnections.mockResolvedValue({ externalErrors: [] });
    m.getSettings.mockResolvedValue(baseSettings());
    m.getRecoveryWarnings.mockResolvedValue([]);
    m.getConnectionTypes.mockResolvedValue([]);
    m.listAvailableShells.mockResolvedValue(["zsh", "bash"]);
    m.getDefaultShell.mockResolvedValue("zsh");
    m.onConnectionIdsChanged.mockResolvedValue(vi.fn());
    m.onPersistentSessionStateChanged.mockResolvedValue(vi.fn());
    m.ensureConnectionsSubscribed.mockResolvedValue(undefined);
    m.ensureSettingsSubscribed.mockResolvedValue(undefined);
    m.ensureAgentsSubscribed.mockResolvedValue(undefined);
    m.registerCustomGrammars.mockResolvedValue(undefined);
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      loadSessionHistory: noop,
      loadTunnels: noop,
      loadEmbeddedServers: noop,
      loadWorkspaces: noop,
      loadMacros: noop,
      loadWorkflows: noop,
      loadSchedules: noop,
      loadPlugins: noop,
      loadAppMode: noop,
      loadCredentialStoreStatus: noop,
      checkVscodeAvailability: noop,
    } as never);
  });

  it("keeps starting up when every region subscription throws", async () => {
    m.ensureConnectionsSubscribed.mockImplementation(() => {
      throw new Error("no socket");
    });
    m.ensureSettingsSubscribed.mockRejectedValue(new Error("settings down"));
    m.ensureAgentsSubscribed.mockRejectedValue(new Error("agents down"));

    await useAppStore.getState().loadFromBackend();

    expect(logged("connections region subscribe failed: no socket")).toBe(true);
    expect(logged("settings region subscribe failed: settings down")).toBe(true);
    expect(logged("agents region subscribe failed: agents down")).toBe(true);
    // Startup carried on past the failures.
    expect(m.getSettings).toHaveBeenCalled();
    expect(m.onPersistentSessionStateChanged).toHaveBeenCalled();
  });

  it("logs every external connection file that failed to load", async () => {
    m.loadConnections.mockResolvedValue({
      externalErrors: [
        { filePath: "/a.json", error: "bad json" },
        { filePath: "/b.json", error: "missing" },
      ],
    });

    await useAppStore.getState().loadFromBackend();

    expect(logged("Failed to load external file /a.json: bad json")).toBe(true);
    expect(logged("Failed to load external file /b.json: missing")).toBe(true);
  });

  it("registers installed language packages", async () => {
    const packages = [{ id: "pkg" }];
    m.getSettings.mockResolvedValue(baseSettings({ installedLanguagePackages: packages }));

    await useAppStore.getState().loadFromBackend();

    await vi.waitFor(() =>
      expect(m.registerAdditionalLanguagePackages).toHaveBeenCalledWith(packages)
    );
  });

  it("registers custom grammars", async () => {
    const grammars = [{ id: "g" }];
    m.getSettings.mockResolvedValue(baseSettings({ customLanguageGrammars: grammars }));

    await useAppStore.getState().loadFromBackend();

    await vi.waitFor(() => expect(m.registerCustomGrammars).toHaveBeenCalledWith(grammars));
  });

  it("logs a custom-grammar registration failure", async () => {
    m.getSettings.mockResolvedValue(baseSettings({ customLanguageGrammars: [{ id: "g" }] }));
    m.registerCustomGrammars.mockRejectedValue(new Error("bad grammar"));

    await useAppStore.getState().loadFromBackend();

    await vi.waitFor(() =>
      expect(logged("Failed to register custom grammars on startup: bad grammar")).toBe(true)
    );
  });

  it("re-renders when the OS theme changes", async () => {
    await useAppStore.getState().loadFromBackend();
    const listener = vi.fn();
    const unsub = useAppStore.subscribe(listener);

    const onChange = m.onThemeChange.mock.calls[0][0] as () => void;
    onChange();

    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("logs a connection-type registry failure and keeps the old registry", async () => {
    m.getConnectionTypes.mockRejectedValue(new Error("registry down"));
    const before = useAppStore.getState().connectionTypes;

    await useAppStore.getState().loadFromBackend();

    expect(useAppStore.getState().connectionTypes).toBe(before);
    expect(logged("Failed to load connection types: registry down")).toBe(true);
  });

  describe("default-shell detection", () => {
    it("falls back to the first available shell when the detected one is absent", async () => {
      m.getDefaultShell.mockResolvedValue("fish");
      await useAppStore.getState().loadFromBackend();
      expect(useAppStore.getState().defaultShell).toBe("zsh");
    });

    it("falls back to the first available shell when nothing is detected", async () => {
      m.listAvailableShells.mockResolvedValue(["bash"]);
      m.getDefaultShell.mockResolvedValue(null);
      await useAppStore.getState().loadFromBackend();
      expect(useAppStore.getState().defaultShell).toBe("bash");
    });

    it("keeps the current default when no shells are available", async () => {
      m.listAvailableShells.mockResolvedValue([]);
      const before = useAppStore.getState().defaultShell;
      await useAppStore.getState().loadFromBackend();
      expect(useAppStore.getState().defaultShell).toBe(before);
    });

    it("logs a detection failure", async () => {
      m.listAvailableShells.mockRejectedValue(new Error("no shells"));
      await useAppStore.getState().loadFromBackend();
      expect(logged("Failed to detect available shells: no shells")).toBe(true);
    });
  });

  describe("recovery warnings", () => {
    it("opens the recovery dialog when the backend reports warnings", async () => {
      const warnings = [{ file: "connections.json", message: "corrupt, recovered" }];
      m.getRecoveryWarnings.mockResolvedValue(warnings);

      await useAppStore.getState().loadFromBackend();

      expect(useAppStore.getState().recoveryWarnings).toEqual(warnings);
      expect(useAppStore.getState().recoveryDialogOpen).toBe(true);
    });

    it("logs a warnings-read failure without opening the dialog", async () => {
      m.getRecoveryWarnings.mockRejectedValue(new Error("io"));

      await useAppStore.getState().loadFromBackend();

      expect(useAppStore.getState().recoveryDialogOpen).toBe(false);
      expect(logged("Failed to load recovery warnings: io")).toBe(true);
    });
  });

  it("logs failures to subscribe to the backend events", async () => {
    m.onConnectionIdsChanged.mockRejectedValue(new Error("ids down"));
    m.onPersistentSessionStateChanged.mockRejectedValue(new Error("ps down"));

    await useAppStore.getState().loadFromBackend();

    await vi.waitFor(() => {
      expect(logged("Failed to subscribe to connection id changes: ids down")).toBe(true);
      expect(logged("Failed to subscribe to persistent session events: ps down")).toBe(true);
    });
  });

  it("follows renamed connection ids through the store", async () => {
    const follow = vi.fn();
    useAppStore.setState({ followConnectionIdChanges: follow } as never);
    await useAppStore.getState().loadFromBackend();

    const onChange = m.onConnectionIdsChanged.mock.calls[0][0] as (c: unknown) => void;
    onChange([{ oldId: "a", newId: "b" }]);

    expect(follow).toHaveBeenCalledWith([{ oldId: "a", newId: "b" }]);
  });

  describe("persistent-session state fold", () => {
    async function foldHandler(): Promise<(e: PersistentSessionStateChange) => void> {
      await useAppStore.getState().loadFromBackend();
      return m.onPersistentSessionStateChanged.mock.calls[0][0];
    }

    function event(extra: Partial<PersistentSessionStateChange>): PersistentSessionStateChange {
      return {
        connectionId: "c1",
        sessionId: null,
        state: "running",
        attachedTabCount: 0,
        ...extra,
      } as PersistentSessionStateChange;
    }

    it("adds a new session entry with no attached tabs", async () => {
      const fold = await foldHandler();
      fold(event({ sessionId: "s1", state: "running" }));

      expect(useAppStore.getState().persistentSessions.c1).toEqual({
        connectionId: "c1",
        sessionId: "s1",
        state: "running",
        attachedTabIds: [],
      });
    });

    it("keeps the known session id and attached tabs, and carries an error message", async () => {
      const fold = await foldHandler();
      useAppStore.setState({
        persistentSessions: {
          c1: { connectionId: "c1", sessionId: "s1", state: "running", attachedTabIds: ["t1"] },
        },
      });

      fold(event({ sessionId: null, state: "error", errorMessage: "crashed" }));

      expect(useAppStore.getState().persistentSessions.c1).toEqual({
        connectionId: "c1",
        sessionId: "s1",
        state: "error",
        attachedTabIds: ["t1"],
        errorMessage: "crashed",
      });
    });

    it("drops the entry when the session stops", async () => {
      const fold = await foldHandler();
      useAppStore.setState({
        persistentSessions: {
          c1: { connectionId: "c1", sessionId: "s1", state: "running", attachedTabIds: [] },
          c2: { connectionId: "c2", sessionId: "s2", state: "running", attachedTabIds: [] },
        },
      });

      fold(event({ state: "stopped" }));

      expect(Object.keys(useAppStore.getState().persistentSessions)).toEqual(["c2"]);
    });
  });

  describe("refreshConnectionTypes", () => {
    it("replaces the registry", async () => {
      const types = [{ typeId: "ssh" }];
      m.getConnectionTypes.mockResolvedValue(types);
      await useAppStore.getState().refreshConnectionTypes();
      expect(useAppStore.getState().connectionTypes).toEqual(types);
    });

    it("logs a failure and keeps the old registry", async () => {
      m.getConnectionTypes.mockRejectedValue("offline");
      const before = useAppStore.getState().connectionTypes;
      await useAppStore.getState().refreshConnectionTypes();
      expect(useAppStore.getState().connectionTypes).toBe(before);
      expect(logged("Failed to refresh connection types: offline")).toBe(true);
    });
  });
});
