import { create } from "zustand";
import { useAppStore } from "@/store/appStore";

/**
 * Which sections under the automation list are open, and what the history is
 * narrowed to (#5818, slice 6). Kept in memory for the app session only
 * (termiHub keeps no UI state in browser storage). Both start closed, so the
 * list of automations gets the sidebar's height; whatever leads the user to a
 * section (a row's "Recent runs", the status bar's schedules, a saved schedule)
 * opens it.
 */
export interface AutomationSectionsState {
  /** Whether the Schedules section is open. */
  schedulesOpen: boolean;
  /** Whether the History section is open. */
  historyOpen: boolean;
  /** The automation the history is narrowed to; `null` shows every run. */
  historyAutomationId: string | null;
  /** Open or close the Schedules section. */
  setSchedulesOpen: (open: boolean) => void;
  /** Open or close the History section. */
  setHistoryOpen: (open: boolean) => void;
  /** Narrow the history to one automation, or `null` for every run. */
  setHistoryAutomationId: (automationId: string | null) => void;
  /** Open the History section on one automation's runs. */
  showHistoryOf: (automationId: string) => void;
}

/** The session-only state of the Automations sidebar's sections. */
export const useAutomationSections = create<AutomationSectionsState>((set) => ({
  schedulesOpen: false,
  historyOpen: false,
  historyAutomationId: null,
  setSchedulesOpen: (schedulesOpen) => set({ schedulesOpen }),
  setHistoryOpen: (historyOpen) => set({ historyOpen }),
  setHistoryAutomationId: (historyAutomationId) => set({ historyAutomationId }),
  showHistoryOf: (historyAutomationId) => set({ historyOpen: true, historyAutomationId }),
}));

/**
 * Show the Automations view with its Schedules section open. Selecting the view
 * that already shows would close the sidebar, so that case leaves it alone.
 */
export function showSchedulesInSidebar(): void {
  useAutomationSections.getState().setSchedulesOpen(true);
  const { sidebarView, sidebarCollapsed, setSidebarView } = useAppStore.getState();
  if (sidebarView !== "automations" || sidebarCollapsed) setSidebarView("automations");
}
