import { useCallback } from "react";
import { useAppStore, type AddTabOptions } from "@/store/appStore";
import { SavedConnection } from "@/types/connection";
import type { ConnectionConfig } from "@/types/terminal";
import {
  createTerminal,
  removeCredential,
  storeCredential,
  isSshKeyEncrypted,
} from "@/services/api";
import { toast } from "@/components/ui";
import { frontendError, frontendLog } from "@/utils/frontendLog";
import { resolveConnectionCredential } from "@/utils/resolveConnectionCredential";
import { ensureCredentialStoreUnlocked } from "@/utils/ensureCredentialStoreUnlocked";
import { isAuthFailure } from "@/utils/backendErrorCode";

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

      // UX-011: the credential-aware path below can run several slow steps —
      // unlock, stored-credential resolve, and a blocking pre-connect SSH
      // handshake — before any tab or overlay appears. Surface a lightweight,
      // non-blocking "Connecting…" indicator during that window so a click is
      // never met with a dead pause. Every exit dismisses it: `openTab` clears
      // it when a tab (and its own connection overlay) takes over the feedback,
      // and the prompt/cancel branches clear it explicitly.
      let connectingToastId: string | number | undefined;
      const dismissConnecting = () => {
        if (connectingToastId !== undefined) {
          toast.dismiss(connectingToastId);
          connectingToastId = undefined;
        }
      };

      // Open a tab for this saved connection, always stamping its `connectionId`
      // so the on-connect workflow trigger (#1855) can match the freshly opened
      // session back to the connection it came from.
      const openTab = (tabConfig: ConnectionConfig, opts: AddTabOptions = {}) => {
        dismissConnecting();
        return addTab(connection.name, connection.config.type, tabConfig, {
          connectionId: connection.id,
          ...opts,
        });
      };

      // A terminal-less connection type (Capabilities.terminal === false, e.g.
      // FTP) opens into a browser-only tab instead of a terminal tab — no xterm,
      // no PTY. The tab still owns a session so the sidebar file browser can route
      // to it. Resolved from the registry capabilities (protocol-agnostic, never a
      // per-type hardcode); an unknown type or absent flag stays terminal (#1335).
      const effectiveTypeId =
        config.type === "remote-session"
          ? ((cfg.sessionType as string | undefined) ?? config.type)
          : config.type;
      const caps = useAppStore
        .getState()
        .connectionTypes.find((ct) => ct.typeId === effectiveTypeId)?.capabilities;
      // A graphical remote-desktop type (Capabilities.graphical === true, e.g.
      // VNC/RDP) opens into a canvas tab routed through the
      // GraphicalSessionManager. A terminal-less type (terminal === false, e.g.
      // FTP) opens into a browser-only tab. Both are decided from the registry
      // capabilities, never a per-type hardcode (#1680 / #1335).
      const isGraphical = caps?.graphical === true;
      const isTerminalLess = caps?.terminal === false;
      const contentType = isGraphical
        ? ("remote-desktop" as const)
        : isTerminalLess
          ? ("file-browser" as const)
          : undefined;

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
          openTab(config, {
            terminalOptions: connection.terminalOptions,
            contentType,
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
          openTab(config, {
            terminalOptions: connection.terminalOptions,
            contentType,
          });
          return;
        }

        // UX-011: from here on the flow runs the genuinely slow steps (unlock,
        // stored-credential resolve, blocking pre-connect handshake). Show the
        // non-blocking connecting indicator now — before any of them — so the
        // pre-tab window is never a silent gap.
        connectingToastId = toast.loading("Connecting…");

        // Before attempting credential resolution, check whether the credential store
        // is locked. If it is, we can't read the stored credential and SSH would fall
        // back to interactive password prompts. Prompt for unlock first and wait —
        // on success the code continues and the credential resolves automatically.
        const proceed = await ensureCredentialStoreUnlocked({ authMethod, savePassword });
        if (!proceed) {
          dismissConnecting();
          return;
        }

        // Try to resolve credential from the store first
        const resolution = await resolveConnectionCredential(
          connection.id,
          authMethod,
          savePassword
        );

        // UX-013: when a stored credential is rejected by the server we clear it
        // and fall through to re-prompt. Carry the reason INTO that re-prompt
        // (as prompt context) rather than firing a separate mid-connect error
        // toast (which the flow deliberately avoids as noise), so the user
        // understands why they are being asked again. Empty until a rejection.
        let rejectedCredentialNotice = "";

        if (resolution.usedStoredCredential && resolution.password) {
          // Pre-connect with stored credential to validate it
          const preConfig = {
            ...config,
            config: { ...cfg, password: resolution.password },
          } as typeof config;
          // A graphical connection is not a terminal session — `createTerminal`
          // would mint one on the terminal SessionManager. Open the canvas tab
          // directly with the resolved credential in its config; the
          // RemoteDesktopTab drives `remote_desktop_connect` itself (#1680).
          if (isGraphical) {
            openTab(preConfig, {
              terminalOptions: connection.terminalOptions,
              contentType,
            });
            return;
          }
          try {
            const sessionId = await createTerminal(preConfig);
            // Stored credential worked — open tab with existing session
            openTab(preConfig, {
              terminalOptions: connection.terminalOptions,
              sessionId,
              contentType,
            });
            return;
          } catch (err) {
            if (isAuthFailure(err)) {
              // Genuine auth rejection (typed, locale-independent signal —
              // I18N-001): the stored credential is stale. Remove it and fall
              // through to prompt. Gating on the typed code, never on English
              // message text, means a localized/reworded backend or remote
              // message can neither destroy a valid credential nor trap the user
              // by failing to clear a genuinely stale one.
              // Log (WA-FE-005) rather than swallow: if clearing the stale
              // credential fails it lingers in the store, so the failure must be
              // auditable. No toast — the flow falls through to re-prompt the
              // user, so a mid-connect error toast would be noise.
              await removeCredential(connection.id, resolution.credentialType).catch((err) => {
                frontendError(
                  "connection_list",
                  `Failed to remove stale ${resolution.credentialType} credential for ${connection.id}: ${err}`
                );
              });
              // Explain the re-prompt: the saved secret was rejected and cleared.
              // Worded per credential kind; surfaced as prompt context (UX-013).
              rejectedCredentialNotice =
                resolution.credentialType === "key_passphrase"
                  ? "Saved passphrase was rejected — please re-enter."
                  : "Saved password was rejected — please re-enter.";
            } else {
              // Non-auth failure — let the Terminal component handle the error
              openTab(config, {
                terminalOptions: connection.terminalOptions,
                contentType,
              });
              return;
            }
          }
        }

        // No stored credential or stale credential was cleared — prompt the user
        if (authMethod === "password") {
          const host = cfg.host as string;
          const username = (cfg.username as string) ?? "";
          // The prompt modal is now the feedback surface — clear the pre-connect
          // indicator before it appears (UX-011).
          dismissConnecting();
          const password = await requestPassword(host, username, rejectedCredentialNotice);
          if (password === null) {
            // Acknowledge the cancel so the click isn't silently dropped (UX-012),
            // matching the editor path's toast.info on connect-cancel.
            toast.info("Connect canceled");
            return;
          }
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
          // The prompt modal is now the feedback surface — clear the pre-connect
          // indicator before it appears (UX-011).
          dismissConnecting();
          const passphrase = await requestPassword(host, username, rejectedCredentialNotice);
          if (passphrase === null) {
            // Acknowledge the cancel (UX-012), matching the editor path.
            toast.info("Connect canceled");
            return;
          }
          config = { ...config, config: { ...cfg, password: passphrase } } as typeof config;
          if (useAppStore.getState().passwordPromptShouldSave) {
            await storeCredential(connection.id, "key_passphrase", passphrase).catch((err) => {
              frontendLog("connection_list", `Failed to store key passphrase: ${err}`);
            });
          }
        }
      }

      openTab(config, {
        terminalOptions: connection.terminalOptions,
        contentType,
      });
    },
    [addTab, requestPassword]
  );

  return { connect };
}
