/**
 * The saved-connection connect flow, shared by every surface that opens a
 * saved connection: the sidebar and command palette (through
 * {@link import("@/hooks/useConnectSavedConnection").useConnectSavedConnection})
 * and scheduled runs (#3527), which connect a target **unattended**.
 *
 * Attended (the default) it behaves exactly as the sidebar always has:
 *
 * - Skips credential handling for connections without `authMethod`/`host`
 *   (e.g. local shells) and for non-password/unencrypted-key auth.
 * - For key auth, prompts based on the key's *actual* encryption rather than
 *   the `savePassword` flag (#885).
 * - Treats a non-empty inline password as the credential itself (#963).
 * - Unlocks the credential store before resolving a stored secret (#1144).
 * - Validates a stored credential with a pre-connect and clears it if stale
 *   (#885/#963), otherwise prompts and optionally persists the entered secret.
 * - Refuses a connection whose plugin is missing, disabled or untrusted with a
 *   clear message (#3344), before any tab opens.
 *
 * **Unattended** (`{ unattended: true }`, #3527) the same steps run, but no
 * step may ask the user anything. Every point where the attended flow would
 * prompt fails fast instead and returns a `refused` result with the reason:
 * a missing password or key passphrase, a locked credential store, a stored
 * credential the server rejects (kept — only a user decides it is stale), an
 * agent-hosted or non-terminal connection. The connect itself always runs
 * first (`createTerminal` with the backend's never-prompt flag), so an
 * untrusted host key or a keyboard-interactive round comes back as its typed
 * code and is refused too; only then is the tab opened, on the live session.
 *
 * This module contains no UI of its own: callers render the shared
 * `PasswordPrompt` / `UnlockDialog` that the attended flow drives through the
 * store.
 */
import { toast } from "@/components/ui";
import { t, tf } from "@/i18n/catalog";
import {
  createTerminal,
  isSshKeyEncrypted,
  removeCredential,
  storeCredential,
} from "@/services/api";
import { useAppStore, type AddTabOptions } from "@/store/appStore";
import type { SavedConnection } from "@/types/connection";
import type { ConnectionConfig } from "@/types/terminal";
import {
  SECOND_FACTOR_FAILED_MESSAGE,
  backendErrorMessage,
  isAuthFailure,
  isSecondFactorFailure,
  parseBackendError,
} from "@/utils/backendErrorCode";
import { readConfigBoolean, readConfigString } from "@/utils/connectionConfigFields";
import {
  credentialStoreNeedsUnlock,
  ensureCredentialStoreUnlocked,
} from "@/utils/ensureCredentialStoreUnlocked";
import { frontendError, frontendLog } from "@/utils/frontendLog";
import { resolveGraphicalSettings } from "@/utils/graphicalSecret";
import { pluginConnectionIssue } from "@/utils/pluginConnectionTypes";
import { resolveConnectionCredential } from "@/utils/resolveConnectionCredential";

/** Options for {@link connectSavedConnection}. */
export interface ConnectSavedConnectionOptions {
  /**
   * Connect with nobody at the keyboard (a scheduled run, #3527): never
   * prompt, never show connect toasts; refuse with a reason instead.
   */
  unattended?: boolean;
}

/** How a {@link connectSavedConnection} call ended. */
export type ConnectSavedConnectionResult =
  /** A tab was opened (`sessionId` when it was opened on a live session). */
  | { status: "opened"; tabId: string; sessionId: string | null }
  /** The user dismissed a prompt (attended only). */
  | { status: "canceled" }
  /**
   * Not connected, and nothing was opened: a plugin problem, or — unattended —
   * a step that would have needed the user. `reason` is user-facing.
   */
  | { status: "refused"; reason: string }
  /** Unattended only: the connect itself failed (unreachable, timeout, …). */
  | { status: "failed"; reason: string };

