import { describe, it, expect, beforeEach } from "vitest";
import { setupPhaseAfterStep, useAgentSetupStatus } from "./agentSetupStatus";

describe("agentSetupStatus (#5906)", () => {
  beforeEach(() => useAgentSetupStatus.setState({ phases: {}, tabs: {} }));

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

describe("agentSetupStatus setup tabs (#5865)", () => {
  beforeEach(() => useAgentSetupStatus.setState({ phases: {}, tabs: {} }));

  const register = (tabId: string, agentId: string, reportsExit = true) =>
    useAgentSetupStatus
      .getState()
      .registerSetupTab(tabId, { agentId, agentName: agentId, reportsExit });
  const progress = (tabId: string) => useAgentSetupStatus.getState().tabs[tabId]?.progress;

  it("a registered tab runs until an event says otherwise", () => {
    register("t1", "a");
    expect(progress("t1")).toEqual({ kind: "running" });
    useAgentSetupStatus.getState().applyProgress("a", "upload", "Uploading…");
    expect(progress("t1")).toEqual({ kind: "running" });
  });

  it("a POSIX run stays running on 'done': the script's exit tells the outcome", () => {
    register("t1", "a");
    useAgentSetupStatus.getState().applyProgress("a", "done", "Setup script started in terminal");
    expect(progress("t1")).toEqual({ kind: "running" });
  });

  it("a Windows run is 'sent' on 'done'", () => {
    register("t1", "a", false);
    useAgentSetupStatus.getState().applyProgress("a", "done", "Setup commands sent to terminal");
    expect(progress("t1")).toEqual({ kind: "sent" });
  });

  it("an error or a cancel ends the run, and a repeated or late event changes nothing", () => {
    register("t1", "a");
    register("t2", "b");
    const s = useAgentSetupStatus.getState();
    s.applyProgress("a", "error", "SFTP connection failed");
    s.applyProgress("b", "cancelled", "Setup cancelled");
    const after = useAgentSetupStatus.getState().tabs;
    expect(progress("t1")).toEqual({ kind: "failed", message: "SFTP connection failed" });
    expect(progress("t2")).toEqual({ kind: "cancelled" });
    // The dialog and the app-wide listener both fold each event.
    s.applyProgress("a", "error", "SFTP connection failed");
    s.applyProgress("b", "done", "late");
    expect(useAgentSetupStatus.getState().tabs).toBe(after);
  });

  it("only the agent's own tabs move", () => {
    register("t1", "a");
    register("t2", "b");
    useAgentSetupStatus.getState().applyProgress("a", "error", "boom");
    expect(progress("t2")).toEqual({ kind: "running" });
  });

  it("dismissing hides the tab's strip once", () => {
    register("t1", "a");
    const s = useAgentSetupStatus.getState();
    s.dismissSetupTab("t1");
    expect(useAgentSetupStatus.getState().tabs.t1.dismissed).toBe(true);
    const after = useAgentSetupStatus.getState().tabs;
    s.dismissSetupTab("t1");
    s.dismissSetupTab("unknown");
    expect(useAgentSetupStatus.getState().tabs).toBe(after);
  });
});
