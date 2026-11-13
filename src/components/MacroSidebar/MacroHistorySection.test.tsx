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
    expect(query("macro-history-filter")).toBeNull();
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
    // A full playback shows no redundant "2/2" (#5519).
    expect(first.textContent).not.toContain("2/2");
    expect(first.textContent).toContain("manual");
    expect(first.textContent).toContain("3s");
    expect(query("macro-run-targets-run-1")!.textContent).toContain("prod-1");

    const second = query("macro-run-run-2")!;
    // A partial playback notes how far it got, in the metadata after the name.
    expect(query("macro-run-progress-run-2")!.textContent).toContain("1/2 steps");
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

  it("shows the filter as a removable chip apart from the header actions (#5636)", () => {
    render([run()], "m1");
    const chip = query("macro-history-filter")!;
    const header = query("macro-history")!.querySelector(".sidebar-section-header")!;
    // The chip lives on its own row, not beside the destructive Clear action.
    expect(header.contains(chip)).toBe(false);
    expect(header.contains(query("macro-history-show-all"))).toBe(false);
    expect(chip.contains(query("macro-history-show-all"))).toBe(true);
    expect(query("macro-history-show-all")!.getAttribute("aria-label")).toBe(
      "Clear filter: Deploy"
    );
  });

  it("labels the Clear history action with visible text (#5636)", () => {
    render([run()]);
    const clear = query("macro-history-clear")!;
    expect(clear.textContent).toContain("Clear");
    expect(clear.getAttribute("aria-label")).toBe("Clear history");
  });

  it("says when the filtered macro has no runs", () => {
    render([run({ macroId: "m2" })], "m1");
    expect(query("macro-history-empty")!.textContent).toContain("not been played yet");
  });

  it("asks for confirmation before clearing the history (#5636)", async () => {
    render([run()]);
    await act(async () => {
      query("macro-history-clear")!.click();
    });
    expect(clearMacroRunHistory).not.toHaveBeenCalled();
    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="macro-history-clear-confirm-confirm"]'
    );
    expect(confirm).not.toBeNull();
    await act(async () => {
      confirm!.click();
    });
    expect(clearMacroRunHistory).toHaveBeenCalledTimes(1);
  });

  it("keeps the history when the confirmation is cancelled (#5636)", async () => {
    render([run()]);
    await act(async () => {
      query("macro-history-clear")!.click();
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="macro-history-clear-confirm-cancel"]')!
        .click();
    });
    expect(clearMacroRunHistory).not.toHaveBeenCalled();
  });
});
