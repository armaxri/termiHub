/**
 * Shared connect-time secret resolution for the connection editor.
 *
 * Both **Save & Connect** and **Test** (UX-007, #3284) need the same answer to
 * "does this connection need a password / key passphrase that is not in the
 * live form, and if so, what is it?". The lookup order is:
 *
 * 1. Decide whether a secret is needed from the schema: a visible, empty
 *    password field (password auth) or an encrypted key (key auth — an
 *    unreadable key file counts as encrypted so it never fails silently, #885).
 * 2. When the connection has a persisted id, pass the credential-store unlock
 *    gate (#1144) and try the stored credential.
 * 3. Otherwise prompt via `requestPassword`.
 *
 * This helper **never persists anything**: it does not store a prompt-entered
 * secret (Save & Connect does that itself when the prompt's Save box is
 * checked) and never logs the secret. Callers splice the returned secret into
 * an in-memory connect/probe config only.
 */

import { isSshKeyEncrypted } from "@/services/api";
import type { SettingsSchema } from "@/types/schema";
import type { PasswordPromptKind } from "@/store/slices/passwordPromptSlice";
import { ensureCredentialStoreUnlocked } from "@/utils/ensureCredentialStoreUnlocked";
import { resolveConnectionCredential } from "@/utils/resolveConnectionCredential";
import { findKeyPassphrasePromptInfo, findPasswordPromptInfo } from "@/utils/schemaDefaults";

/** Outcome of {@link resolveConnectSecret}. */
export type ConnectSecretResult =
  /** The live config already carries everything needed — nothing to resolve. */
  | { status: "none" }
  /** A secret was resolved; splice it into the config under `passwordKey`. */
  | {
      status: "resolved";
      passwordKey: string;
      secret: string;
      /** Whether it came from the credential store or an interactive prompt. */
      source: "stored" | "prompt";
      credentialType: PasswordPromptKind;
    }
  /** The user dismissed the unlock dialog or the password prompt. */
  | { status: "canceled" };

export interface ResolveConnectSecretOptions {
  /** The schema driving the form (connection type's schema, or the agent schema). */
  schema: SettingsSchema | undefined;
  /** The live form settings. Never mutated. */
  settings: Record<string, unknown>;
  /**
   * The persisted id that keys the credential store, or `null` for a
   * connection with no saved record (create flow) — then no stored credential
   * can exist, so the store is skipped and the user is prompted directly.
   */
  connectionId: string | null;
  /** The store's promise-based prompt (`useAppStore().requestPassword`). */
  requestPassword: (
    host: string,
    username: string,
    notice?: string,
    kind?: PasswordPromptKind
  ) => Promise<string | null>;
}

/**
 * Resolve the password / key passphrase a connect or test needs but the live
 * form does not carry. See the module docs for the lookup order.
 */
export async function resolveConnectSecret({
  schema,
  settings,
  connectionId,
  requestPassword,
}: ResolveConnectSecretOptions): Promise<ConnectSecretResult> {
  if (!schema) return { status: "none" };

  // For key auth, prompt based on the key's actual encryption rather than the
  // savePassword flag (#885). If the file can't be read, default to prompting.
  let keyEncrypted = false;
  if (settings.authMethod === "key") {
    keyEncrypted = await isSshKeyEncrypted((settings.keyPath as string) ?? "").catch(() => true);
  }
  const keyPrompt = findKeyPassphrasePromptInfo(schema, settings, keyEncrypted);
  const promptInfo = findPasswordPromptInfo(schema, settings) ?? keyPrompt;
  if (!promptInfo) return { status: "none" };

  const credentialType: PasswordPromptKind = keyPrompt ? "key_passphrase" : "password";
  const host = (settings[promptInfo.hostKey] as string) ?? "";
  const username = (settings[promptInfo.usernameKey] as string) ?? "";
  const authMethod = settings.authMethod as string | undefined;

  if (authMethod && connectionId) {
    const savePassword = settings.savePassword as boolean | undefined;
    // Unlock gate (G3, #1144): a locked master-password store must be unlocked
    // before the stored credential can be read.
    const proceed = await ensureCredentialStoreUnlocked({ authMethod, savePassword });
    if (!proceed) return { status: "canceled" };

    const resolution = await resolveConnectionCredential(connectionId, authMethod, savePassword);
    if (resolution.usedStoredCredential && resolution.password) {
      return {
        status: "resolved",
        passwordKey: promptInfo.passwordKey,
        secret: resolution.password,
        source: "stored",
        credentialType,
      };
    }
  }

  const entered = await requestPassword(host, username, "", credentialType);
  if (entered === null) return { status: "canceled" };
  return {
    status: "resolved",
    passwordKey: promptInfo.passwordKey,
    secret: entered,
    source: "prompt",
    credentialType,
  };
}
