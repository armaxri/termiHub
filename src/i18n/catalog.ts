/**
 * User-facing message catalog (I18N-009).
 *
 * UI copy that is selected by a structured signal (e.g. the connection-failure
 * hints chosen from a backend error kind) is referenced by a stable message id
 * and resolved here, rather than inlined at the render site. Keeping the copy
 * keyed by id is what lets a locale be added by supplying another table, and
 * it keeps the *selection* of a message (by id) independent of its wording.
 *
 * Only English exists today; {@link t} resolves against it. A new locale adds a
 * `Record<MessageId, string>` table — the type forces it to cover every id.
 */

const en = {
  // ── Connection-failure hints (TerminalConnectionOverlay) ────────────────
  // Timeout guidance is per backend and never mentions the remote agent
  // binary: a timeout means the transport never connected (#2088).
  "connection.hint.timeout.ssh":
    "The connection timed out before the SSH session was established. Check that the host is reachable, the address and port are correct, and that no firewall is blocking the connection.",
  "connection.hint.timeout.telnet":
    "The connection timed out. Check that the host is reachable, the address and port are correct, and that no firewall is blocking the connection.",
  "connection.hint.timeout.serial":
    "The serial port did not respond in time. Check that the device is connected and that the baud rate matches the device.",
  "connection.hint.timeout.docker":
    "The connection timed out. Check that Docker is running and that the container is reachable.",
  "connection.hint.timeout.local":
    "Starting the local shell timed out. Check that the configured shell exists and is executable.",
  "connection.hint.timeout.unknown":
    "The connection timed out. Check that the host is reachable, the address and port are correct, and that no firewall is blocking the connection.",
  "connection.hint.auth.remote":
    "The server rejected the credentials. Check the username, password, or key and try again.",
  "connection.hint.agentAuth.title": "SSH agent not ready",
  "connection.hint.agentAuth.ssh":
    'Open the connection editor and use the "Set up SSH agent" button, or run:',
  "connection.hint.notFound.serial":
    "Serial port not found. Check that the device is connected and the port name is correct.",
  "connection.hint.notFound.docker":
    "Container not found. Check that the container, or the Compose service's project, is running (for example with docker compose up -d) and that the name is correct.",
  "connection.hint.permission.title": "Permission denied",
  "connection.hint.permission.serial.linux":
    "On Linux, add your user to the dialout group and re-login:",
  // Only Linux gates serial ports behind a group (#1831). On Windows a port
  // held by another program is reported as "busy" by the backend (#4368), so a
  // permission error there is a genuine access-rights problem.
  "connection.hint.permission.serial.windows":
    "You do not have permission to access this port. Check the port's access rights or ask an administrator.",
  "connection.hint.permission.serial.macos":
    "You may not have permission to access this port, or another application may be using it. Close any program using the port and try again.",
  "connection.hint.busy.serial": "The serial port is already in use by another application.",
  // TCP connect categories (#5183): the host / port is usually what is wrong.
  "connection.heading.refused": "Connection refused",
  "connection.heading.unreachable": "Host unreachable",
  "connection.heading.dns": "Host not found",
  "connection.hint.refused":
    "The host answered, but nothing is accepting connections on this port. Check the port number and that the service is running on the host.",
  "connection.hint.unreachable":
    "The host could not be reached. Check your network or VPN connection, and that the host is online and not blocked by a firewall.",
  "connection.hint.dns":
    "The host name could not be resolved. Check its spelling, and your DNS or VPN settings.",
  "connection.action.edit": "Edit connection",
  // The user rejected the server's host key in the trust prompt (#5185).
  "connection.heading.hostKeyRejected": "You rejected the host key",
  "connection.hint.hostKeyRejected":
    "Review the key again once its fingerprint is confirmed with the server's administrator, or edit the connection if the host or port is wrong.",
  "connection.action.reviewKey": "Review key",
  "connection.details.show": "Details",
  "connection.details.copy": "Copy error",
  "connection.details.copied": "Error copied to clipboard",

  // ── Credential re-entry on an auth failure (terminal overlays, #3089) ───
  "credentialReentry.open": "Update Credentials",
  "credentialReentry.target": "New credentials for {target}",
  "credentialReentry.password.label": "Password",
  "credentialReentry.passphrase.label": "Key passphrase",
  "credentialReentry.passphrase.hint": "Leave empty if the key has no passphrase.",
  "credentialReentry.keyPath.label": "Private key file",
  "credentialReentry.keyPath.agentHint": "A path on the agent host.",
  "credentialReentry.save.password": "Save password",
  "credentialReentry.save.passphrase": "Save passphrase",
  "credentialReentry.submit": "Reconnect",
  "credentialReentry.cancel": "Cancel",
  "credentialReentry.saveFailed":
    "The credential could not be saved. It is used for this connection attempt only.",

  // ── Workflow triggers (WorkflowTriggersEditor, #3791) ───────────────────
  "workflow.trigger.connections.empty": "No saved connections.",
  "workflow.trigger.onDisconnect.label": "On disconnect",
  "workflow.trigger.onDisconnect.connections": "Fire when a session ends for:",
  "workflow.trigger.onDisconnect.when": "Fire on",
  "workflow.trigger.onDisconnect.when.drop": "Unexpected drops only",
  "workflow.trigger.onDisconnect.when.userClose": "User closes only",
  "workflow.trigger.onDisconnect.when.any": "Any disconnect",
  "workflow.trigger.onDisconnect.hint":
    "Runs after the session has ended, so there is no terminal to type into: steps that send to the session fail. Use run-local-process and wait steps.",
  "workflow.trigger.onOutputMatch.label": "On output match",
  "workflow.trigger.onOutputMatch.connections": "Watch the output of:",
  "workflow.trigger.onOutputMatch.pattern": "Pattern",
  "workflow.trigger.onOutputMatch.patternPlaceholder": "e.g. Connection refused",
  "workflow.trigger.onOutputMatch.isRegex": "Regular expression",
  "workflow.trigger.onOutputMatch.cooldown": "Cooldown (seconds)",
  "workflow.trigger.onOutputMatch.cooldownHint": "Default 10. Allowed: 1 to 86400.",
  "workflow.trigger.onOutputMatch.cooldownError": "Enter a cooldown from 1 to 86400 seconds.",
  "workflow.trigger.onOutputMatch.maxFires": "Max runs per session",
  "workflow.trigger.onOutputMatch.maxFiresHint": "Default 5. Allowed: 1 to 100.",
  "workflow.trigger.onOutputMatch.maxFiresError": "Enter a whole number from 1 to 100.",
  "workflow.trigger.onOutputMatch.hint":
    "Matches the visible text (colors and other escape codes removed). Runs in the matching terminal, never while another workflow is running.",
  "workflow.trigger.pattern.error.empty": "Enter the text to match.",
  "workflow.trigger.pattern.error.tooLong": "A pattern can be at most 256 characters long.",
  "workflow.trigger.pattern.error.invalidRegex": "This is not a valid regular expression.",
  "workflow.trigger.pattern.error.unsafeRegex":
    "Nested quantifiers such as (a+)+ and backreferences are not allowed, because they can make matching very slow.",

  // ── Scheduled runs: "Connect if not connected" (#3527) ──────────────────
  "schedule.connect.fieldLabel": "Targets that are not connected",
  "schedule.connect.label": "Connect if not connected",
  "schedule.connect.help":
    "Before the run, connects each target that has no connected terminal, without asking anything: it uses saved passwords, key files and the SSH agent, and only hosts whose key is already trusted. A target that would need input (a password, a key passphrase, a one-time code, a new host key, or unlocking the credential store) is skipped and the reason is logged. Tabs opened for the run close when it ends; tabs that were already open stay open.",
  "schedule.connect.confirm":
    "It also connects any of these hosts that is not connected, using saved credentials only and never asking, and closes the tabs it opened when the run ends.",
  "schedule.connect.skip.target": "{target}: {reason}",
  "schedule.connect.skip.needsPassword": "needs a password",
  "schedule.connect.skip.needsPassphrase": "needs a key passphrase",
  "schedule.connect.skip.hostKey": "host key not trusted",
  "schedule.connect.skip.interactive": "needs interactive input (e.g. a one-time code)",
  "schedule.connect.skip.storeLocked": "credential store locked",
  "schedule.connect.skip.credentialRejected": "the saved credential was rejected",
  "schedule.connect.skip.agentTooOld": "agent too old for unattended connect",
  "schedule.connect.skip.agentDisconnected": "agent not connected",
  "schedule.connect.skip.notTerminal": "not a terminal connection",
  "schedule.connect.skip.missing": "the saved connection no longer exists",
  "schedule.connect.skip.cancelled": "the connect was cancelled",
  "schedule.connect.skip.failed": "could not connect: {error}",
  "schedule.connect.skip.notReady": "the terminal did not open in time",

  // ── Connect-time password prompt (PasswordPrompt, #5617) ────────────────
  // Titled after the connection's real transport: a telnet password is not
  // an SSH one. Sentence case; the connection name sits on its own line.
  "passwordPrompt.title.password": "{transport} password",
  "passwordPrompt.title.keyPassphrase": "SSH key passphrase",
  // An inline jump host's password (#5656); schema field secrets use their
  // own field label instead.
  "passwordPrompt.title.jumpHost": "Jump host password",
  "passwordPrompt.connection": "Connection: {name}",
  "passwordPrompt.description.password": "Enter password for {target}",
  "passwordPrompt.description.keyPassphrase":
    "Enter the passphrase for the SSH key used by {target}",
  "passwordPrompt.description.keyPassphraseWithPath":
    "Enter the passphrase for key {keyPath}, used by {target}",
  "passwordPrompt.input.password": "{transport} password",
  "passwordPrompt.input.keyPassphrase": "SSH key passphrase",
  // A telnet password travels in clear text (#5749).
  "passwordPrompt.unencrypted": "Telnet sends this password unencrypted.",

  // ── Unencrypted session marker (#5749) ───────────────────────────────────
  // A state badge on telnet tabs and in the status-bar telnet chip.
  "session.unencrypted.badge": "Unencrypted",
  "session.unencrypted.tooltip": "Telnet sends everything unencrypted, passwords included.",
  "statusBar.telnet.label": "Telnet: {endpoint}",
  "statusBar.telnet.labelNoHost": "Telnet",

  // ── Unlock dialog raised by a connect (UnlockDialog, #5684) ──────────────
  // Names the connection waiting on the unlock; several waiting connects
  // name the first and count the rest. {target} is "prod-db (SSH)".
  "unlockDialog.waiting.target": "{name} ({transport})",
  "unlockDialog.waiting.password": "Unlock to connect to {target} with its saved password.",
  "unlockDialog.waiting.passphrase": "Unlock to connect to {target} with its saved passphrase.",
  "unlockDialog.waiting.many.one":
    "Unlock to connect to {target} and {count} more connection with their saved credentials.",
  "unlockDialog.waiting.many.other":
    "Unlock to connect to {target} and {count} more connections with their saved credentials.",

  // ── Biometric unlock protection note (Settings ▸ Security, #5752) ──────
  // Shown only while unlock with Touch ID / Windows Hello is on. {method} is
  // the OS method label ("Touch ID").
  "biometricUnlock.note.appProtected":
    "Less secure: other apps running as you could read the unlock key.",
  "biometricUnlock.note.upgradePending":
    "It gets stronger protection the next time you unlock with {method}.",
  "biometricUnlock.note.osEnforced":
    "Protected by the operating system: the unlock key needs {method} every time.",

  // ── Tunnels whose SSH connection was deleted (#2850) ────────────────────
  "tunnel.missingConnection.status": "SSH connection deleted",
  "tunnel.missingConnection.detail": "SSH connection deleted — choose another",
  "tunnel.missingConnection.choose": "Choose connection",
  "tunnel.editor.missingConnection":
    "The SSH connection this tunnel used was deleted. Choose another SSH connection.",
  "tunnel.editor.chooseSshConnection": "Choose an SSH connection",

  // ── Credential store switch result (SecuritySettings, #2839 / #3323) ────
  "credentialSwitch.count.one": "{count} credential",
  "credentialSwitch.count.other": "{count} credentials",
  "credentialSwitch.migrated.success": "Switched to {target} — {credentials} migrated.",
  "credentialSwitch.switched": "Switched to {target}.",
  "credentialSwitch.migrated.partial":
    "Switched to {target}. {migrated} of {total} credentials migrated; {failed} could not be moved and stayed in {previous}.",
  "credentialSwitch.migrated.failed":
    "Switch failed, nothing changed: none of your {credentials} could be moved to {target}. {previous} is still active.",
  "credentialSwitch.removed.success": "Switched to {target} — {credentials} removed.",
  "credentialSwitch.removed.partial":
    "Switched to {target}. {removed} of {total} credentials removed; {failed} could not be removed from {previous}.",
  "credentialSwitch.removed.failed":
    "Switch failed, nothing changed: none of your {credentials} could be removed. {previous} is still active.",
  "credentialSwitch.remaining.title": "Still stored in {previous}:",

  // ── Credential store switch confirmation (SecuritySettings, #5629) ──────
  // Chosen by the (current, target) mode pair; each names its action and says
  // what happens to the saved credentials and the master-password vault.
  "credentialSwitch.confirm.toKeychain.move.title": "Move saved credentials to OS Keychain?",
  "credentialSwitch.confirm.toKeychain.move.text":
    "termiHub copies your saved credentials into the OS Keychain and reads them from there. Your master-password vault stays on this computer, locked and unchanged. Switching back to Master password opens it again with the same password.",
  "credentialSwitch.confirm.toKeychain.move.action": "Move to OS Keychain",
  "credentialSwitch.confirm.toKeychain.fresh.title": "Use OS Keychain?",
  "credentialSwitch.confirm.toKeychain.fresh.text":
    "Credentials you save from now on are stored in the OS Keychain. Nothing is saved yet, so nothing is moved.",
  "credentialSwitch.confirm.toKeychain.fresh.action": "Use OS Keychain",
  "credentialSwitch.confirm.toNone.title": "Delete saved credentials?",
  "credentialSwitch.confirm.toNone.text":
    "This permanently deletes every credential saved in {source} and cannot be undone. You'll be prompted for passwords each time you connect.",
  "credentialSwitch.confirm.toNone.source.keychain": "the OS Keychain",
  "credentialSwitch.confirm.toNone.source.vault": "your master-password vault",
  "credentialSwitch.confirm.toNone.action": "Delete saved credentials",
  "credentialSwitch.confirm.toMaster.move.title":
    "Move saved credentials to a master-password vault",
  "credentialSwitch.confirm.toMaster.move.text":
    "Choose a strong password. termiHub copies your saved credentials from the OS Keychain into a vault encrypted with it. The copies in the OS Keychain are left in place.",
  "credentialSwitch.confirm.toMaster.move.action": "Move to Master password",
  "credentialSwitch.confirm.toMaster.fresh.title": "Set master password",
  "credentialSwitch.confirm.toMaster.fresh.text":
    "Choose a strong password to encrypt your credentials.",
  "credentialSwitch.confirm.toMaster.fresh.action": "Turn on master password",

  // ── Process kill signal menu (ProcessTablePanel, #3209) ─────────────────
  "process.signal.term": "SIGTERM — terminate (graceful)",
  "process.signal.kill": "SIGKILL — kill (force)",
  "process.signal.int": "SIGINT — interrupt",
  "process.signal.hup": "SIGHUP — hang up / reload",
  "process.signal.quit": "SIGQUIT — quit",
  "process.signal.stop": "SIGSTOP — pause",
  "process.signal.cont": "SIGCONT — resume",
  "process.signal.usr1": "SIGUSR1 — user-defined 1",
  "process.signal.usr2": "SIGUSR2 — user-defined 2",
  "process.kill.title": "Send signal to process?",
  "process.kill.message": "Send {signal} to “{name}” (pid {pid})?",
  "process.kill.signalLabel": "Signal",
  "process.kill.confirm": "Send {signal}",
  "process.kill.destructive.kill":
    "SIGKILL ends the process at once. It cannot clean up or save its work, and this cannot be undone.",
  "process.kill.destructive.stop":
    "SIGSTOP pauses the process until it receives SIGCONT. It cannot catch or ignore the signal.",
  "process.kill.windowsOnly":
    "Windows has no POSIX signals, so a local process can only be terminated. SIGTERM and SIGKILL both end it; the other signals are not available.",
  "process.kill.sent": "Sent {signal} to {name} (pid {pid})",
  // ── File manager integration (ShellIntegrationSettings, #5616) ─────────
  // The actions follow the registration state: nothing to update or remove
  // until the integration is installed.
  "fileManagerIntegration.title": "File manager integration",
  "fileManagerIntegration.description":
    "Adds “Open in termiHub” to your file manager's right-click menu.",
  "fileManagerIntegration.status.registered": "Registered",
  "fileManagerIntegration.status.notRegistered": "Not registered",
  "fileManagerIntegration.action.install": "Install",
  "fileManagerIntegration.action.reinstall": "Reinstall / update",
  "fileManagerIntegration.action.uninstall": "Uninstall",

  // ── Dropped-session wording per transport (#5619, #5660, #5666) ─────────
  // A serial port has no shell or agent, and a network drop is not a process
  // exit: each transport says what actually happened.
  "drop.heading.serial": "Device disconnected — reconnecting…",
  "drop.heading.telnet": "Connection closed — reconnecting…",
  "drop.status.serial": "Device disconnected. Waiting for it to come back.",
  "drop.status.network": "Connection lost. Attempting to reconnect automatically.",
  "drop.detail.serial": "Scrollback is kept. Waiting for {port} to come back.",
  "drop.detail.serialUnknownPort": "Scrollback is kept. Waiting for the device to come back.",
  "drop.detail.ssh": "Scrollback is kept. Your remote shell restarts; running programs are lost.",
  "drop.detail.telnet":
    "Scrollback is kept. A new telnet session starts; the remote state is not restored.",
  "drop.detail.agent":
    "Scrollback is kept. The termiHub remote agent reattaches the session if it is still running.",
  "drop.detail.other": "Scrollback is kept. A new session starts; running programs are lost.",
  "drop.separator.serial": "— device disconnected {time} —",
  "drop.separator.network": "— connection lost {time} —",
  "drop.separator.remoteClosed": "— connection closed by server {time} —",
  "drop.separator.reconnected": "— reconnected {time} —",
  "drop.overlay.scrollbackKept": "Your scrollback is kept — choose View scrollback to read it.",
  // ── Serial port scan prefixes (Settings ▸ Serial, #5712) ───────────────
  // The /dev prefix scan only runs on Linux; elsewhere the list is folded.
  "serialPrefixes.offLinux.note":
    "Prefix scanning only runs on Linux. This computer lists serial ports from the system.",
  "serialPrefixes.offLinux.show": "Show Linux prefixes ({count})",
  "serialPrefixes.offLinux.hide": "Hide Linux prefixes",

  // ── Macro rows and run history (#5680) ──────────────────────────────────
  // Sentence case; one empty-state wording across the macro and workflow
  // run histories (R-081).
  "macro.play.target": "Play in: {target}",
  "macro.play.noTarget": "Play: no active terminal",
  "macro.run.origin.manual": "Manual",
  "macro.run.origin.palette": "Palette",
  "macro.run.origin.workflowStep": "Workflow step",
  "macro.run.origin.scheduled": "Scheduled",
  "runHistory.empty": "No runs yet.",
  "macroHistory.empty.filtered": "No runs of this macro yet.",

  // ── List rows: names on the row, settings in the tooltip (#5757) ────────
  "row.tooltip.tags": "Tags: {tags}",
  "macro.tooltip.types": "Types:",
  "macro.tooltip.lastRun": "Last run: {when} on {target}",
  "schedule.tooltip.last": "Last run: {when} · {outcome}",
  "schedule.marker.lastFailed": "Last run failed",
  "schedule.attempts.show": "Show recent attempts ({count})",
  "schedule.attempts.hide": "Hide recent attempts",
} as const;

/** A stable id naming one catalog message. */
export type MessageId = keyof typeof en;

/** Supported UI locales. */
export type Locale = "en";

const CATALOGS: Record<Locale, Record<MessageId, string>> = { en };

/** Resolve a message id to its text in `locale` (English by default). */
export function t(id: MessageId, locale: Locale = "en"): string {
  return CATALOGS[locale][id];
}

/**
 * Resolve a message id and substitute its `{name}` placeholders from `params`.
 * Unknown placeholders are left as-is so a missing parameter is visible.
 */
export function tf(
  id: MessageId,
  params: Record<string, string | number>,
  locale: Locale = "en"
): string {
  return t(id, locale).replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}
