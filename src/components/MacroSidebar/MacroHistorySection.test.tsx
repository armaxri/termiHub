import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MacroHistorySection } from "./MacroHistorySection";
import { withTooltip } from "@/test/tooltip";
import { useAppStore } from "@/store/appStore";
import type { MacroRun } from "@/types/macro";

function run(overrides: Partial<MacroRun> = {}): MacroRun {
  return {
    id: "run-1",
    macroId: "m1",
    macroName: "Deploy",
    startedAt: "2026-09-20T00:00:00Z",
    endedAt: "2026-09-20T00:00:03Z",
    status: "completed",
    stepsPlayed: 2,
    totalSteps: 2,
    targetCount: 1,
    targetLabels: ["prod-1"],
    origin: "manual",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let loadMacroRuns: ReturnType<typeof vi.fn<() => Promise<void>>>;
let clearMacroRunHistory: ReturnType<typeof vi.fn<() => Promise<void>>>;
let onShowAll: ReturnType<typeof vi.fn<() => void>>;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render(runs: MacroRun[], macroId: string | null = null) {
  useAppStore.setState({ macroRuns: runs, loadMacroRuns, clearMacroRunHistory });
  act(() => {
    root.render(withTooltip(<MacroHistorySection macroId={macroId} onShowAll={onShowAll} />));
  });
}

describe("MacroHistorySection (#3543)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    loadMacroRuns = vi.fn<() => Promise<void>>(() => Promise.resolve());
    clearMacroRunHistory = vi.fn<() => Promise<void>>(() => Promise.resolve());
    onShowAll = vi.fn<() => void>();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  it("loads the run history on mount", () => {
    render([]);
    expect(loadMacroRuns).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state and disables Clear with no runs", () => {
    render([]);
    expect(query("macro-history-empty")!.textContent).toContain("No playbacks recorded yet");
    expect((query("macro-history-clear") as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists each run with outcome, progress, origin and target", () => {
    render([
      run(),
      run({
        id: "run-2",
        status: "error",
        stepsPlayed: 1,
        origin: "scheduled",
        targetCount: 3,
        targetLabels: ["a", "b", "c"],
        error: "1 of 3 terminals stopped receiving input",
      }),
    ]);

    const first = query("macro-run-run-1")!;
    expect(first.textContent).toContain("Deploy");
    expect(first.textContent).toContain("2/2");
    expect(first.textContent).toContain("manual");
    expect(first.textContent).toContain("3s");
    expect(query("macro-run-targets-run-1")!.textContent).toContain("prod-1");

    const second = query("macro-run-run-2")!;
    expect(second.textContent).toContain("1/2");
    expect(second.textContent).toContain("scheduled");
    expect(second.querySelector('[aria-label="Target disconnected"]')).not.toBeNull();
    expect(query("macro-run-targets-run-2")!.textContent).toContain("3 terminals");
    expect(query("macro-run-targets-run-2")!.getAttribute("title")).toBe("a\nb\nc");
    expect(query("macro-run-error-run-2")!.textContent).toBe(
      "1 of 3 terminals stopped receiving input"
    );
  });

  it("labels a workflow-step origin readably", () => {
    render([run({ origin: "workflow-step" })]);
    expect(query("macro-run-run-1")!.textContent).toContain("workflow step");
  });

  it("narrows to one macro and offers to show all again", () => {
    render([run(), run({ id: "run-other", macroId: "m2", macroName: "Other" })], "m1");

    expect(query("macro-run-run-1")).not.toBeNull();
    expect(query("macro-run-run-other")).toBeNull();
    expect(query("macro-history-filter")!.textContent).toContain("Deploy");

    act(() => query("macro-history-show-all")!.click());
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });

  it("says when the filtered macro has no runs", () => {
    render([run({ macroId: "m2" })], "m1");
    expect(query("macro-history-empty")!.textContent).toContain("not been played yet");
  });

  it("clears the history", async () => {
    render([run()]);
    await act(async () => {
      query("macro-history-clear")!.click();
    });
    expect(clearMacroRunHistory).toHaveBeenCalledTimes(1);
  });
});
