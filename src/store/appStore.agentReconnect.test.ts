/**
 * appStore parity tests for the agent reconnect activation (#2476).
 *
 * The activation flag-gates the agent hot path behind `sessionBackendReattach`:
 *
 *  - {@link isResilientReconnectTabId} — an agent-hosted tab counts as resilient
 *    ONLY when the flag is on (flag off ⇒ agents excluded, byte-identical to
 *    develop). Direct-SSH classification is unchanged either way.
 *  - {@link isBackendDrivenAgentReconnectTabId} — the discriminator that routes
 *    an agent reconnect entirely to the backend (never the client agent engine)
 *    and suppresses the client connect deadline. True only for a non-persistent
 *    agent tab with the flag on.
 *  - `reconnectTerminal` — skips the fixed 90 s "connecting" deadline for a
 *    backend-driven agent reconnect (the backend park/retry legitimately
 *    outlasts it), while every other tab keeps the safety-net deadline.
 *  - `settleBackendReconnectGaveUp` — reflects a backend give-up as the
 *    disconnect overlay without re-mirroring any intent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  reloadExternalConnections: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  startPersistentSession: vi.fn(() => Promise.resolve("sid")),
  stopPersistentSession: vi.fn(() => Promise.resolve()),
  attachPersistentTab: vi.fn(() => Promise.resolve(1)),
  connectAgent: vi.fn(() => Promise.resolve({ capabilities: {} })),
  disconnectAgent: vi.fn(),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(() => Promise.resolve()),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(() => Promise.resolve({})),
  deleteAgentFolder: vi.fn(() => Promise.resolve()),
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  removeCredential: vi.fn(() => Promise.resolve()),
  getConnectionTypes: vi.fn(() => Promise.resolve([])),
  sessionGetCapabilities: vi.fn(() => Promise.resolve({})),
}));

import {
  useAppStore,
  isResilientReconnectTabId,
  isBackendDrivenAgentReconnectTabId,
} from "./appStore";
import { setSessionBackendReattachEnabled, setSessionIntentsEnabled } from "./sessionBridge";

/** A non-persistent agent (remote-session) shell tab. */
function makeAgentTab(): string {
  return useAppStore.getState().addTab(
    "Agent Shell",
    "remote-session",
    {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    },
    { contentType: "terminal", sessionId: "sess-agent" }
  );
}

/** A plain, resilient-opt-in direct SSH tab. */
function makeSshTab(): string {
  return useAppStore.getState().addTab(
    "web01",
    "ssh",
    {
      type: "ssh",
      config: { host: "web01.example.com", username: "deploy", resilientReconnect: true },
    },
    { contentType: "terminal", sessionId: "sess-ssh" }
  );
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  setSessionIntentsEnabled(true); // underlying cut default-on
});

afterEach(() => {
  setSessionBackendReattachEnabled(null);
  setSessionIntentsEnabled(null);
});

describe("agent tab resilient classification (#2476)", () => {
  it("flag OFF: an agent tab is NOT resilient (byte-identical to develop)", () => {
    setSessionBackendReattachEnabled(false);
    const tabId = makeAgentTab();
    expect(isResilientReconnectTabId(tabId)).toBe(false);
    expect(isBackendDrivenAgentReconnectTabId(tabId)).toBe(false);
  });

  it("flag ON: an agent tab IS resilient and backend-driven", () => {
    setSessionBackendReattachEnabled(true);
    const tabId = makeAgentTab();
    expect(isResilientReconnectTabId(tabId)).toBe(true);
    expect(isBackendDrivenAgentReconnectTabId(tabId)).toBe(true);
  });

  it("a direct SSH tab is never backend-driven-agent, and its resilience is unchanged", () => {
    setSessionBackendReattachEnabled(true);
    const tabId = makeSshTab();
    expect(isResilientReconnectTabId(tabId)).toBe(true); // opt-in, agentless #1962
    expect(isBackendDrivenAgentReconnectTabId(tabId)).toBe(false);

    setSessionBackendReattachEnabled(false);
    expect(isResilientReconnectTabId(tabId)).toBe(true); // still opt-in, flag-independent
    expect(isBackendDrivenAgentReconnectTabId(tabId)).toBe(false);
  });
});

describe("reconnectTerminal connect-deadline reconciliation (#2476)", () => {
  it("flag ON: a backend-driven agent reconnect arms NO connecting deadline", () => {
    setSessionBackendReattachEnabled(true);
    const tabId = makeAgentTab();
    useAppStore.getState().reconnectTerminal(tabId);
    expect(useAppStore.getState().terminalConnectDeadline[tabId]).toBeUndefined();
    // The reconnect still fired (retry counter bumped; the connecting overlay is
    // now sourced from the region, #2205 PR-B).
    expect(useAppStore.getState().terminalRetryCounters[tabId]).toBe(1);
  });

  it("flag OFF: an agent reconnect keeps the safety-net connecting deadline", () => {
    setSessionBackendReattachEnabled(false);
    const tabId = makeAgentTab();
    useAppStore.getState().reconnectTerminal(tabId);
    const deadline = useAppStore.getState().terminalConnectDeadline[tabId];
    expect(deadline?.kind).toBe("connecting");
    expect(deadline?.at).toBeGreaterThan(Date.now());
  });

  it("a direct SSH tab keeps the connecting deadline even with the flag on", () => {
    setSessionBackendReattachEnabled(true);
    const tabId = makeSshTab();
    useAppStore.getState().reconnectTerminal(tabId);
    expect(useAppStore.getState().terminalConnectDeadline[tabId]?.kind).toBe("connecting");
  });
});

describe("settleBackendReconnectGaveUp (#2476)", () => {
  it("clears the loop + connect flags and shows the disconnect overlay with the error", () => {
    setSessionBackendReattachEnabled(true);
    const tabId = makeAgentTab();
    // Simulate a live backend-driven reconnect: a fresh connect deadline armed.
    useAppStore.getState().reconnectTerminal(tabId);

    useAppStore.getState().settleBackendReconnectGaveUp(tabId, "agent unreachable");

    const state = useAppStore.getState();
    expect(state.terminalConnectDeadline[tabId]).toBeUndefined();
    expect(state.terminalExitedTabs[tabId]).toBe(true);
    expect(state.terminalDisconnectErrors[tabId]).toBe("agent unreachable");
  });
});
