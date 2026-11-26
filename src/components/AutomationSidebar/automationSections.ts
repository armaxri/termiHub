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
  /**
   * The automation saved last, so its row can be marked (#5687); `seq` tells two
   * saves of the same one apart.
   */
  saved: { id: string; seq: number } | null;
  /** The schedule saved last, marked and scrolled to the same way (#6024). */
  savedSchedule: { id: string; seq: number } | null;
  /**
   * Counts the times the Schedules section was opened from elsewhere (Settings,
   * the status bar), so it marks itself as what changed (#5860, G-009).
   */
  schedulesRevealed: number;
  /** Mark a schedule's row as just saved. */
  markScheduleSaved: (scheduleId: string) => void;
  /** Mark an automation's row as just saved. */
  markSaved: (automationId: string) => void;
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
  saved: null,
  markSaved: (id) => set((s) => ({ saved: { id, seq: (s.saved?.seq ?? 0) + 1 } })),
  savedSchedule: null,
  schedulesRevealed: 0,
  markScheduleSaved: (id) =>
    set((s) => ({ savedSchedule: { id, seq: (s.savedSchedule?.seq ?? 0) + 1 } })),
  // One at a time: the open one needs the room (B-034).
  setSchedulesOpen: (schedulesOpen) =>
    set(schedulesOpen ? { schedulesOpen, historyOpen: false } : { schedulesOpen }),
  setHistoryOpen: (historyOpen) =>
    set(historyOpen ? { historyOpen, schedulesOpen: false } : { historyOpen }),
  setHistoryAutomationId: (historyAutomationId) => set({ historyAutomationId }),
  showHistoryOf: (historyAutomationId) =>
    set({ historyOpen: true, schedulesOpen: false, historyAutomationId }),
}));

/** Show the Automations view with its Schedules section open. */
export function showSchedulesInSidebar(): void {
  useAutomationSections.getState().setSchedulesOpen(true);
  useAutomationSections.setState((s) => ({ schedulesRevealed: s.schedulesRevealed + 1 }));
  showAutomationsView();
}

/** Show the Automations view with the History of one automation open (#6024). */
export function showHistoryInSidebar(automationId: string): void {
  useAutomationSections.getState().showHistoryOf(automationId);
  showAutomationsView();
}

/**
 * Selecting the view that already shows would close the sidebar, so that case
 * leaves it alone.
 */
function showAutomationsView(): void {
  const { sidebarView, sidebarCollapsed, setSidebarView } = useAppStore.getState();
  if (sidebarView !== "automations" || sidebarCollapsed) setSidebarView("automations");
}
