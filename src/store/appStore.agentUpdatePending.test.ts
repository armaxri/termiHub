import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAppStore } from "@/store/appStore";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import type { RemoteAgentDefinition } from "@/types/connection";
import type { AgentUpdateReconnectEvent } from "@/types/generated/AgentUpdateReconnectEvent";

/**
 * The coordinated agent-update notice (#1602, #4311, #4489). The backend
 * suspends the agent and drives the reconnect once for every window; the store
 * only presents its state: the waiting notice, then reconnected, failed with a
 * manual Reconnect, cancelled, or superseded.
 */

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
  promise: vi.fn(),
}));

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, toast: toastMocks };
});

const apiMocks = vi.hoisted(() => ({
  connectAgent: vi.fn(),
  disconnectAgent: vi.fn(),
  cancelAgentUpdateReconnect: vi.fn(),
  removeAgent: vi.fn(),
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    connectAgent: apiMocks.connectAgent,
    disconnectAgent: apiMocks.disconnectAgent,
    cancelAgentUpdateReconnect: apiMocks.cancelAgentUpdateReconnect,
  };
});

vi.mock("@/services/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/storage")>();
  return { ...actual, removeAgent: apiMocks.removeAgent };
});

const AGENT_ID = "agent-1";
const TOAST_ID = `agent-update-pending-${AGENT_ID}`;

function seedAgent(): void {
  const agent = {
    id: AGENT_ID,
    name: "prod-box",
    config: { host: "h", port: 22, username: "u", authMethod: "key" },
    // The backend's suspend leaves the agent disconnected while it restarts.
    connectionState: "disconnected",
    isExpanded: true,
  } as unknown as RemoteAgentDefinition;
  seedAgentsRegion({ remoteAgents: [agent] });
}

function outcome(
  partial: Partial<AgentUpdateReconnectEvent> & Pick<AgentUpdateReconnectEvent, "outcome">
): AgentUpdateReconnectEvent {
  return { agentId: AGENT_ID, requestedByVersion: "1.4.0", attempts: 1, ...partial };
}

setupAgentsRegion();