/** The unattended refusal / failure for a failed never-prompt connect. */
function unattendedFailure(err: unknown): ConnectSavedConnectionResult {
  const { code } = parseBackendError(err);
  switch (code) {
    case "host_key_untrusted":
      return { status: "refused", reason: t("schedule.connect.skip.hostKey") };
    case "interaction_required":
    case "second_factor_failed":
      return { status: "refused", reason: t("schedule.connect.skip.interactive") };
    case "auth_failed":
      return { status: "refused", reason: t("schedule.connect.skip.credentialRejected") };
    case "cancelled":
      return { status: "refused", reason: t("schedule.connect.skip.cancelled") };
    default:
      return {
        status: "failed",
        reason: tf("schedule.connect.skip.failed", { error: backendErrorMessage(err) }),
      };
  }
}

/**
 * Open a terminal tab for a saved connection, resolving credentials from the
 * credential store (and, attended, prompting when needed) exactly as the
 * sidebar does. See the module docs for the unattended mode.
 */
export async function connectSavedConnection(
  connection: SavedConnection,
  options: ConnectSavedConnectionOptions = {}
): Promise<ConnectSavedConnectionResult> {
  const unattended = options.unattended === true;
  const { addTab, requestPassword } = useAppStore.getState();

  // A connection whose plugin is missing, disabled or not trusted cannot
  // connect (#3344): say why, with the same wording as the sidebar marker,
  // instead of opening a tab that fails with a raw "unknown type" error.
  const { plugins, pluginsLoaded } = useAppStore.getState();
  const pluginIssue = pluginsLoaded ? pluginConnectionIssue(connection.config.type, plugins) : null;
  if (pluginIssue) {
    if (!unattended) toast.error(`Cannot connect to ${connection.name}: ${pluginIssue.message}`);
    return { status: "refused", reason: pluginIssue.message };
  }

  let config = connection.config;
  const cfg = config.config;

  // An agent relays its own prompts, which the never-prompt connect cannot
  // reach, so an agent-hosted connection is never connected unattended.
  if (unattended && config.type === "remote-session") {
    return { status: "refused", reason: t("schedule.connect.skip.agentHosted") };
  }

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
  const openTab = (
    tabConfig: ConnectionConfig,
    opts: AddTabOptions = {}
  ): ConnectSavedConnectionResult => {
    dismissConnecting();
    const tabId = addTab(connection.name, connection.config.type, tabConfig, {
      connectionId: connection.id,
      ...opts,
    });
    return { status: "opened", tabId, sessionId: opts.sessionId ?? null };
  };

  // A terminal-less connection type (Capabilities.terminal === false, e.g.
  // FTP) opens into a browser-only tab instead of a terminal tab — no xterm,
  // no PTY. The tab still owns a session so the sidebar file browser can route
  // to it. Resolved from the registry capabilities (protocol-agnostic, never a
  // per-type hardcode); an unknown type or absent flag stays terminal (#1335).
  const effectiveTypeId =
    config.type === "remote-session"
      ? (readConfigString(connection.config, "sessionType") ?? config.type)
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

  // A scheduled run types into terminals: nothing else is a target (#3527).
  if (unattended && (isGraphical || isTerminalLess)) {
    return { status: "refused", reason: t("schedule.connect.skip.notTerminal") };
  }

  // Unattended, the connect runs first — never prompting — and the tab opens
  // only on the live session it produced (#3527).
  const connectUnattended = async (
    tabConfig: ConnectionConfig
  ): Promise<ConnectSavedConnectionResult> => {
    try {
      const sessionId = await createTerminal(
        tabConfig,
        undefined,
        false,
        false,
        true,
        connection.id
      );
      return openTab(tabConfig, { terminalOptions: connection.terminalOptions, sessionId });
    } catch (err) {
      frontendLog(
        "connection_list",
        `unattended connect of ${connection.id} failed: ${backendErrorMessage(err)}`
      );
      return unattendedFailure(err);
    }
  };

  // A remote-desktop connection saved with "Save password" (#3818) takes its
  // password from the credential store — or asks once, with the prompt's
  // Save box keeping it. Without the option the connect is unchanged: a VNC
  // server may need no password at all.
  if (isGraphical && readConfigBoolean(connection.config, "savePassword") === true) {
    const resolved = await resolveGraphicalSettings({
      credentialId: connection.id,
      sourceFile: connection.sourceFile ?? null,
      settings: cfg as Record<string, unknown>,
      requestPassword,
    });
    if (resolved.status === "canceled") {
      toast.info("Connect canceled");
      return { status: "canceled" };
    }
    return openTab({ ...config, config: resolved.settings } as typeof config, {
      terminalOptions: connection.terminalOptions,
      contentType,
    });
  }

  // Connections with authMethod and password support credential store resolution
  if (cfg.authMethod && cfg.host) {
    const authMethod = readConfigString(connection.config, "authMethod") ?? "";
    const savePassword = readConfigBoolean(connection.config, "savePassword");
    // A shared named credential (#3557) replaces the per-connection secret.
    const credentialRef = readConfigString(connection.config, "credentialRef");

    // For key auth, decide whether a passphrase is needed from the key's
    // actual encryption rather than the savePassword flag (#885): a
    // passphrase-protected key must be unlocked even when savePassword is
    // off, and an unencrypted key must never prompt. If the file can't be
    // read, default to "encrypted" so an encrypted key never fails silently.
    let keyEncrypted = false;
    if (authMethod === "key") {
      keyEncrypted = await isSshKeyEncrypted(
        readConfigString(connection.config, "keyPath") ?? ""
      ).catch(() => true);
    }
    // Password auth always needs a credential; key auth only when encrypted.
    const needsCredential = authMethod === "password" || (authMethod === "key" && keyEncrypted);
    if (!needsCredential) {
      if (unattended) return connectUnattended(config);
      return openTab(config, {
        terminalOptions: connection.terminalOptions,
        contentType,
      });
    }

    // An inline, non-empty password on the config is itself the credential —
    // e.g. an "Open Jump Host Terminal" gateway synthesized from an inline
    // hop, whose password lives on the hop, not in the store (#963). Use it
    // directly: a credential-store lookup here is keyed by this (possibly
    // synthetic) connection id and would miss, forcing a redundant prompt
    // even though the password is already known.
    if (typeof cfg.password === "string" && cfg.password.length > 0) {
      if (unattended) return connectUnattended(config);
      return openTab(config, {
        terminalOptions: connection.terminalOptions,
        contentType,
      });
    }

    // Unattended, a locked store cannot be unlocked: nobody can type the
    // master password (#3527).
    if (unattended && credentialStoreNeedsUnlock({ authMethod, savePassword, credentialRef })) {
      return { status: "refused", reason: t("schedule.connect.skip.storeLocked") };
    }

    // UX-011: from here on the flow runs the genuinely slow steps (unlock,
    // stored-credential resolve, blocking pre-connect handshake). Show the
    // non-blocking connecting indicator now — before any of them — so the
    // pre-tab window is never a silent gap.
    if (!unattended) connectingToastId = toast.loading("Connecting…");

    // Before attempting credential resolution, check whether the credential store
    // is locked. If it is, we can't read the stored credential and SSH would fall
    // back to interactive password prompts. Prompt for unlock first and wait —
    // on success the code continues and the credential resolves automatically.
    const proceed =
      unattended ||
      (await ensureCredentialStoreUnlocked({
        authMethod,
        savePassword,
        credentialRef,
      }));
    if (!proceed) {
      dismissConnecting();
      return { status: "canceled" };
    }

    // Try to resolve credential from the store first
    const resolution = await resolveConnectionCredential(
      connection.id,
      authMethod,
      savePassword,
      credentialRef,
      connection.sourceFile
    );
    // A shared credential is never deleted on rejection (other connections
    // use it) and a prompted secret is never saved per-connection in its
    // place (it would never be read) — #3557.
    const sharedCredential = resolution.namedCredentialId !== undefined;

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
      // Unattended: connect never-prompting with the stored secret. A
      // rejection keeps the credential — only a user decides it is stale.
      if (unattended) return connectUnattended(preConfig);
      // A graphical connection is not a terminal session — `createTerminal`
      // would mint one on the terminal SessionManager. Open the canvas tab
      // directly with the resolved credential in its config; the
      // RemoteDesktopTab drives `remote_desktop_connect` itself (#1680).
      if (isGraphical) {
        return openTab(preConfig, {
          terminalOptions: connection.terminalOptions,
          contentType,
        });
      }
      try {
        const sessionId = await createTerminal(
          preConfig,
          undefined,
          undefined,
          undefined,
          undefined,
          connection.id
        );
        // Stored credential worked — open tab with existing session
        return openTab(preConfig, {
          terminalOptions: connection.terminalOptions,
          sessionId,
          contentType,
        });
      } catch (err) {
        if (isAuthFailure(err) && sharedCredential) {
          // The shared credential was rejected: keep it, and ask for this
          // connect's secret without offering to save it here.
          rejectedCredentialNotice =
            "The shared credential was rejected — enter it for this connect, or rotate it in Settings → Security.";
        } else if (isAuthFailure(err)) {
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
          await removeCredential(
            connection.id,
            resolution.credentialType,
            connection.sourceFile
          ).catch((err) => {
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
        } else if (isSecondFactorFailure(err)) {
          // The saved password was ACCEPTED and only the one-time code the
          // user typed was rejected (#3376): keep the credential and open
          // the tab with it, so the retry asks for a fresh code rather than
          // for the password again.
          toast.error(SECOND_FACTOR_FAILED_MESSAGE);
          return openTab(preConfig, {
            terminalOptions: connection.terminalOptions,
            contentType,
          });
        } else {
          // Non-auth failure — let the Terminal component handle the error
          return openTab(config, {
            terminalOptions: connection.terminalOptions,
            contentType,
          });
        }
      }
    }

    // No stored credential — unattended, nobody can type it (#3527).
    if (unattended) {
      return {
        status: "refused",
        reason:
          authMethod === "key"
            ? t("schedule.connect.skip.needsPassphrase")
            : t("schedule.connect.skip.needsPassword"),
      };
    }

    // No stored credential or stale credential was cleared — prompt the user
    if (authMethod === "password") {
      const host = readConfigString(connection.config, "host") ?? "";
      const username = readConfigString(connection.config, "username") ?? "";
      // The prompt modal is now the feedback surface — clear the pre-connect
      // indicator before it appears (UX-011).
      dismissConnecting();
      const password = sharedCredential
        ? await requestPassword(host, username, rejectedCredentialNotice, "password", {
            allowSave: false,
          })
        : await requestPassword(host, username, rejectedCredentialNotice);
      if (password === null) {
        // Acknowledge the cancel so the click isn't silently dropped (UX-012),
        // matching the editor path's toast.info on connect-cancel.
        toast.info("Connect canceled");
        return { status: "canceled" };
      }
      config = { ...config, config: { ...cfg, password } } as typeof config;
      // Persist the entered password if the user opted in via the prompt checkbox
      if (!sharedCredential && useAppStore.getState().passwordPromptShouldSave) {
        await storeCredential(connection.id, "password", password, connection.sourceFile).catch(
          (err) => {
            frontendLog("connection_list", `Failed to store credential: ${err}`);
          }
        );
      }
    } else if (authMethod === "key") {
      // Key auth with an encrypted key (guaranteed by the needsCredential
      // gate above) and no stored passphrase yet — prompt so the backend can
      // unlock the key, regardless of savePassword (#885). Whether the
      // passphrase is then stored still follows the prompt's Save box.
      const host = readConfigString(connection.config, "host") ?? "";
      const username = readConfigString(connection.config, "username") ?? "";
      // The prompt modal is now the feedback surface — clear the pre-connect
      // indicator before it appears (UX-011).
      dismissConnecting();
      const passphrase = sharedCredential
        ? await requestPassword(host, username, rejectedCredentialNotice, "key_passphrase", {
            allowSave: false,
          })
        : await requestPassword(host, username, rejectedCredentialNotice, "key_passphrase");
      if (passphrase === null) {
        // Acknowledge the cancel (UX-012), matching the editor path.
        toast.info("Connect canceled");
        return { status: "canceled" };
      }
      config = { ...config, config: { ...cfg, password: passphrase } } as typeof config;
      if (!sharedCredential && useAppStore.getState().passwordPromptShouldSave) {
        await storeCredential(
          connection.id,
          "key_passphrase",
          passphrase,
          connection.sourceFile
        ).catch((err) => {
          frontendLog("connection_list", `Failed to store key passphrase: ${err}`);
        });
      }
    }
  }

  if (unattended) return connectUnattended(config);
  return openTab(config, {
    terminalOptions: connection.terminalOptions,
    contentType,
  });
}
