import { useCallback } from "react";
import { useAppStore } from "@/store/appStore";
import { SavedConnection } from "@/types/connection";
import {
  createTerminal,
  removeCredential,
  storeCredential,
  isSshKeyEncrypted,
} from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";
import { resolveConnectionCredential } from "@/utils/resolveConnectionCredential";
import { ensureCredentialStoreUnlocked } from "@/utils/ensureCredentialStoreUnlocked";

/** Return value of {@link useConnectSavedConnection}. */
export interface UseConnectSavedConnection {
  /**
   * Open a terminal tab for a saved connection, resolving credentials from the
   * credential store (and prompting when needed) exactly as the sidebar does.
   */
  connect: (connection: SavedConnection) => Promise<void>;
}

/**
 * Shared saved-connection connect flow.
 *
 * Encapsulates the credential-aware connect path used by the sidebar
 * {@link ConnectionList} — and now the command palette — so the credential
 * logic lives in exactly one place:
 *
 * - Skips credential handling for connections without `authMethod`/`host`
 *   (e.g. local shells) and for non-password/unencrypted-key auth.
 * - For key auth, prompts based on the key's *actual* encryption rather than
 *   the `savePassword` flag (#885).
 * - Treats a non-empty inline password as the credential itself (#963).
 * - Unlocks the credential store before resolving a stored secret (#1144).
 * - Validates a stored credential with a pre-connect and clears it if stale
 *   (#885/#963), otherwise prompts and optionally persists the entered secret.
 *
 * This hook intentionally contains no UI: callers own any surrounding
 * confirmation (e.g. the sidebar's insecure-FTP warning) and render the shared
 * `PasswordPrompt` / `UnlockDialog` that this flow drives through the store.
 */
export function useConnectSavedConnection(): UseConnectSavedConnection {
  const addTab = useAppStore((s) => s.addTab);
  const requestPassword = useAppStore((s) => s.requestPassword);

  const connect = useCallback(
    async (connection: SavedConnection) => {
      let config = connection.config;
      const cfg = config.config as unknown as Record<string, unknown>;

      // Connections with authMethod and password support credential store resolution
      if (cfg.authMethod && cfg.host) {
        const authMethod = cfg.authMethod as string;
        const savePassword = cfg.savePassword as boolean | undefined;

        // For key auth, decide whether a passphrase is needed from the key's
        // actual encryption rather than the savePassword flag (#885): a
        // passphrase-protected key must be unlocked even when savePassword is
        // off, and an unencrypted key must never prompt. If the file can't be
        // read, default to "encrypted" so an encrypted key never fails silently.
        let keyEncrypted = false;
        if (authMethod === "key") {
          keyEncrypted = await isSshKeyEncrypted((cfg.keyPath as string) ?? "").catch(() => true);
        }
        // Password auth always needs a credential; key auth only when encrypted.
        const needsCredential = authMethod === "password" || (authMethod === "key" && keyEncrypted);
        if (!needsCredential) {
          addTab(connection.name, connection.config.type, config, {
            terminalOptions: connection.terminalOptions,
          });
          return;
        }

        // An inline, non-empty password on the config is itself the credential —
        // e.g. an "Open Jump Host Terminal" gateway synthesized from an inline
        // hop, whose password lives on the hop, not in the store (#963). Use it
        // directly: a credential-store lookup here is keyed by this (possibly
        // synthetic) connection id and would miss, forcing a redundant prompt
        // even though the password is already known.
        if (typeof cfg.password === "string" && cfg.password.length > 0) {
          addTab(connection.name, connection.config.type, config, {
            terminalOptions: connection.terminalOptions,
          });
          return;
        }

        // Before attempting credential resolution, check whether the credential store
        // is locked. If it is, we can't read the stored credential and SSH would fall
        // back to interactive password prompts. Prompt for unlock first and wait —
        // on success the code continues and the credential resolves automatically.
        const proceed = await ensureCredentialStoreUnlocked({ authMethod, savePassword });
        if (!proceed) return;

        // Try to resolve credential from the store first
        const resolution = await resolveConnectionCredential(
          connection.id,
          authMethod,
          savePassword
        );

        if (resolution.usedStoredCredential && resolution.password) {
          // Pre-connect with stored credential to validate it
          const preConfig = {
            ...config,
            config: { ...cfg, password: resolution.password },
          } as typeof config;
          try {
            const sessionId = await createTerminal(preConfig);
            // Stored credential worked — open tab with existing session
            addTab(connection.name, connection.config.type, preConfig, {
              terminalOptions: connection.terminalOptions,
              sessionId,
            });
            return;
          } catch (err) {
            const errStr = String(err);
            if (
              errStr.toLowerCase().includes("auth failed") ||
              errStr.includes("Authentication failed")
            ) {
              // Stale credential — remove it and fall through to prompt
              await removeCredential(connection.id, resolution.credentialType).catch(() => {});
            } else {
              // Non-auth failure — let the Terminal component handle the error
              addTab(connection.name, connection.config.type, config, {
                terminalOptions: connection.terminalOptions,
              });
              return;
            }
          }
        }

        // No stored credential or stale credential was cleared — prompt the user
        if (authMethod === "password") {
          const host = cfg.host as string;
          const username = (cfg.username as string) ?? "";
          const password = await requestPassword(host, username);
          if (password === null) return;
          config = { ...config, config: { ...cfg, password } } as typeof config;
          // Persist the entered password if the user opted in via the prompt checkbox
          if (useAppStore.getState().passwordPromptShouldSave) {
            await storeCredential(connection.id, "password", password).catch((err) => {
              frontendLog("connection_list", `Failed to store credential: ${err}`);
            });
          }
        } else if (authMethod === "key") {
          // Key auth with an encrypted key (guaranteed by the needsCredential
          // gate above) and no stored passphrase yet — prompt so the backend can
          // unlock the key, regardless of savePassword (#885). Whether the
          // passphrase is then stored still follows the prompt's Save box.
          const host = cfg.host as string;
          const username = (cfg.username as string) ?? "";
          const passphrase = await requestPassword(host, username);
          if (passphrase === null) return;
          config = { ...config, config: { ...cfg, password: passphrase } } as typeof config;
          if (useAppStore.getState().passwordPromptShouldSave) {
            await storeCredential(connection.id, "key_passphrase", passphrase).catch((err) => {
              frontendLog("connection_list", `Failed to store key passphrase: ${err}`);
            });
          }
        }
      }

      addTab(connection.name, connection.config.type, config, {
        terminalOptions: connection.terminalOptions,
      });
    },
    [addTab, requestPassword]
  );

  return { connect };
}
