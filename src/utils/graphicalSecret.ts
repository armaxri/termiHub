/**
 * Connect-time password of a VNC/RDP connection (#3803, #3818).
 *
 * A remote-desktop connection runs on this computer, and its saved password
 * lives only in this computer's credential store — never in
 * `connections.json` and never on an agent host. At connect time the password
 * is taken from the settings (a form's Save & Connect), else from the
 * credential store, else prompted for, with the prompt's Save box writing it
 * to the same store entry.
 *
 * The secret only ever goes into the in-memory tab config handed to this
 * computer's remote-desktop backend; it is never logged.
 */
import { resolveCredential, storeCredential } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { PasswordPromptKind, PasswordPromptOptions } from "@/store/slices/passwordPromptSlice";
import { ensureCredentialStoreUnlocked } from "@/utils/ensureCredentialStoreUnlocked";
import { frontendLog } from "@/utils/frontendLog";

/** Outcome of {@link resolveGraphicalSettings}. */
export type GraphicalSettingsResult =
  | { status: "resolved"; settings: Record<string, unknown> }
  | { status: "canceled" };

/** The store's promise-based prompt (`useAppStore().requestPassword`). */
export type RequestPassword = (
  host: string,
  username: string,
  notice?: string,
  kind?: PasswordPromptKind,
  options?: PasswordPromptOptions
) => Promise<string | null>;

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
}: ResolveGraphicalSettingsOptions): Promise<GraphicalSettingsResult> {
  if (readString(settings, "password").length > 0) {
    return { status: "resolved", settings };
  }
  const withPassword = (password: string): GraphicalSettingsResult => ({
    status: "resolved",
    settings: { ...settings, password },
  });
  const host = readString(settings, "host");
  const username = readString(settings, "username");

  // Without an id there is no stored secret, and a prompted one could not be
  // stored either.
  if (credentialId === null) {
    const entered = await requestPassword(host, username, "", "password", { allowSave: false });
    return entered === null ? { status: "canceled" } : withPassword(entered);
  }

  // A locked master-password store must be unlocked before the lookup (#1144).
  if (!(await ensureCredentialStoreUnlocked({ authMethod: "password" }))) {
    return { status: "canceled" };
  }
  const stored = await resolveCredential(credentialId, "password", sourceFile).catch(() => null);
  if (stored) return withPassword(stored);

  const entered = await requestPassword(host, username, "", "password");
  if (entered === null) return { status: "canceled" };
  if (entered && useAppStore.getState().passwordPromptShouldSave) {
    await storeCredential(credentialId, "password", entered, sourceFile).catch((err) =>
      frontendLog("graphical_secret", `Failed to store remote-desktop password: ${err}`)
    );
  }
  return withPassword(entered);
}
