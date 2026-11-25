import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { withTooltip } from "@/test/tooltip";
import type { SavedConnection } from "@/types/connection";
import type { ScheduleAction, ScheduleInput } from "@/types/schedule";
import type { Automation } from "@/types/generated/Automation";
import { LOCAL_PROCESS_REASON } from "@/utils/localProcessGate";
import { ScheduleEditorDialog } from "./ScheduleEditorDialog";
import { flushAsync } from "@/test/flushAsync";
import { leaveField } from "@/test/leaveField";
import { installConnectionIdChangesHarness } from "@/test/connectionIdChangesHarness";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

const experimental = vi.hoisted(() => ({ on: false }));
vi.mock("@/hooks/useExperimentalFeatures", () => ({
  useExperimentalFeatures: () => experimental.on,
}));

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

const automations: Automation[] = [
  {
    id: "wf-1",
    name: "Health check",
    tags: [],
    steps: [{ kind: "send-command", command: "uptime" }],
    triggers: [],
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "m-1",
    name: "Restart",
    tags: [],
    steps: [{ kind: "type-keys", chunks: [{ data: "restart\r", delayMs: 0 }], timing: "recorded" }],
    triggers: [],
    createdAt: "",
    updatedAt: "",
  },
];
/** Reaches a local process only through another automation. */
const localAutomations: Automation[] = [
  ...automations,
  {
    ...automations[0],
    id: "lp",
    name: "Build",
    steps: [{ kind: "run-local-process", program: "make", args: [] }],
  },
  {
    ...automations[0],
    id: "calls-lp",
    name: "Release",
    steps: [{ kind: "run-automation", automationId: "lp" }],
  },
];
const connections: SavedConnection[] = [
  { id: "c1", name: "web-1", config: {} as never, folderId: null },
  { id: "c2", name: "web-2", config: {} as never, folderId: null },
];

