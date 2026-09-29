/**
 * Inline credential re-entry after an authentication rejection (#3089).
 *
 * A tab whose server rejected its credentials lands in the terminal,
 * non-retryable `authFailed` state (SM-005). Retrying would re-send the same
 * rejected secret, so the terminal overlays let the user enter a new one — a
 * password, or a key passphrase and/or a different key file — and reconnect
 * the tab with it, without editing the saved connection first.
 *
 * Saving follows the connect-time password prompt: a ticked "Save" box writes
 * the secret to the credential store under the connection's existing key, the
 * same entry the next connect reads; otherwise it is used for this attempt
 * only. The secret only ever goes into the in-memory tab config and the
 * credential store — it is never logged.
 *
 * Whether re-entry is offered at all is decided structurally by the callers
 * (`authFailed` region status, `auth_failed` spawn-error kind), never by
 * parsing message text (I18N-001).
 */
import { storeCredential } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { currentConnectionsView } from "@/store/connectionsBridge";
import { collectLiveTabs } from "@/store/layoutHelpers";
import type { PasswordPromptKind } from "@/store/slices/passwordPromptSlice";
import type { ConnectionConfig } from "@/types/terminal";
import { ensureCredentialStoreUnlocked } from "@/utils/ensureCredentialStoreUnlocked";
import { frontendError } from "@/utils/frontendLog";

/** The auth methods whose secret the user can re-enter. */
type ReentryAuthMethod = "password" | "key";

/** What the re-entry form offers for one tab. */
export interface CredentialReentryTarget {
  authMethod: ReentryAuthMethod;
  host: string;
  username: string;
  /** The key file the tab connected with (key auth), else `""`. */
  keyPath: string;
  /** The session runs on an agent: its key path is on the agent host. */
  agentHosted: boolean;
  /**
   * The credential-store id a ticked "Save" writes to — the saved connection's
   * id — or `null` when there is no per-connection entry to write: an unsaved
   * tab, an agent-hosted session (its credentials never live in this
   * computer's store) or a shared named credential (rotated in Settings).
   */
  credentialId: string | null;
  /** The initial state of the "Save" box: the connection's `savePassword`. */
  saveDefault: boolean;
}

/** What the user entered in the form. */
export interface CredentialReentryInput {
  /** The password or key passphrase (may be empty for an unencrypted key). */
  secret: string;
  /** The key file to use (key auth only). */
  keyPath?: string;
  /** Whether to write the secret to the credential store. */
  save: boolean;
}

function readString(settings: Record<string, unknown>, key: string): string {
  const value = settings[key];
  return typeof value === "string" ? value : "";
}

/**
 * The re-entry target for a tab's connection config, or `null` when its auth
 * method has no secret to re-enter (SSH agent, keyboard-interactive only, a
 * local shell, …). `connectionId` is the saved connection the tab was opened
 * from, if any.
 */
export function credentialReentryTarget(
  config: ConnectionConfig | undefined,
  connectionId?: string
): CredentialReentryTarget | null {
  if (!config) return null;
  const settings = (config.config ?? {}) as Record<string, unknown>;
  const authMethod = readString(settings, "authMethod");
  if (authMethod !== "password" && authMethod !== "key") return null;

  const agentHosted = config.type === "remote-session";
  const sharedCredential = readString(settings, "credentialRef").trim() !== "";
  return {
    authMethod,
    host: readString(settings, "host"),
    username: readString(settings, "username"),
    keyPath: authMethod === "key" ? readString(settings, "keyPath") : "",
    agentHosted,
    credentialId: agentHosted || sharedCredential ? null : (connectionId ?? null),
    saveDefault: settings.savePassword === true,
  };
}

/** The credential-store type a re-entered secret is kept under. */
function reentryCredentialType(authMethod: ReentryAuthMethod): PasswordPromptKind {
  return authMethod === "key" ? "key_passphrase" : "password";
}

/** Persist a re-entered secret under the connection's credential-store key. */
async function saveReenteredSecret(
  target: CredentialReentryTarget,
  credentialId: string,
  secret: string
): Promise<boolean> {
  // A locked master-password store must be unlocked before it can be written.
  if (
    !(await ensureCredentialStoreUnlocked({ authMethod: target.authMethod, savePassword: true }))
  ) {
    return false;
  }
  const sourceFile =
    currentConnectionsView().connections.find((c) => c.id === credentialId)?.sourceFile ?? null;
  try {
    await storeCredential(
      credentialId,
      reentryCredentialType(target.authMethod),
      secret,
      sourceFile
    );
    return true;
  } catch (err) {
    frontendError("credential_reentry", `Failed to store re-entered credential: ${err}`);
    return false;
  }
}

/**
 * Reconnect `tabId` with the re-entered credential: optionally save it, put it
 * (and a changed key file) into the tab's in-memory config, then start a fresh
 * connect. Resolves `false` when a requested save failed — the reconnect still
 * runs with the credential, used for this attempt only.
 */
export async function reconnectWithReenteredCredentials(
  tabId: string,
  target: CredentialReentryTarget,
  input: CredentialReentryInput
): Promise<boolean> {
  let saved = true;
  if (input.save && target.credentialId !== null && input.secret.length > 0) {
    saved = await saveReenteredSecret(target, target.credentialId, input.secret);
  }

  const store = useAppStore.getState();
  const tab = collectLiveTabs(store).find((t) => t.id === tabId);
  if (!tab) return saved;
  const settings: Record<string, unknown> = { ...(tab.config.config ?? {}) };
  settings.password = input.secret;
  if (target.authMethod === "key" && input.keyPath !== undefined) {
    settings.keyPath = input.keyPath;
  }
  store.setTabConnectionConfig(tabId, { ...tab.config, config: settings } as ConnectionConfig);
  // A fresh create with the new credential — never a re-attach of the failed
  // (or never-started) session.
  store.startFreshShellForTab(tabId);
  return saved;
}
