import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAgentUpdatePendingEvents } from "./useAgentUpdatePendingEvents";
import { useAppStore } from "@/store/appStore";
import type { RemoteAgentUpdatePending } from "@/services/events";
import type { AgentUpdateReconnectEvent } from "@/types/generated/AgentUpdateReconnectEvent";

const subscriptions = vi.hoisted(() => ({
  pending: null as ((p: RemoteAgentUpdatePending) => void) | null,
  reconnect: null as ((e: AgentUpdateReconnectEvent) => void) | null,
}));

vi.mock("@/services/events", () => ({
  onRemoteAgentUpdatePending: vi.fn((cb: (p: RemoteAgentUpdatePending) => void) => {
    subscriptions.pending = cb;
    return Promise.resolve(() => {});
  }),
  onAgentUpdateReconnect: vi.fn((cb: (e: AgentUpdateReconnectEvent) => void) => {
    subscriptions.reconnect = cb;
    return Promise.resolve(() => {});
  }),
}));

function Probe(): null {
  useAgentUpdatePendingEvents();
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe("useAgentUpdatePendingEvents (#4489)", () => {
  let root: Root;
  const handlePending = vi.fn();
  const handleReconnect = vi.fn();

  beforeEach(() => {
    useAppStore.setState({
      handleAgentUpdatePending: handlePending,
      handleAgentUpdateReconnect: handleReconnect,
    });
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    act(() => root.unmount());
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  it("forwards the backend's waiting notice to the store", async () => {
    act(() => root.render(<Probe />));
    await flush();

    subscriptions.pending?.({
      agentId: "agent-1",
      requestedByVersion: "1.4.0",
      estimatedRestartSecs: 5,
    });

    expect(handlePending).toHaveBeenCalledWith("agent-1", "1.4.0", 5);
  });

  it("forwards the backend's reconnect outcome to the store", async () => {
    act(() => root.render(<Probe />));
    await flush();
    const event: AgentUpdateReconnectEvent = {
      agentId: "agent-1",
      requestedByVersion: "1.4.0",
      outcome: "reconnected",
      attempts: 1,
      agentVersion: "1.4.0",
    };

    subscriptions.reconnect?.(event);

    expect(handleReconnect).toHaveBeenCalledWith(event);
  });
});
