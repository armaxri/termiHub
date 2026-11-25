import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { withTooltip } from "@/test/tooltip";
import type { SavedConnection } from "@/types/connection";
import type { ScheduleAction, ScheduleInput } from "@/types/schedule";
import type { Automation } from "@/types/generated/Automation";
import { LOCAL_PROCESS_REASON } from "@/utils/localProcessGate";
import { ScheduleEditorDialog } from "./ScheduleEditorDialog";
import type { PreviewNextRun } from "./useNextRun";
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

const choose = (what: "connect" | "skip") =>
  act(() => query(`schedule-editor-closed-${what}`)!.click());
const chosen = (what: "connect" | "skip") =>
  query(`schedule-editor-closed-${what}`)!.getAttribute("aria-checked") === "true";
const summary = () =>
  [...query("schedule-editor-summary")!.children].map((line) => line.textContent);

function render(props: {
  enabled?: boolean;
  paused?: boolean;
  previewNextRun?: PreviewNextRun;
  connections?: SavedConnection[];
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
          connections={props.connections ?? connections}
          groups={[]}
          enabled={props.enabled}
          paused={props.paused}
          previewNextRun={props.previewNextRun}
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

  it("keeps Save disabled until the schedule has a name, a target and a choice", () => {
    render({});
    const save = () => query("schedule-editor-save") as HTMLButtonElement;
    expect(save().getAttribute("aria-disabled")).toBe("true");
    setInput("schedule-editor-name", "Nightly");
    expect(save().getAttribute("aria-disabled")).toBe("true");
    act(() => query("schedule-editor-connection-c2")!.click());
    expect(save().getAttribute("aria-disabled")).toBe("true");
    choose("skip");
    expect(save().getAttribute("aria-disabled")).toBe("false");
  });

  it("saves the pre-selected automation on the chosen connections every N minutes", async () => {
    const onSave = vi.fn();
    render({ onSave });
    setInput("schedule-editor-name", "  Ping  ");
    act(() => query("schedule-editor-connection-c1")!.click());
    setInput("schedule-editor-every", "5");
    choose("skip");
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
    choose("skip");
    await act(async () => query("schedule-editor-save")!.click());
    expect(onSave.mock.calls[0][0].description).toBe("Checks the web hosts");
  });

  describe("what to do with a closed connection (#3527, A-044)", () => {
    const stored = (connectIfNeeded?: boolean): ScheduleInput => ({
      id: "s1",
      name: "Backups",
      action: { kind: "automation", automationId: "wf-1" },
      targets: { kind: "connections", connectionIds: ["c2"] },
      rule: { kind: "daily", time: "02:00" },
      missedRuns: "skip",
      ...(connectIfNeeded === undefined ? {} : { connectIfNeeded }),
    });

    it("preselects nothing for a new schedule, and Save asks for it", async () => {
      const onSave = vi.fn();
      render({ onSave });
      expect([chosen("connect"), chosen("skip")]).toEqual([false, false]);
      setInput("schedule-editor-name", "Ping");
      act(() => query("schedule-editor-connection-c1")!.click());
      await act(async () => query("schedule-editor-save")!.click());
      expect(onSave).not.toHaveBeenCalled();
      const group = query("schedule-editor-closed")!;
      expect(group.getAttribute("aria-invalid")).toBe("true");
      const error = document.getElementById(group.getAttribute("aria-describedby")!)!;
      expect(error.textContent).toBe("Choose what to do with a closed connection.");
      expect(group.contains(document.activeElement)).toBe(true);
    });

    it("saves the choice", async () => {
      for (const [what, expected] of [
        ["connect", true],
        ["skip", undefined],
      ] as const) {
        const onSave = vi.fn();
        act(() => root.unmount());
        root = createRoot(container);
        render({ onSave });
        setInput("schedule-editor-name", "Ping");
        act(() => query("schedule-editor-connection-c1")!.click());
        choose(what);
        await act(async () => query("schedule-editor-save")!.click());
        expect(onSave.mock.calls[0][0].connectIfNeeded).toBe(expected);
      }
    });

    it.each([
      [undefined, "skip"],
      [false, "skip"],
      [true, "connect"],
    ] as const)("an existing schedule with %s keeps it: %s", async (value, what) => {
      const onSave = vi.fn();
      render({ schedule: stored(value), onSave });
      expect(chosen("connect")).toBe(what === "connect");
      expect(chosen("skip")).toBe(what === "skip");
      await act(async () => query("schedule-editor-save")!.click());
      expect(onSave.mock.calls[0][0].connectIfNeeded).toBe(value);
    });

    it("comes before When, with how connecting works behind a disclosure", () => {
      render({});
      const follows = (a: string, b: string) =>
        query(a)!.compareDocumentPosition(query(b)!) & Node.DOCUMENT_POSITION_FOLLOWING;
      expect(follows("schedule-editor-closed", "schedule-editor-rule-kind")).toBeTruthy();
      const first = query("schedule-editor-form")!.firstElementChild!;
      expect(first.textContent).toBe("Runs only while termiHub is open on this computer.");
      const details = query("schedule-editor-details")!.closest("details")!;
      expect(details.open).toBe(false);
      expect(details.textContent).toContain("Tabs opened for the run close when it ends");
      expect(query("schedule-editor-dialog")!.textContent).not.toMatch(/\b(dis|en)abled?\b/i);
    });
  });

  describe("what will happen, before saving (A-046)", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(2, 0, 0, 0);
    const preview = vi.fn<PreviewNextRun>();
    const nightly: ScheduleInput = {
      id: "s1",
      name: "Backups",
      action: { kind: "automation", automationId: "wf-1" },
      targets: { kind: "connections", connectionIds: ["c2"] },
      rule: { kind: "daily", time: "02:00" },
      missedRuns: "skip",
    };
    beforeEach(() => {
      preview.mockReset().mockResolvedValue(tomorrow.toISOString());
    });

    it("names the next run and the connections of a schedule that is on", async () => {
      render({ schedule: nightly, enabled: true, previewNextRun: preview });
      await flushAsync();
      expect(preview).toHaveBeenLastCalledWith({ kind: "daily", time: "02:00" });
      expect(summary()).toEqual([
        "Next run: tomorrow 02:00 on web-2.",
        "Skipped where the connection is closed.",
      ]);
      choose("connect");
      expect(summary()[1]).toMatch(/^Saving switches it off/);
    });

    it("says that a new one is off, and follows the rule", async () => {
      render({ previewNextRun: preview });
      await flushAsync();
      expect(summary()).toEqual([
        "Next run: 15 minutes after you switch it on, but no connection is chosen.",
        "Off until you switch it on in the list.",
      ]);
      setInput("schedule-editor-every", "5");
      await flushAsync();
      expect(preview).toHaveBeenLastCalledWith({ kind: "interval", everyMinutes: 5 });
      act(() => query("schedule-editor-connection-c1")!.click());
      expect(summary()[0]).toBe("Next run: 5 minutes after you switch it on, on web-1.");
    });

    it("never shows the answer to an earlier rule", async () => {
      let answer: (iso: string) => void = () => {};
      preview.mockImplementation((rule) =>
        rule.kind === "daily" && rule.time === "02:00"
          ? new Promise((resolve) => (answer = resolve))
          : new Promise(() => {})
      );
      render({ schedule: nightly, enabled: true, previewNextRun: preview });
      await flushAsync();
      setInput("schedule-editor-time", "03:00");
      await act(async () => answer(tomorrow.toISOString()));
      await flushAsync();
      expect(summary()).toEqual(["Skipped where the connection is closed."]);
    });

    it("says it when all schedules are paused", async () => {
      render({ schedule: nightly, enabled: true, paused: true, previewNextRun: preview });
      await flushAsync();
      expect(summary()).toContain("All schedules are paused.");
    });
  });

  describe("deleted connections (A-045)", () => {
    const stored = (connectionIds: string[]): ScheduleInput => ({
      id: "s1",
      name: "Backups",
      action: { kind: "automation", automationId: "wf-1" },
      targets: { kind: "connections", connectionIds },
      rule: { kind: "daily", time: "02:00" },
      missedRuns: "skip",
    });
    const preview: PreviewNextRun = () => Promise.resolve(new Date().toISOString());

    it("are named, and the summary says that nothing will run", async () => {
      const onSave = vi.fn();
      render({ schedule: stored(["Work/Old Box"]), previewNextRun: preview, onSave });
      await flushAsync();
      expect(query("schedule-editor-connection-deleted-0")!.textContent).toContain(
        "Deleted connection “Old Box”"
      );
      expect(summary()[0]).toBe("Will not run: its connections were deleted.");
      // A rename of it stays possible; its targets are saved as they were.
      setInput("schedule-editor-name", "Renamed");
      await act(async () => query("schedule-editor-save")!.click());
      expect(onSave.mock.calls[0][0].targets.connectionIds).toEqual(["Work/Old Box"]);
    });

    it("can be removed", async () => {
      const onSave = vi.fn();
      render({ schedule: stored(["Work/Old Box", "c1"]), onSave });
      act(() => query("schedule-editor-connection-deleted-remove-0")!.click());
      expect(query("schedule-editor-connection-deleted-0")).toBeNull();
      await act(async () => query("schedule-editor-save")!.click());
      expect(onSave.mock.calls[0][0].targets.connectionIds).toEqual(["c1"]);
    });

    it("are no choice once the choice was changed", async () => {
      const onSave = vi.fn();
      render({ schedule: stored(["Work/Old Box", "c1"]), onSave });
      act(() => query("schedule-editor-connection-c1")!.click());
      const save = query("schedule-editor-save")!;
      expect(save.getAttribute("aria-disabled")).toBe("true");
      expect(query("schedule-editor-dialog")!.textContent).toContain(
        "All chosen connections were deleted. Pick another one."
      );
      await act(async () => save.click());
      expect(onSave).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(query("schedule-editor-connections"));
    });
  });

  describe("an automation nobody is there for (A-047)", () => {
    const note = () => query("schedule-editor-automation-note")?.textContent ?? null;
    const withStep = (over: Partial<Automation>): Automation[] => [{ ...automations[0], ...over }];

    it("says nothing for one that runs alone", () => {
      render({});
      expect(note()).toBeNull();
    });

    it("says that it will not run without a value", () => {
      render({
        automations: withStep({ parameters: [{ name: "env", type: "string", required: true }] }),
      });
      expect(note()).toContain("it asks for “env”");
      expect(summary()[0]).toContain("it asks for “env”");
    });

    it("says which values it uses", () => {
      render({
        automations: withStep({ parameters: [{ name: "env", type: "string", default: "dev" }] }),
      });
      expect(note()).toBe("Does not ask, it uses the default values: env = dev.");
    });

    it("warns about a password prompt, before the values", () => {
      render({
        automations: withStep({
          steps: [{ kind: "send-command", command: "sudo reboot" }],
          parameters: [{ name: "env", type: "string", default: "dev" }],
        }),
      });
      expect(note()).toContain("It types “sudo”");
    });
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
      choose("skip");
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
      expect(query("schedule-editor-automation")!.textContent).toContain("Deleted automation");
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
      choose("skip");
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
