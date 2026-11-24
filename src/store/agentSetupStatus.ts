/**
 * Per-agent setup status for the agent rows (#5906).
 *
 * The setup wizard installs the agent over its own SSH session, outside the
 * agent connection, so the agent's `connectionState` and `lastError` say
 * nothing about it: right after the failed connect that offered "Set up
 * agent", the row would keep its failure look while the install runs and
 * after it succeeded. This store records what the setup is doing, from the
 * moment the user starts it (the wizard) and from the backend's
 * `agent-setup-progress` events (an app-wide listener), so the row can say
 * "Installing…" and then fall back to a plain "Connect".
 *
 * It also records the setup's own terminal tab (#5865), so the tab can say
 * when the setup is over: failed or cancelled (from the progress events), or
 * finished, which a setup reports through the exit code of the shell it ends:
 * the POSIX setup script runs with `exec`, and the Windows install commands
 * end with `exit` and the install's status (#5946).
 *
 * Session-only, like the backend's setup state: nothing is persisted.
 */

import { create } from "zustand";

/** What a setup run on an agent's host is doing, as the agent row shows it. */
export type AgentSetupPhase = "installing" | "installed";

/**
 * Where a setup tab's run stands, as the progress events tell it (#5865).
 * `running`: still going, or (POSIX) waiting for the script's exit; `sent`:
 * the Windows install commands were typed into the tab, which cannot report
 * their result; `failed` / `cancelled`: the backend gave up or was cancelled.
 */
export type AgentSetupTabProgress =
  | { kind: "running" }
  | { kind: "sent" }
  | { kind: "failed"; message: string }
  | { kind: "cancelled" };

/** One setup run's terminal tab (#5865). */
export interface AgentSetupTab {
  agentId: string;
  agentName: string;
  /**
   * The run ends the tab's shell with the setup's exit code (POSIX `exec`,
   * Windows `exit`, #5946), so the session's exit says whether the agent was
   * installed. `false` falls back to "the commands were sent".
   */
  reportsExit: boolean;
  progress: AgentSetupTabProgress;
  /** The user dismissed the tab's setup strip. */
  dismissed: boolean;
}

interface AgentSetupStatusState {
  /** The setup phase per agent id; absent when no setup ran or it failed. */
  phases: Record<string, AgentSetupPhase>;
  /** The setup terminal tabs, by tab id (#5865). */
  tabs: Record<string, AgentSetupTab>;
  /** The user started a setup on the agent's host. */
  markInstalling: (agentId: string) => void;
  /**
   * Fold one backend `agent-setup-progress` step into the agent's phase and
   * into its running setup tab, if any.
   */
  applyProgress: (agentId: string, step: string, message?: string) => void;
  /** Forget the agent's setup phase (a new connect, a failed start). */
  clear: (agentId: string) => void;
  /** Record the terminal tab a setup run opened (#5865). */
  registerSetupTab: (
    tabId: string,
    tab: { agentId: string; agentName: string; reportsExit: boolean }
  ) => void;
  /** Hide the setup strip of a tab (the user dismissed it). */
  dismissSetupTab: (tabId: string) => void;
}

/** The phase a setup progress `step` leaves the agent in (`null`: none). */
export function setupPhaseAfterStep(step: string): AgentSetupPhase | null {
  if (step === "done") return "installed";
  if (step === "error" || step === "cancelled") return null;
  return "installing";
}

function withPhase(
  phases: Record<string, AgentSetupPhase>,
  agentId: string,
  phase: AgentSetupPhase | null
): Record<string, AgentSetupPhase> {
  if (phase === null) {
    if (!(agentId in phases)) return phases;
    const next = { ...phases };
    delete next[agentId];
    return next;
  }
  return phases[agentId] === phase ? phases : { ...phases, [agentId]: phase };
}

/**
 * The progress a setup tab is left in after `step` (#5865). Only a running tab
 * moves: once it failed, was cancelled or sent its commands, a late or
 * repeated event (the dialog and the app-wide listener both fold each one)
 * changes nothing.
 */
export function setupTabProgressAfterStep(
  tab: AgentSetupTab,
  step: string,
  message = ""
): AgentSetupTabProgress {
  if (tab.progress.kind !== "running") return tab.progress;
  if (step === "error") return { kind: "failed", message };
  if (step === "cancelled") return { kind: "cancelled" };
  // A reporting run's "done" only means the commands started: its exit says more.
  if (step === "done" && !tab.reportsExit) return { kind: "sent" };
  return tab.progress;
}

function withTabProgress(
  tabs: Record<string, AgentSetupTab>,
  agentId: string,
  step: string,
  message: string | undefined
): Record<string, AgentSetupTab> {
  let next = tabs;
  for (const [tabId, tab] of Object.entries(tabs)) {
    if (tab.agentId !== agentId) continue;
    const progress = setupTabProgressAfterStep(tab, step, message);
    if (progress === tab.progress) continue;
    if (next === tabs) next = { ...tabs };
    next[tabId] = { ...tab, progress };
  }
  return next;
}

export const useAgentSetupStatus = create<AgentSetupStatusState>((set) => ({
  phases: {},
  tabs: {},
  markInstalling: (agentId) => set((s) => ({ phases: withPhase(s.phases, agentId, "installing") })),
  applyProgress: (agentId, step, message) =>
    set((s) => ({
      phases: withPhase(s.phases, agentId, setupPhaseAfterStep(step)),
      tabs: withTabProgress(s.tabs, agentId, step, message),
    })),
  clear: (agentId) => set((s) => ({ phases: withPhase(s.phases, agentId, null) })),
  registerSetupTab: (tabId, tab) =>
    set((s) => ({
      tabs: { ...s.tabs, [tabId]: { ...tab, progress: { kind: "running" }, dismissed: false } },
    })),
  dismissSetupTab: (tabId) =>
    set((s) => {
      const tab = s.tabs[tabId];
      if (!tab || tab.dismissed) return s;
      return { tabs: { ...s.tabs, [tabId]: { ...tab, dismissed: true } } };
    }),
}));
