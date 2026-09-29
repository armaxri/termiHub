/**
 * Pins the startup hydration order of `loadFromBackend` (ARCH-001/FES-011, #2881).
 *
 * `loadFromBackend` is the store's startup orchestrator: it primes the
 * region subscriptions, hydrates the persisted settings side-effects, loads the
 * connection-type registry and default shell, fans out to every domain's
 * loader, and finally registers the backend event subscriptions. Several of
 * these steps read what an earlier step populated (e.g. the theme apply reads
 * the workspace primed just before it), so the sequence is behavior. This test
 * records every step in call order so moving the orchestrator between modules
 * cannot silently reorder it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const calls: string[] = [];
const record =
  <T>(name: string, value?: T) =>
  () => {
    calls.push(name);
    return value;
  };

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      loading: vi.fn(() => "toast-id"),
      info: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => {
    calls.push("onThemeChange");
    return vi.fn();
  }),
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() => {
    calls.push("loadConnections");
    return Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] });
  }),
  getSettings: vi.fn(() => {
    calls.push("getSettings");
    return Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
      keybindingOverrides: [],
    });
  }),
  saveSettings: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => {
    calls.push("getRecoveryWarnings");
    return Promise.resolve([]);
  }),
  persistConnection: vi.fn(() => Promise.resolve("id")),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/services/api")>("@/services/api");
  return {
    ...actual,
    getConnectionTypes: vi.fn(() => {
      calls.push("getConnectionTypes");
      return Promise.resolve([]);
    }),
    listAvailableShells: vi.fn(() => {
      calls.push("listAvailableShells");
      return Promise.resolve(["zsh", "bash"]);
    }),
    getDefaultShell: vi.fn(() => {
      calls.push("getDefaultShell");
      return Promise.resolve("zsh");
    }),
  };
});

vi.mock("@/services/events", async () => {
  const actual = await vi.importActual<typeof import("@/services/events")>("@/services/events");
  return {
    ...actual,
    onConnectionIdsChanged: vi.fn(() => {
      calls.push("onConnectionIdsChanged");
      return Promise.resolve(vi.fn());
    }),
    onPersistentSessionStateChanged: vi.fn(() => {
      calls.push("onPersistentSessionStateChanged");
      return Promise.resolve(vi.fn());
    }),
  };
});

vi.mock("@/services/workspaceSettings", async () => {
  const actual = await vi.importActual<typeof import("@/services/workspaceSettings")>(
    "@/services/workspaceSettings"
  );
  return {
    ...actual,
    primeActiveWorkspace: vi.fn(() => {
      calls.push("primeActiveWorkspace");
      return Promise.resolve();
    }),
    applyEffectiveTheme: vi.fn(() => {
      calls.push("applyEffectiveTheme");
    }),
  };
});

vi.mock("@/services/keybindings", async () => {
  const actual =
    await vi.importActual<typeof import("@/services/keybindings")>("@/services/keybindings");
  return {
    ...actual,
    setOverrides: vi.fn(() => {
      calls.push("setKeybindingOverrides");
    }),
  };
});

vi.mock("@/store/connectionsBridge", async () => {
  const actual = await vi.importActual<typeof import("@/store/connectionsBridge")>(
    "@/store/connectionsBridge"
  );
  return {
    ...actual,
    ensureConnectionsSubscribed: vi.fn(() => {
      calls.push("ensureConnectionsSubscribed");
      return Promise.resolve();
    }),
  };
});

vi.mock("@/store/settingsBridge", async () => {
  const actual =
    await vi.importActual<typeof import("@/store/settingsBridge")>("@/store/settingsBridge");
  return {
    ...actual,
    ensureSettingsSubscribed: vi.fn(() => {
      calls.push("ensureSettingsSubscribed");
      return Promise.resolve();
    }),
  };
});

vi.mock("@/store/agentsBridge", async () => {
  const actual =
    await vi.importActual<typeof import("@/store/agentsBridge")>("@/store/agentsBridge");
  return {
    ...actual,
    ensureAgentsSubscribed: vi.fn(() => {
      calls.push("ensureAgentsSubscribed");
      return Promise.resolve();
    }),
  };
});

import { useAppStore } from "./appStore";

describe("loadFromBackend startup hydration order (#2881)", () => {
  beforeEach(() => {
    calls.length = 0;
    useAppStore.setState({
      loadSessionHistory: record("loadSessionHistory", Promise.resolve()),
      loadTunnels: record("loadTunnels", Promise.resolve()),
      loadEmbeddedServers: record("loadEmbeddedServers", Promise.resolve()),
      loadWorkspaces: record("loadWorkspaces", Promise.resolve()),
      loadMacros: record("loadMacros", Promise.resolve()),
      loadWorkflows: record("loadWorkflows", Promise.resolve()),
      loadSchedules: record("loadSchedules", Promise.resolve()),
      loadPlugins: record("loadPlugins", Promise.resolve()),
      loadAppMode: record("loadAppMode", Promise.resolve()),
      loadCredentialStoreStatus: record("loadCredentialStoreStatus", Promise.resolve()),
      checkVscodeAvailability: record("checkVscodeAvailability", Promise.resolve()),
    } as never);
  });

  it("runs every startup step in the pinned order", async () => {
    await useAppStore.getState().loadFromBackend();

    expect(calls).toEqual([
      // Region subscriptions + persisted settings side-effects.
      "loadConnections",
      "ensureConnectionsSubscribed",
      "ensureSettingsSubscribed",
      "ensureAgentsSubscribed",
      "getSettings",
      "primeActiveWorkspace",
      "applyEffectiveTheme",
      "loadSessionHistory",
      "setKeybindingOverrides",
      "onThemeChange",
      // Connection-type registry, then default-shell detection.
      "getConnectionTypes",
      "listAvailableShells",
      "getDefaultShell",
      // Per-domain loaders.
      "loadTunnels",
      "loadEmbeddedServers",
      "loadWorkspaces",
      "loadMacros",
      "loadWorkflows",
      "loadSchedules",
      "loadPlugins",
      "loadAppMode",
      "loadCredentialStoreStatus",
      "checkVscodeAvailability",
      "getRecoveryWarnings",
      // Backend event subscriptions are registered last.
      "onConnectionIdsChanged",
      "onPersistentSessionStateChanged",
    ]);
  });

  it("picks the detected default shell when it is available", async () => {
    await useAppStore.getState().loadFromBackend();
    expect(useAppStore.getState().defaultShell).toBe("zsh");
  });
});