function render(props: {
  schedule?: ScheduleInput | null;
  onSave?: (i: ScheduleInput) => void;
  initialAction?: ScheduleAction;
  automations?: Automation[];
}) {
  act(() => {
    root.render(
      withTooltip(
        <ScheduleEditorDialog
          open
          scheduleId="schedule-new"
          schedule={props.schedule ?? null}
          initialAction={
            "initialAction" in props
              ? props.initialAction
              : { kind: "automation", automationId: "wf-1" }
          }
          automations={props.automations ?? automations}
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
    experimental.on = false;
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
    expect(save().getAttribute("aria-disabled")).toBe("true");
    setInput("schedule-editor-name", "Nightly");
    expect(save().getAttribute("aria-disabled")).toBe("true");
    act(() => query("schedule-editor-connection-c2")!.click());
    expect(save().getAttribute("aria-disabled")).toBe("false");
  });

  it("saves the pre-selected automation on the chosen connections every N minutes", async () => {
    const onSave = vi.fn();
    render({ onSave });
    setInput("schedule-editor-name", "  Ping  ");
    act(() => query("schedule-editor-connection-c1")!.click());
    setInput("schedule-editor-every", "5");
    await act(async () => query("schedule-editor-save")!.click());
    expect(onSave).toHaveBeenCalledWith({
      id: "schedule-new",
      name: "Ping",
      action: { kind: "automation", automationId: "wf-1" },
      targets: { kind: "connections", connectionIds: ["c1"] },
      rule: { kind: "interval", everyMinutes: 5 },
      missedRuns: "skip",
    });
  });

  it("saves a short one-line description (#5757)", async () => {
    const onSave = vi.fn();
    render({ onSave });
    const input = query("schedule-editor-description") as HTMLInputElement;
    expect(input.maxLength).toBe(80);
    setInput("schedule-editor-name", "Ping");
    setInput("schedule-editor-description", "  Checks the web hosts ");
    act(() => query("schedule-editor-connection-c1")!.click());
    await act(async () => query("schedule-editor-save")!.click());
    expect(onSave.mock.calls[0][0].description).toBe("Checks the web hosts");
  });

  it("offers 'Connect if not connected', off by default, with its help text (#3527)", async () => {
    const onSave = vi.fn();
    render({ onSave });
    const box = query("schedule-editor-connect")!;
    expect(box.getAttribute("aria-checked")).toBe("false");
    const text = query("schedule-editor-dialog")!.textContent ?? "";
    expect(text).toContain("Connect if not connected");
    expect(text).toContain("Tabs opened for the run close when it ends");
    expect(text).toContain("tabs that were already open stay open");

    setInput("schedule-editor-name", "Ping");
    act(() => query("schedule-editor-connection-c1")!.click());
    act(() => box.click());
    expect(box.getAttribute("aria-checked")).toBe("true");
    await act(async () => query("schedule-editor-save")!.click());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ connectIfNeeded: true }));
  });

  it("shows an inline error for an out-of-range interval", () => {
    render({});
    setInput("schedule-editor-every", "0");
    leaveField(query("schedule-editor-every"));
    expect(document.body.textContent).toContain("At least 1 minute.");
  });

  it("loads an existing weekly schedule for editing", () => {
    render({
      schedule: {
        id: "s1",
        name: "Backups",
        action: { kind: "automation", automationId: "wf-1" },
        targets: { kind: "connections", connectionIds: ["c2"] },
        rule: { kind: "weekly", days: ["sat"], time: "03:15" },
        missedRuns: "run-once",
      },
    });
    expect((query("schedule-editor-name") as HTMLInputElement).value).toBe("Backups");
    expect((query("schedule-editor-time") as HTMLInputElement).value).toBe("03:15");
    expect(query("schedule-editor-day-sat")!.getAttribute("aria-pressed")).toBe("true");
    expect(query("schedule-editor-day-mon")!.getAttribute("aria-pressed")).toBe("false");
    expect(query("schedule-editor-dialog")!.textContent).toContain("Edit schedule");
  });

  describe("an open editor follows connection id changes (#3603)", () => {
    const existing: ScheduleInput = {
      id: "s1",
      name: "Backups",
      action: { kind: "automation", automationId: "wf-1" },
      targets: { kind: "connections", connectionIds: ["c1", "c2"] },
      rule: { kind: "interval", everyMinutes: 5 },
      missedRuns: "skip",
    };

    it("saves the renamed connection's new id", async () => {
      const events = installConnectionIdChangesHarness();
      const onSave = vi.fn();
      render({ schedule: existing, onSave });
      await flushAsync();

      events.emit([
        { oldId: "c1", newId: "c2" },
        { oldId: "c2", newId: "c1" },
      ]);
      await act(async () => query("schedule-editor-save")!.click());

      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          targets: { kind: "connections", connectionIds: ["c2", "c1"] },
        })
      );
    });

    it("keeps unsaved edits when the schedule list refreshes", async () => {
      const onSave = vi.fn();
      render({ schedule: existing, onSave });
      setInput("schedule-editor-name", "Edited");
      // The backend followed the rename and the list reloaded: a new object, same id.
      render({
        schedule: { ...existing, targets: { kind: "connections", connectionIds: ["c1", "c2"] } },
        onSave,
      });
      await act(async () => query("schedule-editor-save")!.click());

      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: "Edited" }));
    });
  });

  describe("validation timing (#5917)", () => {
    const nameError = () => document.getElementById("schedule-editor-name-error");
    const connectionsError = () =>
      query("schedule-editor-dialog")!.textContent?.includes("Pick at least one saved connection.");

    it("opens a new schedule without any error", () => {
      render({});
      expect(nameError()).toBeNull();
      expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
      expect(query("schedule-editor-save")!.getAttribute("aria-disabled")).toBe("true");
    });

    it("shows a field's error once it was edited and left", () => {
      render({});
      setInput("schedule-editor-name", "x");
      setInput("schedule-editor-name", "");
      expect(nameError()).toBeNull();
      leaveField(query("schedule-editor-name"));
      expect(nameError()?.textContent).toBe("Name is required.");
      setInput("schedule-editor-name", "Nightly");
      expect(nameError()).toBeNull();
    });

    it("a Save attempt saves nothing, shows every error and focuses Name", async () => {
      const onSave = vi.fn();
      render({ onSave });
      const save = query("schedule-editor-save") as HTMLButtonElement;
      expect(save.disabled).toBe(false);
      act(() => save.focus());
      await act(async () => save.click());
      expect(onSave).not.toHaveBeenCalled();
      expect(nameError()?.textContent).toBe("Name is required.");
      expect(connectionsError()).toBe(true);
      expect(document.activeElement).toBe(query("schedule-editor-name"));
    });
  });

  describe("one automation picker (#5818)", () => {
    const pickerOptions = () => {
      const trigger = query("schedule-editor-automation") as HTMLButtonElement;
      act(() => {
        trigger.focus();
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      return Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent);
    };

    it("lists every automation in one picker, typed and command ones alike", () => {
      render({ initialAction: undefined });
      expect(query("schedule-editor-action-kind")).toBeNull();
      expect(query("schedule-editor-workflow")).toBeNull();
      expect(query("schedule-editor-macro")).toBeNull();
      expect(pickerOptions()).toEqual(["Health check", "Restart"]);
      const text = query("schedule-editor-dialog")!.textContent ?? "";
      expect(text).toContain("Run an automation");
      expect(text).not.toMatch(/\b(macro|workflow)\b/i);
    });

    it("asks for an automation before saving", async () => {
      const onSave = vi.fn();
      render({ initialAction: undefined, onSave });
      setInput("schedule-editor-name", "Ping");
      act(() => query("schedule-editor-connection-c1")!.click());
      expect(query("schedule-editor-save")!.getAttribute("aria-disabled")).toBe("true");
      await act(async () => query("schedule-editor-save")!.click());
      expect(onSave).not.toHaveBeenCalled();
      expect(query("schedule-editor-dialog")!.textContent).toContain("Pick an automation.");
    });

    it("pre-selects a typed automation from its row", async () => {
      const onSave = vi.fn();
      render({ initialAction: { kind: "automation", automationId: "m-1" }, onSave });
      expect(query("schedule-editor-automation")!.textContent).toContain("Restart");
      setInput("schedule-editor-name", "Nightly restart");
      act(() => query("schedule-editor-connection-c2")!.click());
      await act(async () => query("schedule-editor-save")!.click());
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ action: { kind: "automation", automationId: "m-1" } })
      );
    });

    it("keeps a deleted automation's id on save and names it as deleted", async () => {
      const onSave = vi.fn();
      render({
        schedule: {
          id: "s1",
          name: "Orphan",
          action: { kind: "automation", automationId: "gone" },
          targets: { kind: "connections", connectionIds: ["c1"] },
          rule: { kind: "interval", everyMinutes: 5 },
          missedRuns: "skip",
        },
        onSave,
      });
      expect(query("schedule-editor-automation")!.textContent).toContain("Missing automation");
      setInput("schedule-editor-name", "Orphan 2");
      await act(async () => query("schedule-editor-save")!.click());
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ action: { kind: "automation", automationId: "gone" } })
      );
    });
  });

  describe("an automation that can run a local process (#5818)", () => {
    const pickerOptions = () => {
      act(() => {
        const trigger = query("schedule-editor-automation") as HTMLButtonElement;
        trigger.focus();
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      return Array.from(document.querySelectorAll('[role="option"]')).map((o) => [
        o.textContent,
        o.getAttribute("aria-disabled") === "true",
      ]);
    };
    const existing = (automationId: string): ScheduleInput => ({
      id: "s1",
      name: "Old",
      action: { kind: "automation", automationId },
      targets: { kind: "connections", connectionIds: ["c1"] },
      rule: { kind: "interval", everyMinutes: 5 },
      missedRuns: "skip",
    });
    const text = () => query("schedule-editor-dialog")!.textContent ?? "";

    it("is listed disabled with the reason while experimental features are off", () => {
      render({ initialAction: undefined, automations: localAutomations });
      expect(pickerOptions()).toEqual([
        ["Health check", false],
        ["Restart", false],
        ["Build (experimental: runs a local process)", true],
        ["Release (experimental: runs a local process)", true],
      ]);
    });

    it("is an ordinary choice while they are on", () => {
      experimental.on = true;
      render({ initialAction: undefined, automations: localAutomations });
      expect(pickerOptions().slice(2)).toEqual([
        ["Build", false],
        ["Release", false],
      ]);
    });

    it("cannot be saved when its row pre-selected it", async () => {
      const onSave = vi.fn();
      render({
        initialAction: { kind: "automation", automationId: "calls-lp" },
        automations: localAutomations,
        onSave,
      });
      setInput("schedule-editor-name", "Nightly");
      act(() => query("schedule-editor-connection-c1")!.click());
      expect(query("schedule-editor-save")!.getAttribute("aria-disabled")).toBe("true");
      expect(text()).toContain(LOCAL_PROCESS_REASON);
      await act(async () => query("schedule-editor-save")!.click());
      expect(onSave).not.toHaveBeenCalled();
    });

    it("keeps its id on an existing schedule, which says why it will not run", async () => {
      const onSave = vi.fn();
      render({ schedule: existing("lp"), automations: localAutomations, onSave });
      expect(text()).toContain(LOCAL_PROCESS_REASON);
      setInput("schedule-editor-name", "Renamed");
      await act(async () => query("schedule-editor-save")!.click());
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Renamed",
          action: { kind: "automation", automationId: "lp" },
        })
      );
    });
  });
});
