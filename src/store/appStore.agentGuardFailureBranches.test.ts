import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Branch-coverage suite (TFE-005) for agent-lifecycle guard/bail-out branches and
 * best-effort refresh catches in appStore that were previously unexecuted.
 *
 * Focus categories (all failure/guard paths, asserting the observable outcome —
 * safe no-op / logged-not-swallowed — not just that a mock was called):
 *   - missing-entity bail-outs: `connectRemoteAgent`/`toggleAgentFolder` on an
 *     unknown id must no-op without hitting the backend.
 *   - best-effort transport teardown during `deleteRemoteAgent`: a disconnect
 *     failure on a still-connected agent is LOGGED (LogViewer), never thrown, and
 *     the delete still proceeds.
 *   - background refresh catches (`checkVscodeAvailability`,
 *     `refreshConnectionTypes`): a rejection is logged but must NOT toast (these
 *     are best-effort, so no error-toast spam) and must not corrupt state.
 */

const {
  mockConnectAgent,
  mockDisconnectAgent,
  mockUpdateAgentFolder,
  mockVscodeAvailable,
  mockGetConnectionTypes,
} = vi.hoisted(() => ({
  mockConnectAgent: vi.fn(() => Promise.resolve({ capabilities: {} })),
  mockDisconnectAgent: vi.fn(() => Promise.resolve()),
  mockUpdateAgentFolder: vi.fn(() => Promise.resolve({})),
  mockVscodeAvailable: vi.fn(() => Promise.resolve(false)),
  mockGetConnectionTypes: vi.fn(() => Promise.resolve([])),
}));

// Capture toast feedback so we can assert the ABSENCE of an error toast on the
// best-effort catches (they must log only, no toast).
const toastError = vi.fn((_message: unknown, _opts?: unknown) => undefined);
vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: (message: unknown, opts?: unknown) =>
      opts === undefined ? toastError(message) : toastError(message, opts),
    loading: vi.fn(() => "toast-id"),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  persistAgent: vi.fn(() => Promise.resolve()),
  removeAgent: vi.fn(() => Promise.resolve()),
  reorderAgents: vi.fn(() => Promise.resolve()),
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
  connectAgent: mockConnectAgent,
  disconnectAgent: mockDisconnectAgent,
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  listAgentDefinitions: vi.fn(() => Promise.resolve([])),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(() => Promise.resolve()),
  createAgentFolder: vi.fn(),
  updateAgentFolder: mockUpdateAgentFolder,
  deleteAgentFolder: vi.fn(() => Promise.resolve()),
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: mockVscodeAvailable,
  getConnectionTypes: mockGetConnectionTypes,
}));

import { useAppStore } from "./appStore";
import { currentAgentsView } from "./agentsBridge";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { onFrontendLog } from "@/utils/frontendLog";
import type { LogEntry } from "@/types/terminal";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: `agent-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Agent",
    config: { host: "test.local", port: 22, username: "user", authMethod: "password" },
    isExpanded: false,
    connectionState: "disconnected",
    agentSettings: DEFAULT_AGENT_SETTINGS,
    ...overrides,
  };
}

/** Flush the fire-and-forget promise chains. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

let logs: LogEntry[] = [];
let unsubscribe: () => void = () => {};

function logged(substring: string): boolean {
  return logs.some((e) => e.target === "frontend::app_store" && e.message.includes(substring));
}

setupAgentsRegion();

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  logs = [];
  unsubscribe = onFrontendLog((entry) => logs.push(entry));
});

afterEach(() => {
  unsubscribe();
});

describe("TFE-005 — agent missing-entity bail-outs", () => {
  it("connectRemoteAgent no-ops for an unknown agent id (no backend call, no throw)", async () => {
    await expect(
      useAppStore.getState().connectRemoteAgent("does-not-exist")
    ).resolves.toBeUndefined();
    expect(mockConnectAgent).not.toHaveBeenCalled();
  });

  it("toggleAgentFolder no-ops for an unknown folder (no persist, no throw)", () => {
    seedAgentsRegion({ remoteAgents: [makeAgent({ id: "agent-test-1" })] });
    expect(() =>
      useAppStore.getState().toggleAgentFolder("agent-test-1", "missing-folder")
    ).not.toThrow();
    expect(mockUpdateAgentFolder).not.toHaveBeenCalled();
  });
});

describe("TFE-005 — deleteRemoteAgent tears down a live transport best-effort", () => {
  it("disconnects a still-connected agent, logs a teardown failure, and still deletes", async () => {
    mockDisconnectAgent.mockRejectedValueOnce(new Error("socket hung"));
    const agent = makeAgent({ id: "agent-live", name: "Live", connectionState: "connected" });
    seedAgentsRegion({ remoteAgents: [agent] });

    // Must not throw even though the best-effort disconnect rejects.
    expect(() => useAppStore.getState().deleteRemoteAgent("agent-live")).not.toThrow();
    await flush();

    // The connected agent triggered a transport teardown before removal…
    expect(mockDisconnectAgent).toHaveBeenCalledWith("agent-live");
    // …whose failure was surfaced to the LogViewer, not swallowed…
    expect(logged("Failed to disconnect agent agent-live during delete")).toBe(true);
    expect(logged("socket hung")).toBe(true);
    // …and the delete still proceeded (optimistic region removal).
    expect(currentAgentsView().remoteAgents.find((a) => a.id === "agent-live")).toBeUndefined();
  });

  it("does not attempt a transport teardown for an already-disconnected agent", async () => {
    const agent = makeAgent({ id: "agent-idle", connectionState: "disconnected" });
    seedAgentsRegion({ remoteAgents: [agent] });

    useAppStore.getState().deleteRemoteAgent("agent-idle");
    await flush();

    expect(mockDisconnectAgent).not.toHaveBeenCalled();
    expect(currentAgentsView().remoteAgents.find((a) => a.id === "agent-idle")).toBeUndefined();
  });
});

describe("TFE-005 — best-effort refresh catches log without toasting", () => {
  it("checkVscodeAvailability logs on failure, does not toast, and leaves the flag false", async () => {
    mockVscodeAvailable.mockRejectedValueOnce(new Error("probe failed"));

    await useAppStore.getState().checkVscodeAvailability();
    await flush();

    expect(logged("Failed to check VS Code availability")).toBe(true);
    expect(logged("probe failed")).toBe(true);
    expect(toastError).not.toHaveBeenCalled();
    expect(useAppStore.getState().vscodeAvailable).toBe(false);
  });

  it("refreshConnectionTypes logs on failure, does not toast, and leaves types unchanged", async () => {
    mockGetConnectionTypes.mockRejectedValueOnce(new Error("registry down"));
    const before = useAppStore.getState().connectionTypes;

    await useAppStore.getState().refreshConnectionTypes();
    await flush();

    expect(logged("Failed to refresh connection types")).toBe(true);
    expect(logged("registry down")).toBe(true);
    expect(toastError).not.toHaveBeenCalled();
    expect(useAppStore.getState().connectionTypes).toEqual(before);
  });
});
