/**
 * Credential re-entry for password-only, non-terminal tabs (#5377): VNC/RDP
 * remote desktops and FTP file browsers. A rejected password offers the same
 * inline form a terminal tab shows (#3089) instead of a Retry that re-sends the
 * rejected secret.
 *
 * The entered password goes into the tab's in-memory config only. A ticked
 * "Save" (offered for a saved remote-desktop connection, like its connect-time
 * prompt) is held until the reconnect succeeds (#5197), so a typo never
 * replaces the saved entry. The secret is never logged.
 */
import { storeCredential } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { activeTreeTabs } from "@/store/layoutSelectors";
import { currentConnectionsView } from "@/store/connectionsBridge";
import type { ConnectionConfig } from "@/types/terminal";
import type { CredentialReentryInput, CredentialReentryTarget } from "@/utils/credentialReentry";
import { ensureCredentialStoreUnlocked } from "@/utils/ensureCredentialStoreUnlocked";
import { holdGraphicalSecretUntilConnected } from "@/utils/graphicalSecretOnceConnected";
import { toast } from "@/components/ui";
import { t } from "@/i18n/catalog";

function readString(settings: Record<string, unknown>, key: string): string {
  const value = settings[key];
  return typeof value === "string" ? value : "";
}

/**
 * The password re-entry target for a non-terminal tab's config. `credentialId`
 * is set only when `allowSave` and `connectionId` names a saved connection of
 * this computer, so "Save" writes the entry its next connect reads.
 */
export function passwordReentryTarget(
  config: ConnectionConfig | undefined,
  connectionId: string | undefined,
  allowSave: boolean
): CredentialReentryTarget | null {
  if (!config) return null;
  const settings = (config.config ?? {}) as Record<string, unknown>;
  const saved =
    allowSave && connectionId
      ? currentConnectionsView().connections.some((c) => c.id === connectionId)
      : false;
  return {
    authMethod: "password",
    host: readString(settings, "host"),
    username: readString(settings, "username"),
    keyPath: "",
    agentHosted: false,
    credentialId: saved ? (connectionId ?? null) : null,
    saveDefault: settings.savePassword === true,
  };
}

/** Put `password` into the tab's in-memory connection config (never persisted). */
export function setTabPassword(tabId: string, password: string): void {
  const store = useAppStore.getState();
  const tab = activeTreeTabs(store).find((x) => x.id === tabId);
  if (!tab) return;
  const settings: Record<string, unknown> = { ...(tab.config.config ?? {}), password };
  store.setTabConnectionConfig(tabId, { ...tab.config, config: settings } as ConnectionConfig);
}

/**
 * Reconnect a remote-desktop tab with a re-entered password: set it on the
 * tab, hold a requested save until the connect succeeds, then `reconnect()`.
 * Resolves `false` when the save cannot happen (the store unlock was
 * declined); the reconnect still runs with the password.
 */
export async function reconnectGraphicalWithPassword(
  tabId: string,
  target: CredentialReentryTarget,
  input: CredentialReentryInput,
  reconnect: () => void
): Promise<boolean> {
  let saved = true;
  const credentialId = target.credentialId;
  let save = input.save && credentialId !== null && input.secret.length > 0;
  if (
    save &&
    !(await ensureCredentialStoreUnlocked({ authMethod: "password", savePassword: true }))
  ) {
    saved = false;
    save = false;
  }
  setTabPassword(tabId, input.secret);
  if (save && credentialId !== null) {
    const secret = input.secret;
    const sourceFile =
      currentConnectionsView().connections.find((c) => c.id === credentialId)?.sourceFile ?? null;
    void holdGraphicalSecretUntilConnected(tabId, () =>
      storeCredential(credentialId, "password", secret, sourceFile)
    ).then((outcome) => {
      if (outcome === "failed") toast.error(t("credentialReentry.saveFailed"));
    });
  }
  reconnect();
  return saved;
}
