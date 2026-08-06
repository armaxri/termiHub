import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAppStore } from "@/store/appStore";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import type { RemoteAgentDefinition } from "@/types/connection";

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

const AGENT_ID = "agent-1";

function seedAgent(): void {
  const agent = {
    id: AGENT_ID,
    name: "prod-box",
    config: { host: "h", port: 22, username: "u", authMethod: "key" },
  } as unknown as RemoteAgentDefinition;
  seedAgentsRegion({ remoteAgents: [agent] });
}

setupAgentsRegion();

describe("handleAgentUpdatePending (coordinated-update notice, #1602)", () => {
  let disconnect: ReturnType<typeof vi.fn>;
  let connect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(useAppStore.getInitialState());
    seedAgent();
    // Isolate the orchestration from the real connect/disconnect (which hit the
    // Tauri API) by overriding them with spies on the store instance.
    disconnect = vi.fn().mockResolvedValue(undefined);
    connect = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      disconnectRemoteAgent: disconnect as unknown as (agentId: string) => Promise<void>,
      connectRemoteAgent: connect as unknown as (
        agentId: string,
        password?: string
      ) => Promise<void>,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("records the pending notice, suspends the connection, and shows the notice", () => {
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);

    const pending = useAppStore.getState().agentUpdatePending[AGENT_ID];
    expect(pending).toBeDefined();
    expect(pending.requestedByVersion).toBe("1.4.0");
    expect(pending.estimatedRestartSecs).toBe(5);

    // Disconnecting is the ack the updating host waits for.
    expect(disconnect).toHaveBeenCalledWith(AGENT_ID);
    // A loading toast surfaces the in-progress suspend.
    expect(toastMocks.loading).toHaveBeenCalledTimes(1);
    // The reconnect has not fired yet.
    expect(connect).not.toHaveBeenCalled();
  });

  it("queues an auto-reconnect after the restart window (estimate + buffer)", async () => {
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);

    // estimate 5s + 3s buffer = 8s. Just before the window, nothing reconnects.
    await vi.advanceTimersByTimeAsync(7000);
    expect(connect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledWith(AGENT_ID);
    // The notice clears once the reconnect is initiated.
    expect(useAppStore.getState().agentUpdatePending[AGENT_ID]).toBeUndefined();
  });

  it("resolves the notice to success once the reconnect settles", async () => {
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
    await vi.advanceTimersByTimeAsync(8000);
    // Let the connect promise resolve.
    await vi.runAllTimersAsync();
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
  });

  it("reports an error toast when the reconnect fails", async () => {
    connect.mockRejectedValueOnce(new Error("host down"));
    useAppStore.getState().handleAgentUpdatePending(AGENT_ID, "1.4.0", 5);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.runAllTimersAsync();
    expect(toastMocks.error).toHaveBeenCalledTimes(1);
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
    await vi.advanceTimersByTimeAsync(8000);
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
});
