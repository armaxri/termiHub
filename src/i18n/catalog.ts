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
  "connection.hint.agentAuth.title": "SSH Agent not running",
  "connection.hint.agentAuth.ssh":
    "Open the connection editor and use the Setup SSH Agent button, or run:",
  "connection.hint.notFound.serial":
    "Serial port not found. Check that the device is connected and the port name is correct.",
  "connection.hint.notFound.docker":
    "Container not found. Check that the container, or the Compose service's project, is running (for example with docker compose up -d) and that the name is correct.",
  "connection.hint.permission.title": "Permission denied",
  "connection.hint.permission.serial.linux":
    "On Linux, add your user to the dialout group and re-login:",
  // Only Linux gates serial ports behind a group; on Windows/macOS a denied
  // port almost always means another program holds it (#1831).
  "connection.hint.permission.serial.windows":
    "Another application may be using the port, or you may not have permission to access it. Close any program using the port and try again.",
  "connection.hint.permission.serial.macos":
    "You may not have permission to access this port, or another application may be using it. Close any program using the port and try again.",
  "connection.hint.busy.serial": "The serial port is already in use by another application.",

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
