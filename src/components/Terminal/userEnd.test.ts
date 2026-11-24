import { afterEach, describe, expect, it } from "vitest";
import {
  clearAgentDisconnectIntent,
  markAgentDisconnectIntent,
} from "@/store/agentDisconnectIntent";
import { useAppStore } from "@/store/appStore";
import { ensureSessionSubscribed } from "@/store/sessionBridge";
import {
  connected,
  disconnected,
  flushSessionRegion,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";
import { sessionEndedByUser } from "./userEnd";

const harness = installSessionLifecycleHarness();

afterEach(() => {
  clearAgentDisconnectIntent("agent-1");
  useAppStore.setState(useAppStore.getInitialState());
});

describe("sessionEndedByUser (#5959)", () => {
  it("is true once the backend folded the tab's user end", async () => {
    ensureSessionSubscribed();
    harness.transport.setSession("tab-user", disconnected("user"));
    harness.transport.setSession("tab-lost", disconnected("unexpected"));
    harness.transport.setSession("tab-live", connected());
    await flushSessionRegion();

    expect(sessionEndedByUser("tab-user")).toBe(true);
    expect(sessionEndedByUser("tab-lost")).toBe(false);
    expect(sessionEndedByUser("tab-live")).toBe(false);
    expect(sessionEndedByUser("tab-unknown")).toBe(false);
  });

  it("is true while this window's user is disconnecting the tab's agent", () => {
    markAgentDisconnectIntent("agent-1");
    expect(sessionEndedByUser("tab-a", "agent-1")).toBe(true);
    expect(sessionEndedByUser("tab-a", "agent-2")).toBe(false);
    expect(sessionEndedByUser("tab-a")).toBe(false);
  });

  it("is true once the agent's disconnect ended the tab here", () => {
    useAppStore.setState({ terminalAgentDisconnected: { "tab-a": true } });
    expect(sessionEndedByUser("tab-a")).toBe(true);
  });
});
