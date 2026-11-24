import { StateCreator } from "zustand";

import {
  clearAutomationRunHistory as apiClearAutomationRunHistory,
  deleteAutomation as apiDeleteAutomation,
  getAutomation as apiGetAutomation,
  listAutomationRuns as apiListAutomationRuns,
  listAutomations as apiListAutomations,
  saveAutomation as apiSaveAutomation,
} from "@/services/automationApi";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

import type { AppState } from "../appStore";
import { syncWorkflowOutputTriggers } from "../workflowSessionTriggers";
import {
  automationForRun,
  automationLibraryState,
  automationRunsState,
} from "./automationStoreState";

/**
 * The single automation store (#5818, slice 4): the library and the run
 * history, backed by the merged `automations.json` / `automation-runs.json`
 * IPC. It is the only writer of the library and history state; the macros and
 * workflows slices are thin adapters that read the derived `macros` /
 * `workflows` / `macroRuns` / `workflowRuns` views and write through here.
 */
export interface AutomationsSlice {
  /** Every stored automation, in store order. */
  automations: Automation[];
  /** Every recorded run, newest first. Metadata only. */
  automationRuns: AutomationRun[];
  /** Load the library from the backend. Logs (never throws) on failure. */
  loadAutomations: () => Promise<void>;
  /** Save (add or update) an automation, then refresh the library. */
  saveAutomationToBackend: (automation: Automation) => Promise<Automation>;
  /** Delete an automation; the store changes only after the backend delete resolves. */
  deleteAutomationFromBackend: (automationId: string) => Promise<void>;
  /**
   * Find an automation to run by id. A miss in the local library (another
   * window created it moments ago) asks the backend once and reloads the
   * library when it exists; resolves `undefined` when there is none.
   */
  fetchAutomationForRun: (automationId: string) => Promise<Automation | undefined>;
  /** Load the run history from the backend. Logs (never throws) on failure. */
  loadAutomationRuns: () => Promise<void>;
  /**
   * Clear the given runs, or the whole history when `runIds` is omitted.
   * Rejects when the backend clear fails; the store is unchanged then.
   */
  clearAutomationRuns: (runIds?: string[]) => Promise<void>;
}

export const createAutomationsSlice: StateCreator<AppState, [], [], AutomationsSlice> = (
  set,
  get
) => {
  const applyLibrary = (automations: Automation[]): void => {
    set(automationLibraryState(automations));
    syncWorkflowOutputTriggers({ get, set }, get().workflows);
  };

  return {
    automations: [],
    automationRuns: [],

    loadAutomations: async () => {
      try {
        const automations = await apiListAutomations();
        applyLibrary(Array.isArray(automations) ? automations : []);
      } catch (err) {
        frontendLog("app_store", `Failed to load automations: ${errorMessage(err)}`);
      }
    },

    saveAutomationToBackend: async (automation) => {
      const saved = await apiSaveAutomation(automation);
      await get().loadAutomations();
      return saved;
    },

    deleteAutomationFromBackend: async (automationId) => {
      await apiDeleteAutomation(automationId);
      applyLibrary(get().automations.filter((a) => a.id !== automationId));
    },

    fetchAutomationForRun: async (automationId) => {
      const local = automationForRun(get(), automationId);
      if (local) return local;
      try {
        const fetched = await apiGetAutomation(automationId);
        await get().loadAutomations();
        return fetched;
      } catch (err) {
        frontendLog("app_store", `Automation ${automationId} not found: ${errorMessage(err)}`);
        return undefined;
      }
    },

    loadAutomationRuns: async () => {
      try {
        set(automationRunsState(await apiListAutomationRuns()));
      } catch (err) {
        frontendLog("app_store", `Failed to load automation run history: ${errorMessage(err)}`);
      }
    },

    clearAutomationRuns: async (runIds) => {
      set(automationRunsState(await apiClearAutomationRunHistory(runIds)));
    },
  };
};
