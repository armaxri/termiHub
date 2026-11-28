/**
 * Why an agent's last connect failed, as its row says it (#6160): one short
 * sentence and the next steps, like a Services row's reason line. The one
 * place for this wording, so the connection-state copy (#6159) can reuse it.
 */
import type { AgentErrorCategory, ClassifiedAgentError } from "@/utils/classifyAgentError";

/** A next step the reason row offers. */
export type AgentFailureStepId = "edit" | "setup" | "update" | "force-reconnect" | "details";

/** A next step and its label. */
export interface AgentFailureStep {
  id: AgentFailureStepId;
  label: string;
}

/** What the row says about a failed connect. */
export interface AgentFailureReason {
  /** One sentence, readable without hovering. */
  text: string;
  /** What helps, in the order shown; Details (the full error) is always last. */
  steps: AgentFailureStep[];
}

const STEP_LABELS: Record<AgentFailureStepId, string> = {
  edit: "Edit connection",
  setup: "Set up agent",
  update: "Update agent",
  "force-reconnect": "Force reconnect",
  details: "Details",
};

/** The sentence and the step that helps, per kind of failure; `null`: its own message. */
const BY_CATEGORY: Record<
  AgentErrorCategory,
  { text: (host: string) => string; step: AgentFailureStepId | null } | null
> = {
  unreachable: { text: (host) => `Could not reach ${host}.`, step: "edit" },
  "auth-failure": { text: (host) => `${host} refused the sign-in.`, step: "edit" },
  "second-factor-failure": {
    text: () => "The verification code was not accepted.",
    step: null,
  },
  "agent-missing": {
    text: (host) => `The termiHub agent is not installed on ${host}.`,
    step: "setup",
  },
  "agent-outdated": {
    text: (host) => `The agent on ${host} does not work with this termiHub.`,
    step: "update",
  },
  "already-connected": {
    text: () => "Another termiHub window or app is connected to this agent.",
    step: "force-reconnect",
  },
  unknown: null,
};

/** Why the connect to the agent on `host` failed, as its row says it. */
export function agentFailureReason(error: ClassifiedAgentError, host: string): AgentFailureReason {
  const known = BY_CATEGORY[error.category];
  const ids: AgentFailureStepId[] = known?.step ? [known.step, "details"] : ["details"];
  return {
    text: known ? known.text(host) : error.rawError || error.message,
    steps: ids.map((id) => ({ id, label: STEP_LABELS[id] })),
  };
}
