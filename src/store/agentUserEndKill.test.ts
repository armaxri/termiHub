import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * #5959: a user agent Disconnect / Shutdown ends the agent's tabs on purpose.
 * Their sessions' exits must read as the user's end, not as a lost link, so the
 * action tags each hosted tab's session as intentionally killed before it asks
 * the backend — exactly as a single tab's Disconnect does.
 */

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  disconnectAgent: vi.fn(() => Promise.resolve()),
  shutdownAgent: vi.fn(() => Promise.resolve(1)),
}));

import { disconnectAgent } from "@/services/api";
import { useAppStore } from "./appStore";

const AGENT_ID = "agent-user-end";

function addTab(agentId: string, sessionId: string): string {
  return useAppStore
    .getState()
    .addTab(
      "Agent Shell",
      "remote-session",
      { type: "remote-session", config: { agentId, sessionType: "shell" } },
      { contentType: "terminal", sessionId }
    );
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.mocked(disconnectAgent).mockClear();
});

describe("user agent end tags the hosted sessions as killed (#5959)", () => {
  it("Disconnect tags only this agent's live tab sessions", async () => {
    addTab(AGENT_ID, "S1");
    addTab("other-agent", "S2");

    await useAppStore.getState().disconnectRemoteAgent(AGENT_ID);

    const store = useAppStore.getState();
    expect(store.consumeSessionKilled("S1")).toBe(true);
    expect(store.consumeSessionKilled("S2")).toBe(false);
  });

  it("Shutdown tags them too", async () => {
    addTab(AGENT_ID, "S1");
    await useAppStore.getState().shutdownRemoteAgent(AGENT_ID);
    expect(useAppStore.getState().consumeSessionKilled("S1")).toBe(true);
  });

  it("a suspend (endHostedSessions: false) keeps the sessions resumable", async () => {
    addTab(AGENT_ID, "S1");
    await useAppStore.getState().disconnectRemoteAgent(AGENT_ID, { endHostedSessions: false });
    expect(useAppStore.getState().consumeSessionKilled("S1")).toBe(false);
  });

  it("a failed Disconnect clears the tags again", async () => {
    addTab(AGENT_ID, "S1");
    vi.mocked(disconnectAgent).mockRejectedValueOnce(new Error("hung"));
    await expect(useAppStore.getState().disconnectRemoteAgent(AGENT_ID)).rejects.toThrow("hung");
    expect(useAppStore.getState().consumeSessionKilled("S1")).toBe(false);
  });
});
