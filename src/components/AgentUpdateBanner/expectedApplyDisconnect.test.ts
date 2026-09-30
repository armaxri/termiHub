import { afterEach, describe, expect, it } from "vitest";

import {
  EMPTY_AGENTS_VIEW,
  setAgentsViewForTest,
  stopAgentsSubscription,
} from "@/store/agentsBridge";
import type { AgentsView } from "@/store/agentsBridge";
import type { RemoteAgentDefinition } from "@/types/connection";

import { awaitExpectedApplyDisconnect, isExpectedApplyDisconnect } from "./expectedApplyDisconnect";

const AGENT_ID = "agent-1";

/** Build an `AgentsView` holding a single agent in the given connection state. */
function viewWithAgent(connectionState: string): AgentsView {
  return {
    ...EMPTY_AGENTS_VIEW,
    remoteAgents: [{ id: AGENT_ID, connectionState }] as unknown as RemoteAgentDefinition[],
  };
}

describe("awaitExpectedApplyDisconnect", () => {
  afterEach(() => {
    // Reset the shared region fan-out state between cases.
    stopAgentsSubscription();
  });

  it("resolves true immediately when the agent is already non-connected (drop already folded)", async () => {
    setAgentsViewForTest(viewWithAgent("disconnected"));
    await expect(awaitExpectedApplyDisconnect(AGENT_ID, 1000)).resolves.toBe(true);
  });

  it("resolves true when the transport drops within the window", async () => {
    setAgentsViewForTest(viewWithAgent("connected"));
    const pending = awaitExpectedApplyDisconnect(AGENT_ID, 1000);
    // The backend folds the drop into the region a moment later.
    setAgentsViewForTest(viewWithAgent("reconnecting"));
    await expect(pending).resolves.toBe(true);
  });

  it("resolves false when the agent stays connected for the whole window (real failure)", async () => {
    setAgentsViewForTest(viewWithAgent("connected"));
    // Short window so the test does not wait the production duration.
    await expect(awaitExpectedApplyDisconnect(AGENT_ID, 15)).resolves.toBe(false);
  });

  it("resolves false when the agent is not tracked (no positive evidence of a drop)", async () => {
    setAgentsViewForTest(EMPTY_AGENTS_VIEW);
    await expect(awaitExpectedApplyDisconnect(AGENT_ID, 15)).resolves.toBe(false);
  });

  it("classifies from connection state alone, independent of any error message/locale", async () => {
    // The helper takes no error text — a drop under a non-English transport locale
    // is detected exactly like an English one, purely from `connectionState`.
    setAgentsViewForTest(viewWithAgent("connected"));
    const pending = awaitExpectedApplyDisconnect(AGENT_ID, 1000);
    setAgentsViewForTest(viewWithAgent("disconnected"));
    await expect(pending).resolves.toBe(true);
  });
});

describe("isExpectedApplyDisconnect (#2840: structured close signal first)", () => {
  afterEach(() => {
    stopAgentsSubscription();
  });

  const transportClosed = {
    code: "agent_transport_closed",
    message: "Remote agent error: Agent connection lost",
    details: null,
  };
  const agentReported = {
    code: "remote_error",
    message: "Remote agent error: update refused — connection closed by policy",
    details: null,
  };

  it("resolves true from a structured transport-close even while the region still reads connected", async () => {
    // The drop event has not been folded yet; the typed code alone decides.
    setAgentsViewForTest(viewWithAgent("connected"));
    await expect(isExpectedApplyDisconnect(AGENT_ID, transportClosed, 15)).resolves.toBe(true);
  });

  it("resolves true from the transport-close code under any message wording/locale", async () => {
    setAgentsViewForTest(viewWithAgent("connected"));
    const localized = { ...transportClosed, message: "Verbindung getrennt" };
    await expect(isExpectedApplyDisconnect(AGENT_ID, localized, 15)).resolves.toBe(true);
  });

  it("resolves false for a structured agent-reported error while the connection stays up", async () => {
    // Its text mentions a closed connection, but the code is an application error.
    setAgentsViewForTest(viewWithAgent("connected"));
    await expect(isExpectedApplyDisconnect(AGENT_ID, agentReported, 15)).resolves.toBe(false);
  });

  it("fails fast on an agent-reported error without waiting out the window (#3959)", async () => {
    // The agent answered with an error, so the apply did not happen: resolve false
    // at once, even if the region reports a drop moments later.
    setAgentsViewForTest(viewWithAgent("connected"));
    let settled: boolean | undefined;
    const pending = isExpectedApplyDisconnect(AGENT_ID, agentReported, 60_000).then((v) => {
      settled = v;
      return v;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    setAgentsViewForTest(viewWithAgent("reconnecting"));
    await expect(pending).resolves.toBe(false);
  });

  it("confirms an agent timeout through the connection-state window (#3959)", async () => {
    // No reply is not a refusal: the swap may have raced the reply, so the region
    // decides. A drop within the window counts as the expected disconnect...
    const timedOut = {
      code: "agent_timeout",
      message: "Remote agent error: Agent request timed out after 60s",
      details: null,
    };
    setAgentsViewForTest(viewWithAgent("connected"));
    const pending = isExpectedApplyDisconnect(AGENT_ID, timedOut, 1000);
    setAgentsViewForTest(viewWithAgent("reconnecting"));
    await expect(pending).resolves.toBe(true);

    // ...and a connection that stays up surfaces it as a real failure.
    setAgentsViewForTest(viewWithAgent("connected"));
    await expect(isExpectedApplyDisconnect(AGENT_ID, timedOut, 15)).resolves.toBe(false);
  });

  it("falls back to the connection-state window for a non-transport-close error", async () => {
    // e.g. a timeout / legacy error that raced the drop: confirmed by the region.
    setAgentsViewForTest(viewWithAgent("connected"));
    const pending = isExpectedApplyDisconnect(AGENT_ID, new Error("Agent request timed out"), 1000);
    setAgentsViewForTest(viewWithAgent("reconnecting"));
    await expect(pending).resolves.toBe(true);
  });

  it("does not read a legacy plain-text error as a transport close", async () => {
    setAgentsViewForTest(viewWithAgent("connected"));
    await expect(
      isExpectedApplyDisconnect(AGENT_ID, "agent_transport_closed: Agent connection lost", 15)
    ).resolves.toBe(false);
  });
});
