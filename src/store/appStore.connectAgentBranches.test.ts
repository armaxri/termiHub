import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Branch-coverage suite (#3027, TFE-005 follow-up) for `connectRemoteAgent`
 * branches the existing agent suites leave dark:
 *
 *  - the password-injection branch (`if (password && config.authMethod ===
 *    "password")`): a supplied password is threaded onto the connect config only
 *    for a password-auth agent — existing tests connect without a password.
 *  - the failure catch: a connect rejection is logged and re-thrown (the caller
 *    owns feedback), and — per the single-writer rule (#1234) — the action writes
 *    NO optimistic `disconnected` state; `connectionState` stays whatever the
 *    backend `agent-state-change` event last wrote.
 */

const { mockConnectAgent } = vi.hoisted(() => ({
  mockConnectAgent: vi.fn(),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return { ...actual, connectAgent: mockConnectAgent };
});

import { useAppStore } from "./appStore";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { currentAgentsView } from "./agentsBridge";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";

const AGENT_ID = "agent-1";
const CAPS = { connectionTypes: [], maxSessions: 5 };

function passwordAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Test Agent",
    config: {
      host: "test.local",
      port: 22,
      username: "user",
      authMethod: "password",
    },
    isExpanded: false,
    // Simulate the backend having already emitted "connecting" (the single writer).
    connectionState: "connecting",
    agentSettings: DEFAULT_AGENT_SETTINGS,
    ...overrides,
  };
}

setupAgentsRegion();

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
});

describe("appStore — connectRemoteAgent password / failure branches", () => {
  it("threads a supplied password onto the connect config for a password-auth agent", async () => {
    seedAgentsRegion({ remoteAgents: [passwordAgent()] });
    mockConnectAgent.mockResolvedValue({
      capabilities: CAPS,
      agentVersion: "1",
      protocolVersion: "1",
    });

    await useAppStore.getState().connectRemoteAgent(AGENT_ID, "s3cret");

    expect(mockConnectAgent).toHaveBeenCalledTimes(1);
    const config = mockConnectAgent.mock.calls[0][1] as { password?: string; authMethod?: string };
    expect(config.password).toBe("s3cret");
    expect(config.authMethod).toBe("password");
  });

  it("does not inject the password for a non-password auth method", async () => {
    seedAgentsRegion({
      remoteAgents: [
        passwordAgent({
          config: { host: "test.local", port: 22, username: "user", authMethod: "agent" },
        }),
      ],
    });
    mockConnectAgent.mockResolvedValue({
      capabilities: CAPS,
      agentVersion: "1",
      protocolVersion: "1",
    });

    await useAppStore.getState().connectRemoteAgent(AGENT_ID, "s3cret");

    const config = mockConnectAgent.mock.calls[0][1] as { password?: string };
    expect(config.password).toBeUndefined();
  });

  it("re-throws a connect failure without writing an optimistic connectionState", async () => {
    seedAgentsRegion({ remoteAgents: [passwordAgent()] });
    mockConnectAgent.mockRejectedValue(new Error("handshake failed"));

    await expect(useAppStore.getState().connectRemoteAgent(AGENT_ID, "s3cret")).rejects.toThrow(
      "handshake failed"
    );

    // Single-writer rule (#1234): the action performs no terminal-state write, so
    // the event-written "connecting" is left for the backend to settle.
    expect(currentAgentsView().remoteAgents[0].connectionState).toBe("connecting");
  });
});
