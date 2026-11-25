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
    runsReplacedBy(useAppStore.getState(), typesKeys).map((run) => run.name);

  it("are those of its own kind", () => {
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
    expect([replaced(true), replaced(false)]).toEqual([["Login"], ["Deploy"]]);
    useAppStore.setState({ macroPlayback: { ...playback, targetTabIds: ["a", "b"] } });
    expect(replaced(true)).toEqual(["Login", "Login"]);
  });
});

describe("the question before one is stopped", () => {
  it("has no answer to take when nothing is asked", () => {
    useAppStore.getState().resolveRunReplacePrompt(true);
    expect(useAppStore.getState().runReplacePrompt).toBeNull();
  });
});
