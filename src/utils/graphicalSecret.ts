/**
 * Connect-time password of a VNC/RDP connection (#3803, #3818).
 *
 * A remote-desktop connection runs on this computer, and its saved password
 * lives only in this computer's credential store — never in
 * `connections.json` and never on an agent host. At connect time the password
 * is taken from the settings (a form's Save & Connect), else from the
 * credential store, else prompted for. The prompt's Save box writes it to the
 * same store entry, but only once the connect has succeeded (#5197): the
 * result carries the write as `saveOnceConnected`, and the caller hands it to
 * {@link holdTypedGraphicalSecret} with the tab it opened. A typo is never
 * saved, and a stored password is never deleted here.
 *
 * The secret only ever goes into the in-memory tab config handed to this
 * computer's remote-desktop backend; it is never logged.
 */
import { resolveCredential, storeCredential } from "@/services/api";
import { holdGraphicalSecretUntilConnected } from "@/utils/graphicalSecretOnceConnected";
import type { RequestPassword } from "@/store/slices/passwordPromptSlice";
import { ensureCredentialStoreUnlocked } from "@/utils/ensureCredentialStoreUnlocked";
import { frontendWarn } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";

/** Outcome of {@link resolveGraphicalSettings}. */
export type GraphicalSettingsResult =
  | {
      status: "resolved";
      settings: Record<string, unknown>;
      /**
       * Present when the user typed the password with Save ticked: the store
       * write, to run only once the connect succeeded (see
       * {@link holdTypedGraphicalSecret}). Never run it before.
       */
      saveOnceConnected?: () => Promise<void>;
    }
  | { status: "canceled" };

/**
 * Hold a typed password's store write until the remote-desktop tab `tabId`
 * connects (#5197). A no-op for a result that carries no write.
 */
export function holdTypedGraphicalSecret(tabId: string, result: GraphicalSettingsResult): void {
  if (result.status !== "resolved" || !result.saveOnceConnected) return;
  void holdGraphicalSecretUntilConnected(tabId, result.saveOnceConnected);
}

export type { RequestPassword };

export interface ResolveGraphicalSettingsOptions {
  /**
   * The credential-store id the password is kept under, or `null` when the
   * connection has none yet (then it is prompted for, without a Save box).
   */
  credentialId: string | null;
  /** The external connection file of a saved connection (#3591); else `null`. */
  sourceFile?: string | null;
  /** The connection's settings. Never mutated. */
  settings: Record<string, unknown>;
  requestPassword: RequestPassword;
  /**
   * Connection name for the prompt title, so a queued prompt says which
   * connect it belongs to (#4312, #4475). Omitted keeps the generic title.
   */
  label?: string;
}

function readString(settings: Record<string, unknown>, key: string): string {
  const value = settings[key];
  return typeof value === "string" ? value : "";
}

/**
 * The settings to connect with: `settings` plus the password, taken from the
 * settings, the credential store or a prompt (see the module docs).
 */
export async function resolveGraphicalSettings({
  credentialId,
  sourceFile = null,
  settings,
  requestPassword,
  label,
}: ResolveGraphicalSettingsOptions): Promise<GraphicalSettingsResult> {
  if (readString(settings, "password").length > 0) {
    return { status: "resolved", settings };
  }
  const withPassword = (
    password: string
  ): Extract<GraphicalSettingsResult, { status: "resolved" }> => ({
    status: "resolved",
    settings: { ...settings, password },
  });
  const labelOption = label ? { label } : {};
  const host = readString(settings, "host");
  const username = readString(settings, "username");

  // Without an id there is no stored secret, and a prompted one could not be
  // stored either.
  if (credentialId === null) {
    const answer = await requestPassword(host, username, "", "password", {
      allowSave: false,
      ...labelOption,
    });
    return answer === null ? { status: "canceled" } : withPassword(answer.password);
  }

  // A locked master-password store must be unlocked before the lookup (#1144).
  if (!(await ensureCredentialStoreUnlocked({ authMethod: "password" }))) {
    return { status: "canceled" };
  }
  let stored: string | null = null;
  let notice = "";
  try {
    stored = await resolveCredential(credentialId, "password", sourceFile);
  } catch (err) {
    // Fall back to prompting, but do not make a failed read look like "no
    // saved password": log it and say why the user is asked (#4520).
    frontendWarn(
      "graphical_secret",
      `Failed to read the saved remote-desktop password: ${errorMessage(err)}`
    );
    notice = "The saved password could not be read — enter it for this connection.";
  }
  if (stored) return withPassword(stored);

  const answer = label
    ? await requestPassword(host, username, notice, "password", labelOption)
    : await requestPassword(host, username, notice, "password");
  if (answer === null) return { status: "canceled" };
  const entered = answer.password;
  const result = withPassword(entered);
  if (entered && answer.shouldSave) {
    // Held, not written: a typo must never replace or create the saved entry.
    result.saveOnceConnected = () => storeCredential(credentialId, "password", entered, sourceFile);
  }
  return result;
}
