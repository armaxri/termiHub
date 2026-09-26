import { StateCreator } from "zustand";

import {
  deleteSchedule as apiDeleteSchedule,
  listSchedules as apiListSchedules,
  saveSchedule as apiSaveSchedule,
  setScheduleEnabled as apiSetScheduleEnabled,
  setSchedulesPaused as apiSetSchedulesPaused,
} from "@/services/scheduleApi";
import type { ScheduleAction, ScheduleInput, ScheduleView } from "@/types/schedule";
import { newId } from "@/services/transport/ids";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

import type { AppState } from "../appStore";

/**
 * Scheduled workflows and macros (PROD-043): the frontend mirror of the
 * backend scheduler's state. The backend is authoritative — every action goes
 * through a command and then adopts the returned state; `schedules-changed`
 * events (a run settled, a next run moved) trigger {@link loadSchedules}.
 */
export interface SchedulesSlice {
  /** Every schedule with its live state (next run, running, last result). */
  schedules: ScheduleView[];
  /** The global pause switch. */
  schedulesPaused: boolean;
  /** Re-fetch the scheduler state from the backend. */
  loadSchedules: () => Promise<void>;
  /** Add or update a schedule (new ones are stored disabled). */
  saveSchedule: (input: ScheduleInput) => Promise<ScheduleView>;
  /** Delete a schedule. */
  deleteSchedule: (scheduleId: string) => Promise<void>;
  /**
   * Enable/disable a schedule. The first enable must pass `confirmed` (the
   * user confirmed the target hosts), otherwise the backend refuses.
   */
  setScheduleEnabled: (
    scheduleId: string,
    enabled: boolean,
    confirmed: boolean
  ) => Promise<ScheduleView>;
  /** Pause or resume all schedules. */
  setSchedulesPaused: (paused: boolean) => Promise<void>;
  /**
   * The open schedule editor: an existing schedule (`scheduleId`) or a new one,
   * optionally pre-targeting a workflow/macro. `null` when closed.
   */
  scheduleEditor: ScheduleEditorState | null;
  /** Open the schedule editor (from the schedules list or a workflow/macro row). */
  openScheduleEditor: (opts?: ScheduleEditorState) => void;
  /** Close the schedule editor. */
  closeScheduleEditor: () => void;
}

/** What the schedule editor is editing. */
export interface ScheduleEditorState {
  /** The schedule to edit; absent for a new schedule. */
  scheduleId?: string;
  /** For a new schedule: the workflow/macro to pre-select. */
  action?: ScheduleAction;
  /** The id a new schedule is saved under (minted when the editor opens). */
  draftId?: string;
}

export const createSchedulesSlice: StateCreator<AppState, [], [], SchedulesSlice> = (set) => {
  /** Replace one schedule in the list with a fresh view from the backend. */
  const adopt = (view: ScheduleView) =>
    set((state) => {
      const exists = state.schedules.some((s) => s.id === view.id);
      return {
        schedules: exists
          ? state.schedules.map((s) => (s.id === view.id ? view : s))
          : [...state.schedules, view],
      };
    });

  return {
    schedules: [],
    schedulesPaused: false,

    loadSchedules: async () => {
      try {
        const state = await apiListSchedules();
        set({ schedules: state.schedules, schedulesPaused: state.paused });
      } catch (err) {
        frontendLog("schedules", `Failed to load schedules: ${errorMessage(err)}`);
      }
    },

    saveSchedule: async (input) => {
      const view = await apiSaveSchedule(input);
      adopt(view);
      return view;
    },

    deleteSchedule: async (scheduleId) => {
      await apiDeleteSchedule(scheduleId);
      set((state) => ({ schedules: state.schedules.filter((s) => s.id !== scheduleId) }));
    },

    setScheduleEnabled: async (scheduleId, enabled, confirmed) => {
      const view = await apiSetScheduleEnabled(scheduleId, enabled, confirmed);
      adopt(view);
      return view;
    },

    setSchedulesPaused: async (paused) => {
      const state = await apiSetSchedulesPaused(paused);
      set({ schedules: state.schedules, schedulesPaused: state.paused });
    },

    scheduleEditor: null,
    openScheduleEditor: (opts) =>
      set({
        scheduleEditor: { ...opts, draftId: opts?.scheduleId ?? newId("schedule") },
      }),
    closeScheduleEditor: () => set({ scheduleEditor: null }),
  };
};
