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
 * Session-only, like the backend's setup state: nothing is persisted.
 */

import { create } from "zustand";

/** What a setup run on an agent's host is doing, as the agent row shows it. */
export type AgentSetupPhase = "installing" | "installed";

interface AgentSetupStatusState {
  /** The setup phase per agent id; absent when no setup ran or it failed. */
  phases: Record<string, AgentSetupPhase>;
  /** The user started a setup on the agent's host. */
  markInstalling: (agentId: string) => void;
  /** Fold one backend `agent-setup-progress` step into the agent's phase. */
  applyProgress: (agentId: string, step: string) => void;
  /** Forget the agent's setup phase (a new connect, a failed start). */
  clear: (agentId: string) => void;
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

export const useAgentSetupStatus = create<AgentSetupStatusState>((set) => ({
  phases: {},
  markInstalling: (agentId) => set((s) => ({ phases: withPhase(s.phases, agentId, "installing") })),
  applyProgress: (agentId, step) =>
    set((s) => ({ phases: withPhase(s.phases, agentId, setupPhaseAfterStep(step)) })),
  clear: (agentId) => set((s) => ({ phases: withPhase(s.phases, agentId, null) })),
}));
