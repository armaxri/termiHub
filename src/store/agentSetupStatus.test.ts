import { describe, it, expect, beforeEach } from "vitest";
import { setupPhaseAfterStep, useAgentSetupStatus } from "./agentSetupStatus";

describe("agentSetupStatus (#5906)", () => {
  beforeEach(() => useAgentSetupStatus.setState({ phases: {}, tabs: {} }));

  it.each([
    ["connect", "installing"],
    ["upload", "installing"],
    ["install", "installing"],
    ["sent", "installing"],
    ["done", "installed"],
    ["installed", "installed"],
    ["unknown", "unknown"],
    ["failed", null],
    ["error", null],
    ["cancelled", null],
    // A POSIX setup that ended without installing (live product run, #5518).
    ["ended", null],
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

  it.each([
    ["installed", { kind: "installed" }, { a: "installed" }],
    ["failed", { kind: "failed", message: "why" }, {}],
    ["unknown", { kind: "unknown", message: "why" }, { a: "unknown" }],
  ])("a Windows run's '%s' is its tab's and the agent's outcome (#5992)", (step, want, phases) => {
    register("t1", "a", false);
    const s = useAgentSetupStatus.getState();
    s.applyProgress("a", "sent", "Install commands sent");
    expect(progress("t1")).toEqual({ kind: "running" });
    expect(useAgentSetupStatus.getState().phases).toEqual({ a: "installing" });
    s.applyProgress("a", step, "why");
    expect(progress("t1")).toEqual(want);
    expect(useAgentSetupStatus.getState().phases).toEqual(phases);
  });

  it("an earlier run's late outcome reaches neither a newer run's tab nor the row", () => {
    const s = useAgentSetupStatus.getState();
    s.registerSetupTab("t1", {
      agentId: "a",
      agentName: "a",
      sessionId: "s1",
      reportsExit: false,
    });
    s.registerSetupTab("t2", {
      agentId: "a",
      agentName: "a",
      sessionId: "s2",
      reportsExit: false,
    });
    s.markInstalling("a");
    s.applyProgress("a", "installed", "Agent installed", "s1");
    expect(progress("t1")).toEqual({ kind: "installed" });
    expect(progress("t2")).toEqual({ kind: "running" });
    expect(useAgentSetupStatus.getState().phases).toEqual({ a: "installing" });
    s.applyProgress("a", "failed", "no", "s2");
    expect(progress("t2")).toEqual({ kind: "failed", message: "no" });
    expect(useAgentSetupStatus.getState().phases).toEqual({});
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
