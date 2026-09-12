import { afterEach, describe, expect, it } from "vitest";

import {
  EMPTY_AGENTS_VIEW,
  setAgentsViewForTest,
  stopAgentsSubscription,
} from "@/store/agentsBridge";
import type { AgentsView } from "@/store/agentsBridge";
import type { RemoteAgentDefinition } from "@/types/connection";

import { awaitExpectedApplyDisconnect } from "./expectedApplyDisconnect";

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
