import { StateCreator } from "zustand";

import {
  clearAutomationRunHistory as apiClearAutomationRunHistory,
  deleteAutomation as apiDeleteAutomation,
  getAutomation as apiGetAutomation,
  importAutomation as apiImportAutomation,
  listAutomationRuns as apiListAutomationRuns,
  listAutomations as apiListAutomations,
  saveAutomation as apiSaveAutomation,
} from "@/services/automationApi";
import {
  parseAutomationFile,
  prepareAutomationImport,
  type AutomationImport,
} from "@/services/automationFileIo";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import { toast } from "@/components/ui";
import { newId } from "@/services/transport/ids";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

import type { AppState } from "../appStore";
import { getActiveTab } from "../layoutHelpers";
import { syncWorkflowOutputTriggers } from "../workflowSessionTriggers";
import {
  automationForRun,
  automationLibraryState,
  automationRunsState,
} from "./automationStoreState";
import { isMacroShaped } from "./automationViews";
import { runsReplacedBy, type RunningAutomation } from "./runningAutomations";

/** Where {@link AutomationsSlice.runAutomation} runs an automation. */
export interface RunAutomationOptions {
  /** The terminals to run on; omitted = the active terminal. */
  targetTabIds?: string[];
  /** Run several terminals at the same time (the default) or one after another. */
  parallel?: boolean;
  /** What started the run, for the history; omitted = by hand. */
  origin?: "palette" | "hotkey";
}

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
  /**
   * Import the automations of a file (see {@link parseAutomationFile} and
   * {@link prepareAutomationImport}). A malformed file rejects before anything
   * is saved. Resolves with what was imported and what to tell the user.
   */
  importAutomations: (json: string) => Promise<AutomationImport>;
  /**
   * Run an automation by hand (#5818, slice 6). The one entry point of the
   * Automations sidebar, the run picker, the command palette and hotkeys: an automation that only types keystrokes plays through
   * {@link AppState.playMacro}, every other one through
   * {@link AppState.runWorkflow}, which own their guards (connected terminal,
   * experimental local process), progress and history.
   */
  runAutomation: (automationId: string, options?: RunAutomationOptions) => Promise<void>;
  /** A run that would stop others waits for the user's answer here (#6042). */
  runReplacePrompt: RunReplacePrompt | null;
  resolveRunReplacePrompt: (stop: boolean) => void;
  /**
   * Save a copy named "Copy of …" under a fresh id. The copy keeps everything
   * but the migration's provenance, which names the original's legacy entry.
   */
  duplicateAutomation: (automationId: string) => Promise<void>;
  /** Load the run history from the backend. Logs (never throws) on failure. */
  loadAutomationRuns: () => Promise<void>;
  /**
   * Clear the given runs, or the whole history when `runIds` is omitted.
   * Rejects when the backend clear fails; the store is unchanged then.
   */
  clearAutomationRuns: (runIds?: string[]) => Promise<void>;
}

/** The question whether a run may stop the ones in progress. */
export interface RunReplacePrompt {
  /** The automation to start. */
  name: string;
  running: RunningAutomation[];
  resolve: (stop: boolean) => void;
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

    importAutomations: async (json) => {
      const file = parseAutomationFile(json);
      const prepared = prepareAutomationImport(file, get().automations);
      let saved = 0;
      try {
        for (const automation of prepared.automations) {
          await apiImportAutomation(automation);
          saved += 1;
        }
      } catch (err) {
        const failed = prepared.automations[saved].name;
        throw new Error(
          `"${failed}" could not be saved (${errorMessage(err)}). ` +
            `Imported ${saved} of ${prepared.automations.length}.`
        );
      } finally {
        await get().loadAutomations();
      }
      return prepared;
    },

    runReplacePrompt: null,
    resolveRunReplacePrompt: (stop) => {
      const prompt = get().runReplacePrompt;
      set({ runReplacePrompt: null });
      prompt?.resolve(stop);
    },

    runAutomation: async (automationId, options) => {
      const automation = await get().fetchAutomationForRun(automationId);
      if (!automation) {
        toast.error("Automation not found");
        return;
      }
      const targets = options?.targetTabIds;
      const parallel = options?.parallel ?? true;
      const origin = options?.origin;
      if (targets?.length === 0) {
        // Never falls back to the active terminal: it was not what was chosen.
        toast.error("None of the selected terminals are connected");
        return;
      }
      // Refused or still to be asked for values: nothing is stopped yet. The user is
      // asked once, before anything of this run shows.
      const typesKeys = isMacroShaped(automation);
      const where = targets ?? [getActiveTab(get())?.id].filter((id): id is string => !!id);
      const running = runsReplacedBy(get(), typesKeys, where);
      if (running.length > 0) {
        if (get().runReplacePrompt !== null) return;
        const stop = await new Promise<boolean>((resolve) =>
          set({ runReplacePrompt: { name: automation.name, running, resolve } })
        );
        if (!stop) return;
        // Its own kind is replaced when it starts; the other kind stops in those terminals.
        for (const run of running.filter((r) => r.typesKeys !== typesKeys)) {
          if (run.runId) get().cancelWorkflowRun(run.runId);
          else get().cancelMacroPlaybackOnTab(run.tabId);
        }
      }
      if (isMacroShaped(automation)) {
        await get().playMacro(automationId, {
          ...(targets ? { targetTabIds: targets, parallel } : {}),
          ...(origin === "palette" ? { origin } : {}),
        });
        return;
      }
      // One terminal runs as a plain run (its own toast); several fan out.
      await get().runWorkflow(automationId, {
        ...(!targets
          ? {}
          : targets.length === 1
            ? { targetTabId: targets[0] }
            : { targetTabIds: targets, ...(parallel ? {} : { concurrency: 1 }) }),
        ...(origin ? { triggeredBy: origin } : {}),
      });
    },

    duplicateAutomation: async (automationId) => {
      const original = get().automations.find((a) => a.id === automationId);
      if (!original) return;
      const { legacy: _legacy, ...copy } = structuredClone(original);
      const duplicate = {
        ...copy,
        id: newId("automation"),
        name: `Copy of ${original.name}`,
        // The backend stamps authoritative created/updated timestamps.
        createdAt: "",
        updatedAt: "",
      };
      await apiSaveAutomation(duplicate, original.id);
      await get().loadAutomations();
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
