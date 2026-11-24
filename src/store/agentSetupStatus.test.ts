import { describe, it, expect, beforeEach } from "vitest";
import { setupPhaseAfterStep, useAgentSetupStatus } from "./agentSetupStatus";

describe("agentSetupStatus (#5906)", () => {
  beforeEach(() => useAgentSetupStatus.setState({ phases: {} }));

  it.each([
    ["connect", "installing"],
    ["upload", "installing"],
    ["install", "installing"],
    ["done", "installed"],
    ["error", null],
    ["cancelled", null],
  ])("step %s leaves the agent %s", (step, phase) => {
    expect(setupPhaseAfterStep(step)).toBe(phase);
  });

  it("tracks one agent's setup from start to success", () => {
    const s = useAgentSetupStatus.getState();
    s.markInstalling("a");
    expect(useAgentSetupStatus.getState().phases).toEqual({ a: "installing" });
    s.applyProgress("a", "upload");
    expect(useAgentSetupStatus.getState().phases).toEqual({ a: "installing" });
    s.applyProgress("a", "done");
    expect(useAgentSetupStatus.getState().phases).toEqual({ a: "installed" });
  });

  it("drops the agent on a failed or cancelled setup and on clear", () => {
    const s = useAgentSetupStatus.getState();
    s.markInstalling("a");
    s.markInstalling("b");
    s.applyProgress("a", "error");
    s.applyProgress("b", "cancelled");
    expect(useAgentSetupStatus.getState().phases).toEqual({});
    s.applyProgress("c", "done");
    s.clear("c");
    expect(useAgentSetupStatus.getState().phases).toEqual({});
  });

  it("keeps the same map when nothing changes", () => {
    const s = useAgentSetupStatus.getState();
    s.markInstalling("a");
    const before = useAgentSetupStatus.getState().phases;
    s.markInstalling("a");
    s.clear("zzz");
    expect(useAgentSetupStatus.getState().phases).toBe(before);
  });
});
