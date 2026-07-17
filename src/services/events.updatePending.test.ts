import { describe, it, expect, vi, beforeEach } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { onRemoteAgentUpdatePending } from "./events";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const mockedListen = vi.mocked(listen);

describe("onRemoteAgentUpdatePending (#1602)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers a listener on the remote-agent-update-pending event", async () => {
    const unlisten = vi.fn();
    mockedListen.mockResolvedValue(unlisten);

    const result = await onRemoteAgentUpdatePending(vi.fn());

    expect(mockedListen).toHaveBeenCalledWith("remote-agent-update-pending", expect.any(Function));
    expect(result).toBe(unlisten);
  });

  it("maps the snake_case agent id and camelCase payload fields", async () => {
    let captured: ((event: unknown) => void) | undefined;
    mockedListen.mockImplementation((_event, handler) => {
      captured = handler as (event: unknown) => void;
      return Promise.resolve(vi.fn());
    });

    const callback = vi.fn();
    await onRemoteAgentUpdatePending(callback);

    captured!({
      payload: {
        agent_id: "agent-7",
        requestedByVersion: "1.4.0",
        estimatedRestartSecs: 5,
      },
    });

    expect(callback).toHaveBeenCalledWith({
      agentId: "agent-7",
      requestedByVersion: "1.4.0",
      estimatedRestartSecs: 5,
    });
  });
});
