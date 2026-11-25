/**
 * Connect a remote agent the way a user asks for it: unlock the credential store
 * when it holds the password, ask for the password when there is none, and ask
 * again when the saved one was rejected. Used by the agent's row and by every
 * "Connect agent" elsewhere (#6063).
 */
import { storeCredential } from "@/services/api";
import type { RequestPassword } from "@/store/slices/passwordPromptSlice";
import type { RemoteAgentDefinition } from "@/types/connection";
import { isAuthFailure } from "@/utils/backendErrorCode";
import { saveAfterStorageChoice } from "@/utils/credentialStorageChoice";
import { ensureCredentialStoreUnlocked } from "@/utils/ensureCredentialStoreUnlocked";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { resolveConnectionCredential } from "@/utils/resolveConnectionCredential";

export interface ConnectAgentDeps {
  requestPassword: RequestPassword;
  connectRemoteAgent: (agentId: string, password?: string) => Promise<void>;
  /** The store is usable and the attempt begins. */
  onAttempt?: () => void;
}

/** Keep the password the user typed, when the user chose to. */
async function keepPassword(agentId: string, typed: string): Promise<void> {
  // No storage chosen yet: ask where now that it connected (#5867).
  await saveAfterStorageChoice(() => storeCredential(agentId, "password", typed)).catch((err) => {
    frontendLog("agent_node", `Failed to store credential: ${errorMessage(err)}`);
  });
}

/**
 * Connect `agent`. Resolves `true` when it connected and `false` when the user
 * declined to unlock or to give a password; rejects when connecting failed.
 */
export async function connectAgentWithCredentials(
  agent: RemoteAgentDefinition,
  { requestPassword, connectRemoteAgent, onAttempt }: ConnectAgentDeps
): Promise<boolean> {
  const { config } = agent;
  // Unlock first: on success the stored credential resolves below.
  const proceed = await ensureCredentialStoreUnlocked({
    authMethod: config.authMethod,
    savePassword: config.savePassword,
    credentialRef: config.credentialRef,
  });
  if (!proceed) return false;
  onAttempt?.();

  const resolution = await resolveConnectionCredential(
    agent.id,
    config.authMethod,
    config.savePassword,
    config.credentialRef
  );
  // A shared credential (#3557) is never deleted on rejection nor replaced by a
  // per-agent secret.
  const sharedCredential = resolution.namedCredentialId !== undefined;
  // The agent's name titles each prompt, so a queued prompt says which agent it
  // is for (#4475).
  const promptLabel = { label: agent.name };

  let password: string | undefined;
  // The prompt's own answer carries its Save choice (#4474), so the connect
  // awaited in between can never pick up another prompt's choice.
  let keep = false;
  if (resolution.usedStoredCredential && resolution.password) {
    password = resolution.password;
  } else if (config.authMethod === "password" && !config.password) {
    const answer = await requestPassword(config.host, config.username, "", "password", promptLabel);
    if (!answer || !answer.password) return false;
    password = answer.password;
    keep = answer.shouldSave && !sharedCredential;
  }

  try {
    await connectRemoteAgent(agent.id, password);
  } catch (err) {
    // Gate the stored-credential replacement on the typed, locale-independent
    // auth signal (I18N-001), never on the English text of an error.
    if (!resolution.usedStoredCredential || !isAuthFailure(err)) throw err;
    // The saved password is KEPT (#5156): a rejection can be transient, so only
    // the user replaces it, and only after the retry connects.
    const retry = sharedCredential
      ? await requestPassword(
          config.host,
          config.username,
          "The shared credential was rejected — enter it for this connect, or rotate it in Settings → Security.",
          "password",
          { allowSave: false, ...promptLabel }
        )
      : await requestPassword(
          config.host,
          config.username,
          "The saved password was rejected. It is kept — enter the password to connect.",
          "password",
          { savedRejected: true, ...promptLabel }
        );
    if (!retry || !retry.password) return false;
    await connectRemoteAgent(agent.id, retry.password);
    if (!sharedCredential && retry.shouldSave) await keepPassword(agent.id, retry.password);
    return true;
  }
  if (keep && password !== undefined) await keepPassword(agent.id, password);
  return true;
}
