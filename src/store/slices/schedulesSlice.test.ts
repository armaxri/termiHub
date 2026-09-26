import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ScheduleView, SchedulerState } from "@/types/schedule";

const api = vi.hoisted(() => ({
  listSchedules: vi.fn(),
  saveSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  setScheduleEnabled: vi.fn(),
  setSchedulesPaused: vi.fn(),
}));
vi.mock("@/services/scheduleApi", () => api);

import { useAppStore } from "../appStore";

function view(id: string, over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id,
    name: id,
    action: { kind: "workflow", workflowId: "wf" },
    targets: { kind: "connections", connectionIds: ["c"] },
    rule: { kind: "daily", time: "09:00" },
    missedRuns: "skip",
    enabled: false,
    running: false,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

describe("schedulesSlice (PROD-043)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    Object.values(api).forEach((f) => f.mockReset());
  });

  it("loads the backend state", async () => {
    const state: SchedulerState = { paused: true, schedules: [view("a")] };
    api.listSchedules.mockResolvedValue(state);
    await useAppStore.getState().loadSchedules();
    expect(useAppStore.getState().schedules).toEqual(state.schedules);
    expect(useAppStore.getState().schedulesPaused).toBe(true);
  });

  it("a failed load keeps the current list", async () => {
    useAppStore.setState({ schedules: [view("a")] });
    api.listSchedules.mockRejectedValue(new Error("boom"));
    await useAppStore.getState().loadSchedules();
    expect(useAppStore.getState().schedules).toHaveLength(1);
  });

  it("adopts saved and enabled views, appending new ones", async () => {
    useAppStore.setState({ schedules: [view("a")] });
    api.saveSchedule.mockResolvedValue(view("b"));
    await useAppStore.getState().saveSchedule({
      id: "b",
      name: "b",
      action: { kind: "workflow", workflowId: "wf" },
      targets: { kind: "connections", connectionIds: ["c"] },
      rule: { kind: "daily", time: "09:00" },
      missedRuns: "skip",
    });
    api.setScheduleEnabled.mockResolvedValue(view("a", { enabled: true }));
    await useAppStore.getState().setScheduleEnabled("a", true, true);
    expect(api.setScheduleEnabled).toHaveBeenCalledWith("a", true, true);
    expect(useAppStore.getState().schedules.map((s) => [s.id, s.enabled])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("deletes and pauses through the backend", async () => {
    useAppStore.setState({ schedules: [view("a"), view("b")] });
    api.deleteSchedule.mockResolvedValue(undefined);
    await useAppStore.getState().deleteSchedule("a");
    expect(useAppStore.getState().schedules.map((s) => s.id)).toEqual(["b"]);
    api.setSchedulesPaused.mockResolvedValue({ paused: true, schedules: [view("b")] });
    await useAppStore.getState().setSchedulesPaused(true);
    expect(useAppStore.getState().schedulesPaused).toBe(true);
  });

  it("opens the editor with a minted draft id, or the edited schedule's id", () => {
    useAppStore.getState().openScheduleEditor({ action: { kind: "macro", macroId: "m" } });
    const draft = useAppStore.getState().scheduleEditor;
    expect(draft?.action).toEqual({ kind: "macro", macroId: "m" });
    expect(draft?.draftId).toMatch(/schedule/);
    useAppStore.getState().openScheduleEditor({ scheduleId: "a" });
    expect(useAppStore.getState().scheduleEditor?.draftId).toBe("a");
    useAppStore.getState().closeScheduleEditor();
    expect(useAppStore.getState().scheduleEditor).toBeNull();
  });
});
