/**
 * Connect-time secret of a VNC/RDP connection tunnelled through an agent
 * (#3803).
 *
 * Such a connection is saved on the agent host, but it runs on this computer,
 * so its password never belongs on the agent: the backend strips it from the
 * agent-side definition and keeps it (when the user opts in) in this
 * computer's credential store under {@link agentGraphicalCredentialId}. The
 * connect-time lookup is the shared remote-desktop flow,
 * {@link resolveGraphicalSettings}.
 */
import {
  resolveGraphicalSettings,
  type GraphicalSettingsResult,
  type RequestPassword,
} from "@/utils/graphicalSecret";

/**
 * Credential-store id of the password of definition `definitionId` on agent
 * `agentId` — the backend's `agent_graphical_secrets::owner_id`.
 */
export function agentGraphicalCredentialId(agentId: string, definitionId: string): string {
  return `agent-graphical:${agentId}:${definitionId}`;
}

/** Outcome of {@link resolveAgentGraphicalSettings}. */
export type AgentGraphicalSettingsResult = GraphicalSettingsResult;

export interface ResolveAgentGraphicalSettingsOptions {
  agentId: string;
  /** The saved definition's id, or `null` when it has none yet. */
  definitionId: string | null;
  /** The definition's settings. Never mutated. */
  settings: Record<string, unknown>;
  /** The store's promise-based prompt (`useAppStore().requestPassword`). */
  requestPassword: RequestPassword;
  /** The definition's name, shown in the prompt title (#4475). */
  label?: string;
}

/**
 * The settings to connect with: `settings` plus the password, taken from the
 * form, the desktop credential store or a prompt.
 */
export function resolveAgentGraphicalSettings({
  agentId,
  definitionId,
  settings,
  requestPassword,
  label,
}: ResolveAgentGraphicalSettingsOptions): Promise<AgentGraphicalSettingsResult> {
  return resolveGraphicalSettings({
    credentialId: definitionId === null ? null : agentGraphicalCredentialId(agentId, definitionId),
    settings,
    requestPassword,
    ...(label ? { label } : {}),
  });
}
