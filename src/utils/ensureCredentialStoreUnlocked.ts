/**
 * Shared credential-store unlock gate.
 *
 * Every connect path that may resolve a stored credential must first ensure the
 * credential store is unlocked. Before this helper the same check was duplicated
 * across four call sites (sidebar `ConnectionList`, `AgentNode`, `AgentErrorTab`,
 * workspace launch) and was missing entirely on `ConnectionEditor`'s
 * "Save & Connect" path — see the credential-store audit gaps G1/G2/G3 (#1144).
 *
 * Centralising the gate guarantees the check runs *before* `resolveCredential`,
 * so the unlock dialog is the primary trigger rather than the after-the-fact
 * `credential-store-unlock-needed` event (G2).
 */

import { useAppStore } from "@/store/appStore";
import { frontendLog } from "@/utils/frontendLog";

/** Inputs the gate needs to decide whether a stored credential is involved. */
export interface UnlockGateOptions {
  /** The connection's auth method (`"password"`, `"key"`, `"agent"`, …). */
  authMethod: string;
  /** Whether the connection persists its secret (only meaningful for key auth). */
  savePassword?: boolean;
}

/**
 * Whether the given auth method resolves a secret from the credential store.
 *
 * - `password` auth always reads a stored password.
 * - `key` auth only reads a stored passphrase when `savePassword` is set.
 * - Everything else (agent auth, key without savePassword) needs no stored secret.
 */
function needsStoredCredential({ authMethod, savePassword }: UnlockGateOptions): boolean {
  return authMethod === "password" || (authMethod === "key" && Boolean(savePassword));
}

/**
 * Ensure the credential store is unlocked before a connect resolves its stored
 * credential.
 *
 * When the store is in `master_password` mode and `locked`, and the auth method
 * needs a stored secret, this opens the unlock dialog via `requestUnlock()` and
 * awaits the outcome. In every other case it is a no-op that returns `true`.
 *
 * @returns `true` when the caller should proceed (store not locked, no stored
 *   credential involved, or the user successfully unlocked); `false` when the
 *   user dismissed the unlock dialog and the connect should abort.
 */
export async function ensureCredentialStoreUnlocked(opts: UnlockGateOptions): Promise<boolean> {
  if (!needsStoredCredential(opts)) {
    return true;
  }

  const { credentialStoreStatus, requestUnlock } = useAppStore.getState();
  if (
    credentialStoreStatus?.mode === "master_password" &&
    credentialStoreStatus?.status === "locked"
  ) {
    frontendLog("credential", "connect gate: store locked, requesting unlock before resolve");
    const unlocked = await requestUnlock();
    if (!unlocked) {
      frontendLog("credential", "connect gate: unlock dismissed, aborting connect");
      return false;
    }
  }

  return true;
}
