/**
 * Connect-time secret of a VNC/RDP connection tunnelled through an agent
 * (#3803).
 *
 * Such a connection is saved on the agent host, but it runs on this computer,
 * so its password never belongs on the agent: the backend strips it from the
 * agent-side definition and keeps it (when the user opts in) in this
 * computer's credential store under {@link agentGraphicalCredentialId}. At
 * connect time the password is taken from the form (Save & Connect), else from
 * the credential store, else prompted for — with the prompt's Save box writing
 * it to the same store entry.
 *
 * The secret only ever goes into the in-memory tab config handed to this
 * computer's remote-desktop backend; it is never logged.
 */
import { resolveCredential, storeCredential } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { PasswordPromptKind, PasswordPromptOptions } from "@/store/slices/passwordPromptSlice";
import { ensureCredentialStoreUnlocked } from "@/utils/ensureCredentialStoreUnlocked";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Credential-store id of the password of definition `definitionId` on agent
 * `agentId` — the backend's `agent_graphical_secrets::owner_id`.
 */
export function agentGraphicalCredentialId(agentId: string, definitionId: string): string {
  return `agent-graphical:${agentId}:${definitionId}`;
}

/** Outcome of {@link resolveAgentGraphicalSettings}. */
export type AgentGraphicalSettingsResult =
  | { status: "resolved"; settings: Record<string, unknown> }
  | { status: "canceled" };

export interface ResolveAgentGraphicalSettingsOptions {
  agentId: string;
  /** The saved definition's id, or `null` when it has none yet. */
  definitionId: string | null;
  /** The definition's settings. Never mutated. */
  settings: Record<string, unknown>;
  /** The store's promise-based prompt (`useAppStore().requestPassword`). */
  requestPassword: (
    host: string,
    username: string,
    notice?: string,
    kind?: PasswordPromptKind,
    options?: PasswordPromptOptions
  ) => Promise<string | null>;
}

function readString(settings: Record<string, unknown>, key: string): string {
  const value = settings[key];
  return typeof value === "string" ? value : "";
}

/**
 * The settings to connect with: `settings` plus the password, taken from the
 * form, the desktop credential store or a prompt (see the module docs).
 */
export async function resolveAgentGraphicalSettings({
  agentId,
  definitionId,
  settings,
  requestPassword,
}: ResolveAgentGraphicalSettingsOptions): Promise<AgentGraphicalSettingsResult> {
  if (readString(settings, "password").length > 0) {
    return { status: "resolved", settings };
  }
  const withPassword = (password: string): AgentGraphicalSettingsResult => ({
    status: "resolved",
    settings: { ...settings, password },
  });
  const host = readString(settings, "host");
  const username = readString(settings, "username");

  // A definition without an id cannot have a stored secret, and a prompted
  // one could not be stored under it either.
  if (definitionId === null) {
    const entered = await requestPassword(host, username, "", "password", { allowSave: false });
    return entered === null ? { status: "canceled" } : withPassword(entered);
  }

  const credentialId = agentGraphicalCredentialId(agentId, definitionId);
  // A locked master-password store must be unlocked before the lookup (#1144).
  if (!(await ensureCredentialStoreUnlocked({ authMethod: "password" }))) {
    return { status: "canceled" };
  }
  const stored = await resolveCredential(credentialId, "password", null).catch(() => null);
  if (stored) return withPassword(stored);

  const entered = await requestPassword(host, username, "", "password");
  if (entered === null) return { status: "canceled" };
  if (entered && useAppStore.getState().passwordPromptShouldSave) {
    await storeCredential(credentialId, "password", entered, null).catch((err) =>
      frontendLog("agent_graphical", `Failed to store remote-desktop password: ${err}`)
    );
  }
  return withPassword(entered);
}
