import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useAgentUpdatePendingEvents } from "./useAgentUpdatePendingEvents";
import {
  cancelAllAgentUpdateReconnects,
  isAgentUpdateReconnectActive,
  startAgentUpdateReconnect,
} from "@/store/agentUpdateReconnect";

vi.mock("@/services/events", () => ({
  onRemoteAgentUpdatePending: vi.fn().mockResolvedValue(() => {}),
}));

function Probe(): null {
  useAgentUpdatePendingEvents();
  return null;
}

describe("useAgentUpdatePendingEvents (#4311)", () => {
  afterEach(() => {
    cancelAllAgentUpdateReconnects();
    vi.useRealTimers();
  });

  it("stops every coordinated-update reconnect loop on unmount", () => {
    vi.useFakeTimers();
    const attempt = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(document.createElement("div"));
    act(() => root.render(<Probe />));
    startAgentUpdateReconnect("agent-1", {
      initialDelayMs: 1000,
      attempt,
      isConnected: () => false,
      onSuccess: vi.fn(),
      onGiveUp: vi.fn(),
    });
    expect(isAgentUpdateReconnectActive("agent-1")).toBe(true);

    act(() => root.unmount());

    expect(isAgentUpdateReconnectActive("agent-1")).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(attempt).not.toHaveBeenCalled();
  });
});
