import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { withTooltip } from "@/test/tooltip";
import type { SavedConnection } from "@/types/connection";
import type { ScheduleInput } from "@/types/schedule";
import type { Workflow } from "@/types/workflow";
import { ScheduleEditorDialog } from "./ScheduleEditorDialog";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

const query = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function setInput(testId: string, value: string) {
  const input = query(testId) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const workflows: Workflow[] = [
  {
    id: "wf-1",
    name: "Health check",
    tags: [],
    steps: [{ kind: "send-command", command: "uptime" }],
    triggers: [],
    createdAt: "",
    updatedAt: "",
  },
];
const connections: SavedConnection[] = [
  { id: "c1", name: "web-1", config: {} as never, folderId: null },
  { id: "c2", name: "web-2", config: {} as never, folderId: null },
];

function render(props: { schedule?: ScheduleInput | null; onSave?: (i: ScheduleInput) => void }) {
  act(() => {
    root.render(
      withTooltip(
        <ScheduleEditorDialog
          open
          scheduleId="schedule-new"
          schedule={props.schedule ?? null}
          initialAction={{ kind: "workflow", workflowId: "wf-1" }}
          workflows={workflows}
          macros={[]}
          connections={connections}
          groups={[]}
          onOpenChange={vi.fn()}
          onSave={props.onSave ?? vi.fn()}
        />
      )
    );
  });
}

describe("ScheduleEditorDialog (PROD-043)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps Save disabled until the schedule has a name and a target", () => {
    render({});
    const save = () => query("schedule-editor-save") as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    setInput("schedule-editor-name", "Nightly");
    expect(save().disabled).toBe(true);
    act(() => query("schedule-editor-connection-c2")!.click());
    expect(save().disabled).toBe(false);
  });

  it("saves the pre-selected workflow on the chosen connections every N minutes", async () => {
    const onSave = vi.fn();
    render({ onSave });
    setInput("schedule-editor-name", "  Ping  ");
    act(() => query("schedule-editor-connection-c1")!.click());
    setInput("schedule-editor-every", "5");
    await act(async () => query("schedule-editor-save")!.click());
    expect(onSave).toHaveBeenCalledWith({
      id: "schedule-new",
      name: "Ping",
      action: { kind: "workflow", workflowId: "wf-1" },
      targets: { kind: "connections", connectionIds: ["c1"] },
      rule: { kind: "interval", everyMinutes: 5 },
      missedRuns: "skip",
    });
  });

  it("shows an inline error for an out-of-range interval", () => {
    render({});
    setInput("schedule-editor-every", "0");
    expect(document.body.textContent).toContain("At least 1 minute.");
  });

  it("loads an existing weekly schedule for editing", () => {
    render({
      schedule: {
        id: "s1",
        name: "Backups",
        action: { kind: "workflow", workflowId: "wf-1" },
        targets: { kind: "connections", connectionIds: ["c2"] },
        rule: { kind: "weekly", days: ["sat"], time: "03:15" },
        missedRuns: "run-once",
      },
    });
    expect((query("schedule-editor-name") as HTMLInputElement).value).toBe("Backups");
    expect((query("schedule-editor-time") as HTMLInputElement).value).toBe("03:15");
    expect(query("schedule-editor-day-sat")!.getAttribute("aria-pressed")).toBe("true");
    expect(query("schedule-editor-day-mon")!.getAttribute("aria-pressed")).toBe("false");
    expect(query("schedule-editor-dialog")!.textContent).toContain("Edit Schedule");
  });
});
