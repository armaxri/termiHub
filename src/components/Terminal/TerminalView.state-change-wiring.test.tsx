/**
 * Pins the wiring between TerminalView and the backend state-change events
 * (TFE2-001, #4309): the `listen` callbacks hand each payload to the real,
 * separately tested handlers in `agentStateHandlers`, and unmount unlistens.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { handleAgentStateChange, handleRemoteStateChange } from "./agentStateHandlers";

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

const listeners = vi.hoisted(
  () =>
    new Map<string, { handler: (event: { payload: unknown }) => unknown; unlisten: () => void }>()
);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => unknown) => {
    const unlisten = vi.fn();
    listeners.set(name, { handler, unlisten });
    return Promise.resolve(unlisten);
  }),
}));

vi.mock("./agentStateHandlers", () => ({
  handleAgentStateChange: vi.fn(() => Promise.resolve()),
  handleRemoteStateChange: vi.fn(),
}));

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
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));
vi.mock("./TabGroupChips", () => ({ TabGroupChips: () => null }));
vi.mock("./MacroRecordSaveDialog", () => ({ MacroRecordSaveDialog: () => null }));
vi.mock("./MacroPlaybackDialog", () => ({ MacroPlaybackDialog: () => null }));
vi.mock("./BroadcastScopeDialog", () => ({ BroadcastScopeDialog: () => null }));
vi.mock("@/components/SplitView", () => ({ SplitView: () => null }));
vi.mock("@/services/events", () => ({ terminalDispatcher: { init: vi.fn() } }));
vi.mock("@/services/api", () => ({
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  sessionLoggingStart: vi.fn(() => Promise.resolve("/tmp/session.log")),
  sessionLoggingStop: vi.fn(() => Promise.resolve(null)),
  sessionLoggingStatus: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import { TerminalView } from "./TerminalView";

let container: HTMLDivElement;
let root: Root;

/** Let the `listen(...).then(...)` registrations settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("TerminalView — state-change event wiring (#4309)", () => {
  beforeEach(async () => {
    listeners.clear();
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<TerminalView />));
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("passes agent-state-change payloads to handleAgentStateChange", () => {
    const payload = { session_id: "agent-1", state: "disconnected" };
    listeners.get("agent-state-change")?.handler({ payload });
    expect(handleAgentStateChange).toHaveBeenCalledWith(payload);
  });

  it("passes remote-state-change payloads to handleRemoteStateChange", () => {
    const payload = { session_id: "session-1", state: "disconnected" };
    listeners.get("remote-state-change")?.handler({ payload });
    expect(handleRemoteStateChange).toHaveBeenCalledWith(payload);
  });

  it("unlistens both events on unmount", () => {
    const agent = listeners.get("agent-state-change");
    const remote = listeners.get("remote-state-change");
    act(() => root.unmount());
    root = createRoot(container);
    expect(agent?.unlisten).toHaveBeenCalledTimes(1);
    expect(remote?.unlisten).toHaveBeenCalledTimes(1);
  });
});
