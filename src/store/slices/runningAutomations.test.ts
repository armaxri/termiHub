import { afterEach, describe, expect, it } from "vitest";
import { useAppStore } from "../appStore";
import { setWorkflowRunViewForTest } from "../workflowRunBridge";
import { runsReplacedBy } from "./runningAutomations";

describe("the runs a new one would stop (#6042)", () => {
  afterEach(() => {
    setWorkflowRunViewForTest({ run: null, output: null });
    useAppStore.setState(useAppStore.getInitialState());
  });
  const replaced = (typesKeys: boolean) =>
    runsReplacedBy(useAppStore.getState(), typesKeys, []).map((run) => run.name);

  it("are those that type keys, wherever they type; step-by-step ones only in its terminals", () => {
    expect([replaced(true), replaced(false)]).toEqual([[], []]);
    setWorkflowRunViewForTest({
      run: {
        runId: "r",
        workflowId: "w",
        workflowName: "Deploy",
        tabId: "gone",
        total: 2,
        completed: 0,
      },
      output: null,
    });
    const playback = { macroId: "m", macroName: "Login", tabId: "a", total: 2, played: 1 };
    useAppStore.setState({ macroPlayback: playback });
    // Step by step on another terminal runs side by side (#6042).
    expect([replaced(true), replaced(false)]).toEqual([["Login"], []]);
    expect(runsReplacedBy(useAppStore.getState(), false, ["gone"]).map((run) => run.name)).toEqual([
      "Deploy",
    ]);
    useAppStore.setState({ macroPlayback: { ...playback, targetTabIds: ["a", "b"] } });
    expect(replaced(true)).toEqual(["Login", "Login"]);
  });

  it("and those of the other kind in the same terminals (#6042)", () => {
    setWorkflowRunViewForTest({
      run: {
        runId: "r",
        workflowId: "w",
        workflowName: "Deploy",
        tabId: "a",
        total: 2,
        completed: 0,
      },
      output: null,
    });
    const playback = { macroId: "m", macroName: "Login", tabId: "b", total: 2, played: 1 };
    useAppStore.setState({ macroPlayback: playback });
    const state = useAppStore.getState();
    const names = (typesKeys: boolean, targets: string[]) =>
      runsReplacedBy(state, typesKeys, targets).map((r) => [r.name, r.tabId, r.runId ?? null]);
    expect(names(true, ["a"])).toEqual([
      ["Login", "b", null],
      ["Deploy", "a", "r"],
    ]);
    expect(names(true, ["c"])).toEqual([["Login", "b", null]]);
    // Step by step: the other step-by-step one only in its terminals (#6042).
    expect(names(false, ["b", "c"])).toEqual([["Login", "b", null]]);
    expect(names(false, ["a", "b"])).toEqual([
      ["Deploy", "a", "r"],
      ["Login", "b", null],
    ]);
  });
});

describe("the question before one is stopped", () => {
  it("has no answer to take when nothing is asked", () => {
    useAppStore.getState().resolveRunReplacePrompt(true);
    expect(useAppStore.getState().runReplacePrompt).toBeNull();
  });
});
