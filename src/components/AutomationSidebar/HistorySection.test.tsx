import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { HistorySection } from "./HistorySection";
import { withTooltip } from "@/test/tooltip";
import { checkA11y } from "@/test/axe";
import { useAppStore } from "@/store/appStore";
import type { AutomationRun } from "@/types/generated/AutomationRun";

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run-1",
    automationId: "a1",
    automationName: "Deploy",
    startedAt: "2026-09-20T00:00:00Z",
    endedAt: "2026-09-20T00:00:03Z",
    status: "completed",
    stepsCompleted: 3,
    total: 3,
    targetLabel: "prod-1",
    origin: "manual",
    ...overrides,
  };
}

const RUNS: AutomationRun[] = [
  run(),
  run({
    id: "run-2",
    automationId: "a2",
    automationName: "Rotate logs",
    status: "failed",
    stepsCompleted: 2,
    total: 5,
    failedStepIndex: 2,
    error: "timed out",
    origin: "scheduled",
    targetLabel: "db-1",
  }),
  run({
    id: "run-3",
    automationId: "a3",
    automationName: "Sudo password",
    status: "cancelled",
    stepsCompleted: 0,
    total: 1,
    origin: "palette",
    targetLabel: undefined,
    targetCount: 2,
    targetLabels: ["web-1", "web-2"],
  }),
];

let container: HTMLDivElement;
let root: Root;
let loadAutomationRuns: ReturnType<typeof vi.fn<() => Promise<void>>>;
let clearAutomationRuns: ReturnType<typeof vi.fn<(ids?: string[]) => Promise<void>>>;
let onFilterChange: ReturnType<typeof vi.fn<(id: string | null) => void>>;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function render(runs: AutomationRun[], automationId: string | null = null) {
  useAppStore.setState({ automationRuns: runs, loadAutomationRuns, clearAutomationRuns });
  act(() => {
    root.render(
      withTooltip(<HistorySection automationId={automationId} onFilterChange={onFilterChange} />)
    );
  });
}

async function openClearConfirm() {
  await act(async () => {
    query("automation-history-clear")!.click();
  });
}

describe("HistorySection (#5818, slice 9)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    loadAutomationRuns = vi.fn<() => Promise<void>>(() => Promise.resolve());
    clearAutomationRuns = vi.fn<(ids?: string[]) => Promise<void>>(() => Promise.resolve());
    onFilterChange = vi.fn<(id: string | null) => void>();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  it("loads the run history on mount", () => {
    render([]);
    expect(loadAutomationRuns).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state, no filter and a disabled Clear with no runs", () => {
    render([]);
    expect(query("automation-history-empty")!.textContent).toBe("No runs yet.");
    expect((query("automation-history-clear") as HTMLButtonElement).disabled).toBe(true);
    expect(query("automation-history-filter")).toBeNull();
  });

  it("lists macro and workflow runs in one list, newest first as stored", () => {
    render(RUNS);
    const rows = [...query("automation-history-list")!.querySelectorAll('[role="listitem"]')];
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "automation-run-run-1",
      "automation-run-run-2",
      "automation-run-run-3",
    ]);
  });

  it("keeps rows to the name, a status dot and the time (names, not settings)", () => {
    // A recent end reads "just now"; an older one would show a date.
    const endedAt = new Date(Date.now() - 1000).toISOString();
    render(RUNS.map((r) => ({ ...r, endedAt })));
    const row = query("automation-run-toggle-run-2")!;
    expect(row.querySelector(".automation-history__name")!.textContent).toBe("Rotate logs");
    expect(row.querySelector('[aria-label="Failed"]')).not.toBeNull();
    expect(query("automation-run-time-run-2")!.getAttribute("dateTime")).toBe(endedAt);
    expect(query("automation-run-time-run-2")!.textContent).toBe("just now");
    const text = query("automation-history-list")!.textContent ?? "";
    expect(text).not.toMatch(/\d+\s*\/\s*\d+|\d+ (of \d+ )?steps?/);
    expect(text).not.toContain("db-1");
    expect(text).not.toContain("Run by");
    expect(row.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a row to show origin, outcome, steps, terminal and error", () => {
    render(RUNS);
    act(() => query("automation-run-toggle-run-2")!.click());
    expect(query("automation-run-toggle-run-2")!.getAttribute("aria-expanded")).toBe("true");
    expect(query("automation-run-origin-run-2")!.textContent).toBe("Run by schedule");
    expect(query("automation-run-status-run-2")!.textContent).toBe("Failed at step 3");
    expect(query("automation-run-steps-run-2")!.textContent).toBe("2 of 5 steps");
    expect(query("automation-run-target-run-2")!.textContent).toBe("db-1");
    expect(query("automation-run-error-run-2")!.textContent).toBe("timed out");
    act(() => query("automation-run-toggle-run-2")!.click());
    expect(query("automation-run-details-run-2")).toBeNull();
  });

  it("labels a palette run as run by you and names every target of a fan-out", () => {
    render(RUNS);
    act(() => query("automation-run-toggle-run-3")!.click());
    expect(query("automation-run-origin-run-3")!.textContent).toBe(
      "Run by you · From the command palette"
    );
    expect(query("automation-run-status-run-3")!.textContent).toBe("Canceled");
    expect(query("automation-run-target-run-3")!.textContent).toBe("web-1, web-2");
  });

  it("narrows to one automation and offers to show every automation again", () => {
    render(RUNS, "a2");
    expect(query("automation-run-run-1")).toBeNull();
    expect(query("automation-run-run-2")).not.toBeNull();
    expect(query("automation-history-filter")!.textContent).toContain("Rotate logs");
    act(() => query("automation-history-show-all")!.click());
    expect(onFilterChange).toHaveBeenCalledWith(null);
  });

  it("shows a filtered empty state for an automation that has not run yet", () => {
    render(RUNS, "never-ran");
    expect(query("automation-history-empty")!.textContent).toBe("No runs of this automation yet.");
    expect((query("automation-history-clear") as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks before clearing every run, and clears them all on confirm", async () => {
    render(RUNS);
    await openClearConfirm();
    expect(clearAutomationRuns).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Clear automation history?");
    expect(query("automation-history-clear-confirm-alternate")).toBeNull();
    await act(async () => {
      query("automation-history-clear-confirm-confirm")!.click();
    });
    expect(clearAutomationRuns).toHaveBeenCalledWith(undefined);
  });

  it("clears only the filtered automation's runs, or all of them from the alternate", async () => {
    render(
      [...RUNS, run({ id: "run-4", automationId: "a2", automationName: "Rotate logs" })],
      "a2"
    );
    await openClearConfirm();
    expect(document.body.textContent).toContain('Clear the history of "Rotate logs"?');
    await act(async () => {
      query("automation-history-clear-confirm-confirm")!.click();
    });
    expect(clearAutomationRuns).toHaveBeenCalledWith(["run-2", "run-4"]);

    await openClearConfirm();
    await act(async () => {
      query("automation-history-clear-confirm-alternate")!.click();
    });
    expect(clearAutomationRuns).toHaveBeenLastCalledWith(undefined);
  });

  it("keeps the history when the confirmation is canceled", async () => {
    render(RUNS);
    await openClearConfirm();
    await act(async () => {
      query("automation-history-clear-confirm-cancel")!.click();
    });
    expect(clearAutomationRuns).not.toHaveBeenCalled();
  });

  it("has no axe violations with a row open", async () => {
    render(RUNS);
    act(() => query("automation-run-toggle-run-1")!.click());
    await checkA11y(container);
  });
});
