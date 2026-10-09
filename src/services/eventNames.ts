/**
 * Names of the Tauri events the frontend subscribes to via the wrappers in
 * `events.ts` (and `TerminalView`'s `agent-state-change` listener).
 *
 * Kept in this dependency-free module so components can import a name without
 * pulling in `events.ts`, and so `eventContract.test.ts` can enumerate them and
 * check each one against the event names the Rust backend actually emits
 * (`src/test/fixtures/wire/events.json`, TFE2-006 / #4344).
 */
export const TAURI_EVENT = {
  terminalOutput: "terminal-output",
  remoteDesktopClipboard: "remote-desktop-clipboard",
  remoteDesktopState: "remote-desktop-state",
  remoteDesktopCertPrompt: "remote-desktop-cert-prompt",
  sshHostKeyPrompt: "ssh-host-key-prompt",
  sshKeyboardInteractivePrompt: "ssh-keyboard-interactive-prompt",
  sshKeyboardInteractivePromptClosed: "ssh-keyboard-interactive-prompt-closed",
  agentCrashNoticesChanged: "agent-crash-notices-changed",
  terminalExit: "terminal-exit",
  sessionOwnershipChanged: "session-ownership-changed",
  pluginChanged: "plugin-changed",
  sessionOwnershipSuperseded: "session-ownership-superseded",
  agentSetupProgress: "agent-setup-progress",
  agentUpdateAvailable: "agent-update-available",
  remoteAgentUpdatePending: "remote-agent-update-pending",
  vscodeEditComplete: "vscode-edit-complete",
  localFileChanged: "local-file-changed",
  localDirChanged: "local-dir-changed",
  logEntry: "log-entry",
  credentialStoreLocked: "credential-store-locked",
  credentialStoreUnlocked: "credential-store-unlocked",
  credentialStoreStatusChanged: "credential-store-status-changed",
  credentialStoreUnlockNeeded: "credential-store-unlock-needed",
  embeddedServerStatusChanged: "embedded-server-status-changed",
  persistentSessionStateChanged: "persistent-session-state-changed",
  connectionIdsChanged: "connection-ids-changed",
  jumpHostHopStatus: "jump-host-hop-status",
  jumpHostProbeComplete: "jump-host-probe-complete",
  transferProgress: "transfer-progress",
  xServerProgress: "x-server-progress",
  spawnRequest: "spawn-request",
  spawnPickerRequested: "spawn-picker-requested",
  xServerConsentNeeded: "x-server-consent-needed",
  agentStateChange: "agent-state-change",
} as const;

/** One of the Tauri event names in {@link TAURI_EVENT}. */
export type TauriEventName = (typeof TAURI_EVENT)[keyof typeof TAURI_EVENT];
