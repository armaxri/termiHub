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
 * when the setup is over. A failure or a cancel comes from the progress events.
 * A finished POSIX setup is reported by the exit code of the shell its script
 * replaced (`exec`). A Windows setup is never judged by an exit code: Windows
 * reports 0 for a failed one too. Its backend checks the host after the shell
 * ended and sends `installed`, `failed` or `unknown` (#5992).
 *
 * Session-only, like the backend's setup state: nothing is persisted.
 */

import { create } from "zustand";

/**
 * What a setup run on an agent's host is doing, as the agent row shows it.
 * `unknown`: it ended, but its outcome could not be checked (#5992).
 */
export type AgentSetupPhase = "installing" | "installed" | "unknown";

/**
 * Where a setup tab's run stands, as the progress events tell it (#5865).
 * `running`: still going, or waiting for the outcome; `installed` / `failed` /
 * `unknown`: what the backend found out (`failed` also before the install, with
 * any host); `cancelled`: the user cancelled it.
 */
export type AgentSetupTabProgress =
  | { kind: "running" }
  | { kind: "installed" }
  | { kind: "failed"; message: string }
  | { kind: "unknown"; message: string }
  | { kind: "cancelled" };

/** One setup run's terminal tab (#5865). */
export interface AgentSetupTab {
  agentId: string;
  agentName: string;
  /** The setup's terminal session, when known: its events reach no other tab. */
  sessionId?: string;
  /**
   * The exit code of the tab's session is the setup's result (POSIX: the
   * script replaced the shell). `false` on Windows, where 0 says nothing and
   * the backend checks the host instead (#5992).
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
   * into its running setup tab, if any. A step with a `sessionId` belongs to
   * that run: it changes nothing once another run's tab is the agent's newest.
   */
  applyProgress: (
    agentId: string,
    step: string,
    message?: string,
    sessionId?: string | null
  ) => void;
  /** Forget the agent's setup phase (a new connect, a failed start). */
  clear: (agentId: string) => void;
  /** Record the terminal tab a setup run opened (#5865). */
  registerSetupTab: (
    tabId: string,
    tab: { agentId: string; agentName: string; sessionId?: string; reportsExit: boolean }
  ) => void;
  /** Hide the setup strip of a tab (the user dismissed it). */
  dismissSetupTab: (tabId: string) => void;
}

/** The phase a setup progress `step` leaves the agent in (`null`: none). */
export function setupPhaseAfterStep(step: string): AgentSetupPhase | null {
  if (step === "done" || step === "installed") return "installed";
  if (step === "unknown") return "unknown";
  // "ended": a POSIX setup that did not install; its tab says why (#5518).
  if (step === "error" || step === "failed" || step === "cancelled" || step === "ended") {
    return null;
  }
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
 * moves: once it failed, was cancelled or has its outcome, a late or repeated
 * event (the dialog and the app-wide listener both fold each one)
 * changes nothing.
 */
export function setupTabProgressAfterStep(
  tab: AgentSetupTab,
  step: string,
  message = ""
): AgentSetupTabProgress {
  if (tab.progress.kind !== "running") return tab.progress;
  if (step === "error" || step === "failed") return { kind: "failed", message };
  if (step === "cancelled") return { kind: "cancelled" };
  if (step === "installed") return { kind: "installed" };
  if (step === "unknown") return { kind: "unknown", message };
  // "done" (POSIX) and "sent" (Windows) only mean the install was started.
  return tab.progress;
}

function withTabProgress(
  tabs: Record<string, AgentSetupTab>,
  agentId: string,
  step: string,
  message: string | undefined,
  sessionId: string | null | undefined
): Record<string, AgentSetupTab> {
  let next = tabs;
  for (const [tabId, tab] of Object.entries(tabs)) {
    if (tab.agentId !== agentId || isOtherRun(tab, sessionId)) continue;
    const progress = setupTabProgressAfterStep(tab, step, message);
    if (progress === tab.progress) continue;
    if (next === tabs) next = { ...tabs };
    next[tabId] = { ...tab, progress };
  }
  return next;
}

/** Whether a step of `sessionId`'s run is not about `tab`'s run. */
function isOtherRun(tab: AgentSetupTab, sessionId: string | null | undefined): boolean {
  return !!sessionId && !!tab.sessionId && tab.sessionId !== sessionId;
}

/** Whether the agent's newest setup tab belongs to another run than `sessionId`'s. */
function isSuperseded(
  tabs: Record<string, AgentSetupTab>,
  agentId: string,
  sessionId: string | null | undefined
): boolean {
  const newest = Object.values(tabs)
    .filter((tab) => tab.agentId === agentId)
    .pop();
  return !!newest && isOtherRun(newest, sessionId);
}

export const useAgentSetupStatus = create<AgentSetupStatusState>((set) => ({
  phases: {},
  tabs: {},
  markInstalling: (agentId) => set((s) => ({ phases: withPhase(s.phases, agentId, "installing") })),
  applyProgress: (agentId, step, message, sessionId) =>
    set((s) => ({
      phases: isSuperseded(s.tabs, agentId, sessionId)
        ? s.phases
        : withPhase(s.phases, agentId, setupPhaseAfterStep(step)),
      tabs: withTabProgress(s.tabs, agentId, step, message, sessionId),
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
