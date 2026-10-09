import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAppStore } from "@/store/appStore";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import type { RemoteAgentDefinition } from "@/types/connection";
import {
  AGENT_UPDATE_RECONNECT_DEADLINE_MS,
  cancelAllAgentUpdateReconnects,
  isAgentUpdateReconnectActive,
} from "@/store/agentUpdateReconnect";

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
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    connectAgent: apiMocks.connectAgent,
    disconnectAgent: apiMocks.disconnectAgent,
  };
});

const AGENT_ID = "agent-1";

function seedAgent(overrides: Partial<RemoteAgentDefinition> = {}): void {
  const agent = {
    id: AGENT_ID,
    name: "prod-box",
    config: { host: "h", port: 22, username: "u", authMethod: "key" },
    // The suspend disconnect leaves the agent disconnected while it restarts.
    connectionState: "disconnected",
    isExpanded: true,
    ...overrides,
  } as unknown as RemoteAgentDefinition;
  seedAgentsRegion({ remoteAgents: [agent] });
}

setupAgentsRegion();

type ConnectFn = (agentId: string, password?: string) => Promise<void>;

describe("handleAgentUpdatePending (coordinated-update notice, #1602)", () => {
  let disconnect: ReturnType<typeof vi.fn>;
  let connect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // No jitter shortening: every backoff window is its nominal length.
    vi.spyOn(Math, "random").mockReturnValue(0);
    useAppStore.setState(useAppStore.getInitialState());
    seedAgent();
    // Isolate the orchestration from the real connect/disconnect (which hit the
    // Tauri API) by overriding them with spies on the store instance.
    disconnect = vi.fn().mockResolvedValue(undefined);
    connect = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      disconnectRemoteAgent: disconnect as never,
      connectRemoteAgent: connect as unknown as ConnectFn,
    });
  });

  afterEach(() => {
    cancelAllAgentUpdateReconnects();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("records the pending notice, suspends the connection, and shows the notice", () => {
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);

    const pending = useAppStore.getState().agentUpdatePending[AGENT_ID];
    expect(pending).toBeDefined();
    expect(pending.requestedByVersion).toBe("1.4.0");
    expect(pending.estimatedRestartSecs).toBe(5);

    // Disconnecting is the ack the updating host waits for.
    // A suspend, not a user end: the hosted tabs resume after the update (#4309).
    expect(disconnect).toHaveBeenCalledWith(AGENT_ID, { endHostedSessions: false });
    // A loading toast surfaces the in-progress suspend, with a way to stop it.
    expect(toastMocks.loading).toHaveBeenCalledTimes(1);
    expect(toastMocks.loading.mock.calls[0][1].action.label).toBe("Cancel");
    // The reconnect has not fired yet.
    expect(connect).not.toHaveBeenCalled();
  });

  it("makes the first reconnect attempt after the restart window (estimate + buffer)", async () => {
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);

    // estimate 5s + 3s buffer = 8s. Just before the window, nothing reconnects.
    await vi.advanceTimersByTimeAsync(7999);
    expect(connect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledWith(AGENT_ID);
  });

  it("keeps the notice until the reconnect settles, then resolves it to success", async () => {
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
    await vi.advanceTimersByTimeAsync(8000);
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().agentUpdatePending[AGENT_ID]).toBeUndefined();
    expect(isAgentUpdateReconnectActive(AGENT_ID)).toBe(false);
  });

  it("retries with increasing delays until the agent is back", async () => {
    connect
      .mockRejectedValueOnce(new Error("still restarting"))
      .mockRejectedValueOnce(new Error("still restarting"))
      .mockRejectedValueOnce(new Error("still restarting"))
      .mockResolvedValueOnce(undefined);
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);

    // Attempt 1 at 8 s fails.
    await vi.advanceTimersByTimeAsync(8000);
    expect(connect).toHaveBeenCalledTimes(1);
    // Still pending, no failure reported yet — the loop keeps going.
    expect(useAppStore.getState().agentUpdatePending[AGENT_ID]).toBeDefined();
    expect(toastMocks.error).not.toHaveBeenCalled();

    // Attempt 2 after a 2 s backoff.
    await vi.advanceTimersByTimeAsync(1999);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(2);

    // Attempt 3 after a longer, 4 s backoff.
    await vi.advanceTimersByTimeAsync(3999);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(3);

    // Attempt 4 after an 8 s backoff succeeds.
    await vi.advanceTimersByTimeAsync(8000);
    expect(connect).toHaveBeenCalledTimes(4);
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
    expect(toastMocks.error).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentUpdatePending[AGENT_ID]).toBeUndefined();

    // Nothing else is scheduled once it is back.
    await vi.advanceTimersByTimeAsync(AGENT_UPDATE_RECONNECT_DEADLINE_MS);
    expect(connect).toHaveBeenCalledTimes(4);
  });

  it("stops at the deadline and shows the failure state with a manual Reconnect", async () => {
    connect.mockRejectedValue(new Error("host down"));
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);

    await vi.advanceTimersByTimeAsync(AGENT_UPDATE_RECONNECT_DEADLINE_MS - 1);
    expect(toastMocks.error).not.toHaveBeenCalled();
    const attemptsBeforeDeadline = connect.mock.calls.length;
    expect(attemptsBeforeDeadline).toBeGreaterThan(3);

    await vi.advanceTimersByTimeAsync(1);
    expect(toastMocks.error).toHaveBeenCalledTimes(1);
    const [, opts] = toastMocks.error.mock.calls[0];
    expect(opts.id).toBe(`agent-update-pending-${AGENT_ID}`);
    expect(opts.action.label).toBe("Reconnect");
    expect(useAppStore.getState().agentUpdatePending[AGENT_ID]).toBeUndefined();
    expect(isAgentUpdateReconnectActive(AGENT_ID)).toBe(false);

    // No retry after giving up.
    const attemptsAtGiveUp = connect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(AGENT_UPDATE_RECONNECT_DEADLINE_MS);
    expect(connect).toHaveBeenCalledTimes(attemptsAtGiveUp);

    // The manual Reconnect triggers a fresh connect.
    connect.mockResolvedValueOnce(undefined);
    opts.action.onClick();
    expect(connect).toHaveBeenCalledTimes(attemptsAtGiveUp + 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(toastMocks.success).toHaveBeenCalledWith(
      "prod-box reconnected.",
      expect.objectContaining({ id: `agent-update-pending-${AGENT_ID}` })
    );
  });

  it("never ends the hosted sessions while retrying or after giving up", async () => {
    connect.mockRejectedValue(new Error("host down"));
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
    await vi.advanceTimersByTimeAsync(AGENT_UPDATE_RECONNECT_DEADLINE_MS);
    // Only the one suspend disconnect — no user-style disconnect that ends tabs.
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(AGENT_ID, { endHostedSessions: false });
  });

  it("stops retrying when the user cancels", async () => {
    connect.mockRejectedValue(new Error("host down"));
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
    await vi.advanceTimersByTimeAsync(8000);
    expect(connect).toHaveBeenCalledTimes(1);

    // The Cancel action on the loading toast.
    toastMocks.loading.mock.calls[0][1].action.onClick();

    await vi.advanceTimersByTimeAsync(AGENT_UPDATE_RECONNECT_DEADLINE_MS);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().agentUpdatePending[AGENT_ID]).toBeUndefined();
    // A clear stopped state with a manual Reconnect, not a silent stop.
    const stopped = toastMocks.info.mock.calls.find(([, o]) => o?.action?.label === "Reconnect");
    expect(stopped).toBeDefined();
  });

  it("stops retrying when every loop is cancelled (unmount / window close)", async () => {
    connect.mockRejectedValue(new Error("host down"));
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
    await vi.advanceTimersByTimeAsync(8000);
    cancelAllAgentUpdateReconnects();
    await vi.advanceTimersByTimeAsync(AGENT_UPDATE_RECONNECT_DEADLINE_MS);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("stops retrying when the user disconnects the agent", async () => {
    connect.mockRejectedValue(new Error("host down"));
    const realDisconnect = useAppStore.getInitialState().disconnectRemoteAgent;
    apiMocks.disconnectAgent.mockResolvedValue(undefined);
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
    await vi.advanceTimersByTimeAsync(8000);

    useAppStore.setState({ disconnectRemoteAgent: realDisconnect });
    await useAppStore.getState().disconnectRemoteAgent(AGENT_ID);

    await vi.advanceTimersByTimeAsync(AGENT_UPDATE_RECONNECT_DEADLINE_MS);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().agentUpdatePending[AGENT_ID]).toBeUndefined();
  });

  it("a newer update notice restarts the loop with the new restart window", async () => {
    connect.mockRejectedValue(new Error("host down"));
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
    await vi.advanceTimersByTimeAsync(8000);
    expect(connect).toHaveBeenCalledTimes(1);

    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.5.0", 10);
    expect(useAppStore.getState().agentUpdatePending[AGENT_ID].requestedByVersion).toBe("1.5.0");
    // The old loop's 2 s retry does not fire; the new one waits 10 + 3 s.
    await vi.advanceTimersByTimeAsync(12_999);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("ignores a duplicate notice while an agent is already suspended", () => {
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
    // Only the first notice suspends + toasts.
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(toastMocks.loading).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect if the notice was cleared before the window elapsed", async () => {
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
    useAppStore.getState().clearAgentUpdatePending(AGENT_ID);
    await vi.advanceTimersByTimeAsync(AGENT_UPDATE_RECONNECT_DEADLINE_MS);
    expect(connect).not.toHaveBeenCalled();
  });

  it("floors a zero restart estimate so the reconnect still queues", async () => {
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "unknown", 0);
    // max(0,1) + 3 = 4s.
    await vi.advanceTimersByTimeAsync(3999);
    expect(connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledWith(AGENT_ID);
  });

  it("claims the updated version only when the agent reports it", async () => {
    connect.mockImplementation(async () => {
      seedAgent({ capabilities: { connectionTypes: [], maxSessions: 1, agentVersion: "1.3.0" } });
    });
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
    await vi.advanceTimersByTimeAsync(8000);
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
    expect(toastMocks.success.mock.calls[0][0]).not.toMatch(/updated version/);

    vi.clearAllMocks();
    connect.mockImplementation(async () => {
      seedAgent({ capabilities: { connectionTypes: [], maxSessions: 1, agentVersion: "1.4.0" } });
    });
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
    await vi.advanceTimersByTimeAsync(8000);
    expect(toastMocks.success.mock.calls[0][0]).toMatch(/updated version/);
  });
});

describe("agent-update reconnect vs. a manual connect (#4311)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    useAppStore.setState(useAppStore.getInitialState());
    seedAgent();
    apiMocks.disconnectAgent.mockResolvedValue(undefined);
    // Keep the real connectRemoteAgent so a manual connect goes through the
    // same action the loop uses; only the suspend disconnect is stubbed.
    useAppStore.setState({ disconnectRemoteAgent: vi.fn().mockResolvedValue(undefined) as never });
  });

  afterEach(() => {
    cancelAllAgentUpdateReconnects();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    apiMocks.connectAgent.mockReset();
  });

  it("a manual connect while waiting between retries wins and stops the loop", async () => {
    apiMocks.connectAgent.mockRejectedValueOnce(new Error("still restarting"));
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
    await vi.advanceTimersByTimeAsync(8000);
    expect(apiMocks.connectAgent).toHaveBeenCalledTimes(1);

    apiMocks.connectAgent.mockResolvedValueOnce({ capabilities: { connectionTypes: [] } });
    await useAppStore.getState().connectRemoteAgent(AGENT_ID);
    expect(apiMocks.connectAgent).toHaveBeenCalledTimes(2);
    expect(isAgentUpdateReconnectActive(AGENT_ID)).toBe(false);
    expect(useAppStore.getState().agentUpdatePending[AGENT_ID]).toBeUndefined();
    expect(toastMocks.dismiss).toHaveBeenCalledWith(`agent-update-pending-${AGENT_ID}`);

    await vi.advanceTimersByTimeAsync(AGENT_UPDATE_RECONNECT_DEADLINE_MS);
    expect(apiMocks.connectAgent).toHaveBeenCalledTimes(2);
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("a late failure of an in-flight automatic attempt is ignored after a manual connect", async () => {
    let rejectAuto: (err: Error) => void = () => {};
    apiMocks.connectAgent.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectAuto = reject;
        })
    );
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
    await vi.advanceTimersByTimeAsync(8000);
    expect(apiMocks.connectAgent).toHaveBeenCalledTimes(1);

    apiMocks.connectAgent.mockResolvedValueOnce({ capabilities: { connectionTypes: [] } });
    await useAppStore.getState().connectRemoteAgent(AGENT_ID);

    rejectAuto(new Error("timed out"));
    await vi.advanceTimersByTimeAsync(AGENT_UPDATE_RECONNECT_DEADLINE_MS);
    expect(apiMocks.connectAgent).toHaveBeenCalledTimes(2);
    expect(toastMocks.error).not.toHaveBeenCalled();
    expect(toastMocks.success).not.toHaveBeenCalled();
  });
});
