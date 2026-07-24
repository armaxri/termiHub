import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  matchHotkeyWorkflow,
  matchOnConnectWorkflows,
  dispatchOnConnectTriggers,
  forgetOnConnectSession,
  resetOnConnectDispatchState,
} from "@/services/workflowTriggers";
import type { Workflow, WorkflowTrigger } from "@/types/workflow";

function makeKeyEvent(
  key: string,
  mods: { ctrl?: boolean; shift?: boolean; meta?: boolean; alt?: boolean } = {}
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false,
  });
}

function makeWorkflow(id: string, triggers: WorkflowTrigger[]): Workflow {
  return {
    id,
    name: `Workflow ${id}`,
    tags: [],
    steps: [{ kind: "send-command", command: "echo hi" }],
    triggers,
    createdAt: "2026-07-24T00:00:00Z",
    updatedAt: "2026-07-24T00:00:00Z",
  };
}

describe("matchHotkeyWorkflow", () => {
  it("returns the workflow whose hotkey binding matches the event", () => {
    const workflows = [
      makeWorkflow("a", [{ kind: "hotkey", binding: "Ctrl+Alt+H" }]),
      makeWorkflow("b", [{ kind: "manual" }]),
    ];
    const event = makeKeyEvent("h", { ctrl: true, alt: true });
    expect(matchHotkeyWorkflow(event, workflows)).toBe("a");
  });

  it("returns null when no hotkey trigger matches the event", () => {
    const workflows = [makeWorkflow("a", [{ kind: "hotkey", binding: "Ctrl+Alt+H" }])];
    const event = makeKeyEvent("j", { ctrl: true, alt: true });
    expect(matchHotkeyWorkflow(event, workflows)).toBeNull();
  });

  it("ignores non-hotkey triggers", () => {
    const workflows = [
      makeWorkflow("a", [{ kind: "manual" }, { kind: "on-connect", connectionIds: ["c1"] }]),
    ];
    const event = makeKeyEvent("h", { ctrl: true, alt: true });
    expect(matchHotkeyWorkflow(event, workflows)).toBeNull();
  });

  it("skips workflows with an empty or unbound hotkey binding", () => {
    const workflows = [
      makeWorkflow("a", [{ kind: "hotkey", binding: "" }]),
      makeWorkflow("b", [{ kind: "hotkey", binding: "   " }]),
    ];
    const event = makeKeyEvent("", {});
    expect(matchHotkeyWorkflow(event, workflows)).toBeNull();
  });

  it("returns the first matching workflow when several share a binding", () => {
    const workflows = [
      makeWorkflow("first", [{ kind: "hotkey", binding: "Ctrl+Alt+H" }]),
      makeWorkflow("second", [{ kind: "hotkey", binding: "Ctrl+Alt+H" }]),
    ];
    const event = makeKeyEvent("h", { ctrl: true, alt: true });
    expect(matchHotkeyWorkflow(event, workflows)).toBe("first");
  });
});

describe("matchOnConnectWorkflows", () => {
  it("returns workflows bound to the given connection id and not others", () => {
    const workflows = [
      makeWorkflow("a", [{ kind: "on-connect", connectionIds: ["c1", "c2"] }]),
      makeWorkflow("b", [{ kind: "on-connect", connectionIds: ["c3"] }]),
      makeWorkflow("c", [{ kind: "manual" }]),
    ];
    expect(matchOnConnectWorkflows("c1", workflows).map((w) => w.id)).toEqual(["a"]);
    expect(matchOnConnectWorkflows("c3", workflows).map((w) => w.id)).toEqual(["b"]);
    expect(matchOnConnectWorkflows("c9", workflows)).toEqual([]);
  });
});

describe("dispatchOnConnectTriggers", () => {
  beforeEach(() => {
    resetOnConnectDispatchState();
  });

  it("runs each matching workflow against the freshly opened tab", () => {
    const workflows = [
      makeWorkflow("a", [{ kind: "on-connect", connectionIds: ["c1"] }]),
      makeWorkflow("b", [{ kind: "on-connect", connectionIds: ["c1"] }]),
      makeWorkflow("c", [{ kind: "on-connect", connectionIds: ["c2"] }]),
    ];
    const run = vi.fn();
    dispatchOnConnectTriggers({
      connectionId: "c1",
      tabId: "tab-1",
      sessionId: "sess-1",
      workflows,
      run,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith("a", "tab-1");
    expect(run).toHaveBeenCalledWith("b", "tab-1");
  });

  it("does not run when no workflow is bound to the connection", () => {
    const run = vi.fn();
    dispatchOnConnectTriggers({
      connectionId: "c9",
      tabId: "tab-1",
      sessionId: "sess-1",
      workflows: [makeWorkflow("a", [{ kind: "on-connect", connectionIds: ["c1"] }])],
      run,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("fires at most once per session open", () => {
    const workflows = [makeWorkflow("a", [{ kind: "on-connect", connectionIds: ["c1"] }])];
    const run = vi.fn();
    const args = {
      connectionId: "c1",
      tabId: "tab-1",
      sessionId: "sess-1",
      workflows,
      run,
    };
    dispatchOnConnectTriggers(args);
    dispatchOnConnectTriggers(args);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fires again for a different session open of the same connection", () => {
    const workflows = [makeWorkflow("a", [{ kind: "on-connect", connectionIds: ["c1"] }])];
    const run = vi.fn();
    dispatchOnConnectTriggers({
      connectionId: "c1",
      tabId: "tab-1",
      sessionId: "sess-1",
      workflows,
      run,
    });
    dispatchOnConnectTriggers({
      connectionId: "c1",
      tabId: "tab-2",
      sessionId: "sess-2",
      workflows,
      run,
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fires again after the session's dispatch record is forgotten", () => {
    const workflows = [makeWorkflow("a", [{ kind: "on-connect", connectionIds: ["c1"] }])];
    const run = vi.fn();
    const args = {
      connectionId: "c1",
      tabId: "tab-1",
      sessionId: "sess-1",
      workflows,
      run,
    };
    dispatchOnConnectTriggers(args);
    forgetOnConnectSession("sess-1");
    dispatchOnConnectTriggers(args);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