describe("coordinated agent-update notice (#4489)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    seedAgent();
    apiMocks.cancelAgentUpdateReconnect.mockResolvedValue(true);
    apiMocks.removeAgent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("waiting", () => {
    it("records the notice and shows a loading notice with Cancel", () => {
      useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);

      const pending = useAppStore.getState().agentUpdatePending[AGENT_ID];
      expect(pending).toMatchObject({ requestedByVersion: "1.4.0", estimatedRestartSecs: 5 });
      expect(toastMocks.loading).toHaveBeenCalledTimes(1);
      const [message, opts] = toastMocks.loading.mock.calls[0];
      expect(message).toBe("prod-box is being updated by another host…");
      expect(opts.id).toBe(TOAST_ID);
      expect(opts.action.label).toBe("Cancel");
    });

    it("runs no reconnect of its own: the backend owns the suspend and reconnect", () => {
      vi.useFakeTimers();
      try {
        useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
        vi.advanceTimersByTime(300_000);
        expect(apiMocks.disconnectAgent).not.toHaveBeenCalled();
        expect(apiMocks.connectAgent).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores a duplicate notice for the same update", () => {
      useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
      useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
      expect(toastMocks.loading).toHaveBeenCalledTimes(1);
    });

    it("shows a newer update's notice in place of the older one", () => {
      useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
      useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.5.0", 10);
      expect(useAppStore.getState().agentUpdatePending[AGENT_ID].requestedByVersion).toBe("1.5.0");
      expect(toastMocks.loading).toHaveBeenCalledTimes(2);
      expect(toastMocks.loading.mock.calls[1][1].id).toBe(TOAST_ID);
    });
  });

  describe("reconnected", () => {
    it("claims the updated version when the agent reports the requested one", () => {
      useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
      useAppStore
        .getState()
        .handleAgentUpdateReconnect(outcome({ outcome: "reconnected", agentVersion: "1.4.0" }));

      expect(useAppStore.getState().agentUpdatePending[AGENT_ID]).toBeUndefined();
      expect(toastMocks.success).toHaveBeenCalledWith(
        "prod-box reconnected to the updated version.",
        { id: TOAST_ID, description: "Agent version 1.4.0." }
      );
    });

    it("does not claim the update when the agent reports another version", () => {
      useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
      useAppStore
        .getState()
        .handleAgentUpdateReconnect(outcome({ outcome: "reconnected", agentVersion: "1.3.0" }));

      const [message, opts] = toastMocks.success.mock.calls[0];
      expect(message).toBe("prod-box reconnected.");
      expect(opts.description).toMatch(/still reports version 1\.3\.0/);
    });

    it("does not claim the update when the agent reports no version", () => {
      useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
      useAppStore.getState().handleAgentUpdateReconnect(outcome({ outcome: "reconnected" }));

      expect(toastMocks.success).toHaveBeenCalledWith("prod-box reconnected.", {
        id: TOAST_ID,
        description: undefined,
      });
    });
  });

  describe("failed", () => {
    it("shows the failure with a manual Reconnect that connects the agent", async () => {
      apiMocks.connectAgent.mockResolvedValue({ capabilities: { connectionTypes: [] } });
      useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
      useAppStore
        .getState()
        .handleAgentUpdateReconnect(
          outcome({ outcome: "failed", attempts: 8, error: "connection refused" })
        );

      expect(useAppStore.getState().agentUpdatePending[AGENT_ID]).toBeUndefined();
      expect(toastMocks.error).toHaveBeenCalledTimes(1);
      const [message, opts] = toastMocks.error.mock.calls[0];
      expect(message).toBe("Couldn't reconnect to prod-box after the update.");
      expect(opts.id).toBe(TOAST_ID);
      expect(opts.action.label).toBe("Reconnect");

      opts.action.onClick();
      await vi.waitFor(() =>
        expect(toastMocks.success).toHaveBeenCalledWith("prod-box reconnected.", {
          id: TOAST_ID,
        })
      );
      expect(apiMocks.connectAgent).toHaveBeenCalledTimes(1);
    });

    it("re-offers Reconnect when the manual reconnect fails too", async () => {
      apiMocks.connectAgent.mockRejectedValue(new Error("host down"));
      useAppStore.getState().handleAgentUpdateReconnect(outcome({ outcome: "failed" }));

      toastMocks.error.mock.calls[0][1].action.onClick();
      await vi.waitFor(() => expect(toastMocks.error).toHaveBeenCalledTimes(2));
      const [message, opts] = toastMocks.error.mock.calls[1];
      expect(message).toBe("Couldn't reconnect to prod-box.");
      expect(opts.action.label).toBe("Reconnect");
    });
  });

  describe("cancel", () => {
    it("the notice's Cancel asks the backend to stop the reconnect", async () => {
      useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);

      toastMocks.loading.mock.calls[0][1].action.onClick();

      await vi.waitFor(() =>
        expect(apiMocks.cancelAgentUpdateReconnect).toHaveBeenCalledWith(AGENT_ID)
      );
      // The backend's `cancelled` event resolves the notice, in every window.
      expect(useAppStore.getState().agentUpdatePending[AGENT_ID]).toBeDefined();
    });

    it("presents the backend's cancelled outcome with a manual Reconnect", () => {
      useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
      useAppStore.getState().handleAgentUpdateReconnect(outcome({ outcome: "cancelled" }));

      expect(useAppStore.getState().agentUpdatePending[AGENT_ID]).toBeUndefined();
      const [message, opts] = toastMocks.info.mock.calls[0];
      expect(message).toBe("Stopped reconnecting to prod-box.");
      expect(opts.id).toBe(TOAST_ID);
      expect(opts.action.label).toBe("Reconnect");
    });

    it("reports a failed Cancel instead of resolving silently", async () => {
      apiMocks.cancelAgentUpdateReconnect.mockRejectedValue(new Error("ipc down"));
      useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);

      await useAppStore.getState().cancelAgentUpdateReconnect(AGENT_ID);

      expect(toastMocks.error).toHaveBeenCalledWith("Couldn't stop reconnecting to prod-box.", {
        id: TOAST_ID,
        description: "ipc down",
      });
    });
  });

  describe("superseded", () => {
    it("drops the notice quietly", () => {
      useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
      useAppStore.getState().handleAgentUpdateReconnect(outcome({ outcome: "superseded" }));

      expect(useAppStore.getState().agentUpdatePending[AGENT_ID]).toBeUndefined();
      expect(toastMocks.dismiss).toHaveBeenCalledWith(TOAST_ID);
      expect(toastMocks.success).not.toHaveBeenCalled();
      expect(toastMocks.error).not.toHaveBeenCalled();
      expect(toastMocks.info).not.toHaveBeenCalled();
    });

    it("deleting the agent stops the backend's reconnect as superseded", () => {
      useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
      useAppStore.getState().deleteRemoteAgent(AGENT_ID);
      expect(apiMocks.cancelAgentUpdateReconnect).toHaveBeenCalledWith(AGENT_ID, {
        superseded: true,
      });
    });

    it("deleting an agent with no update notice does not call the backend", () => {
      useAppStore.getState().deleteRemoteAgent(AGENT_ID);
      expect(apiMocks.cancelAgentUpdateReconnect).not.toHaveBeenCalled();
    });
  });

  it("clearAgentUpdatePending drops the recorded notice", () => {
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
    useAppStore.getState().clearAgentUpdatePending(AGENT_ID);
    expect(useAppStore.getState().agentUpdatePending[AGENT_ID]).toBeUndefined();
  });
});
