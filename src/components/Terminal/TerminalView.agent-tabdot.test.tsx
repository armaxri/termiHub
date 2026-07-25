/**
 * G5 (#1236): the compact tab-strip dot must agree with the agent state.
 *
 * The tab-strip dot for a remote-session tab has two independent inputs: the
 * tab-id-keyed lifecycle maps (drive `deriveTabStatus`) and the legacy
 * session-id-keyed `remoteStates` map. Before this change the agent path never
 * wrote `remoteStates`, so a consumer of `remoteStates[sessionId]` saw a stale
 * "connected"/green value straight through a drop or reconnect.
 *
 * These tests render the real TerminalView, capture the `agent-state-change`
 * Tauri listener it registers, and fire synthetic events — asserting that the
 * handler now mirrors the agent state into `remoteStates[tab.sessionId]`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { getAllLeaves } from "@/utils/panelTree";

// ── Capture the `agent-state-change` listener callback ──────────────────────

type AgentStatePayload = { session_id: string; state: string; error?: string };
type ListenCb = (event: { payload: AgentStatePayload }) => void | Promise<void>;

const listeners = new Map<string, ListenCb>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((eventName: string, cb: ListenCb) => {
    listeners.set(eventName, cb);
    return Promise.resolve(() => listeners.delete(eventName));
  }),
}));

// ── Stub the heavy child tree so we can render TerminalView in isolation ─────

vi.mock("./TerminalRegistry", () => ({
  TerminalPortalProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./TerminalCommandBridge", () => ({ TerminalCommandBridge: () => null }));
vi.mock("@/testbridge/TestBridge", () => ({ TestBridge: () => null }));
vi.mock("./Terminal", () => ({ Terminal: () => null }));
vi.mock("@/components/ui", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  Button: ({
    icon,
    children,
    className,
    variant: _variant,
    size: _size,
    iconOnly: _iconOnly,
    fullWidth: _fullWidth,
    pendingLabel: _pendingLabel,
    errorToast: _errorToast,
    ...rest
  }: {
    icon?: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => (
    <button className={["ui-btn", className].filter(Boolean).join(" ")} {...rest}>
      {icon}
      {children}
    </button>
  ),
}));
vi.mock("./TabGroupChips", () => ({ TabGroupChips: () => null }));
vi.mock("./MacroRecordSaveDialog", () => ({ MacroRecordSaveDialog: () => null }));
vi.mock("./MacroPlaybackDialog", () => ({ MacroPlaybackDialog: () => null }));
vi.mock("./BroadcastScopeDialog", () => ({ BroadcastScopeDialog: () => null }));
vi.mock("@/components/SplitView", () => ({ SplitView: () => null }));
vi.mock("@/services/events", () => ({ terminalDispatcher: { init: vi.fn() } }));
vi.mock("@/services/api", () => ({
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  sessionGetCapabilities: vi.fn(() => Promise.resolve({ monitoring: false, fileBrowser: false })),
  sessionMonitoringOpen: vi.fn(() => Promise.resolve()),
  sessionMonitoringClose: vi.fn(() => Promise.resolve()),
  sessionLoggingStart: vi.fn(() => Promise.resolve("/tmp/session.log")),
  sessionLoggingStop: vi.fn(() => Promise.resolve(null)),
  sessionLoggingStatus: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import { TerminalView } from "./TerminalView";

let container: HTMLDivElement;
let root: Root;

function firstTerminalTab() {
  const store = useAppStore.getState();
  return getAllLeaves(store.rootPanel).flatMap((l) => l.tabs)[0];
}

async function fireAgentState(payload: AgentStatePayload) {
  const cb = listeners.get("agent-state-change");
  if (!cb) throw new Error("agent-state-change listener was not registered");
  await act(async () => {
    await cb({ payload });
  });
}

describe("TerminalView agent-state-change → tab-strip dot (G5, #1236)", () => {
  beforeEach(() => {
    listeners.clear();
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    // A remote-session tab bound to agent-1 with an established session.
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = firstTerminalTab();
    store.setTabSessionId(tab.id, "session-123");

    act(() => {
      root.render(React.createElement(TerminalView));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("mirrors a 'reconnecting' agent event into remoteStates[tab.sessionId]", async () => {
    await fireAgentState({ session_id: "agent-1", state: "reconnecting" });

    expect(useAppStore.getState().remoteStates["session-123"]).toBe("reconnecting");
  });

  it("mirrors a 'disconnected' agent event into remoteStates[tab.sessionId]", async () => {
    await fireAgentState({ session_id: "agent-1", state: "disconnected", error: "boom" });

    expect(useAppStore.getState().remoteStates["session-123"]).toBe("disconnected");
  });

  it("does not write remoteStates for a tab without an established session", async () => {
    // Open a second tab that never established a session.
    const store = useAppStore.getState();
    store.addTab("Shell 2", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });

    await fireAgentState({ session_id: "agent-1", state: "reconnecting" });

    // Only the established session was mirrored; no `null`/undefined key leaks in.
    const remoteStates = useAppStore.getState().remoteStates;
    expect(remoteStates["session-123"]).toBe("reconnecting");
    expect(Object.keys(remoteStates)).toEqual(["session-123"]);
  });
});
