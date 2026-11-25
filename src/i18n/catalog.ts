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

  // ── Automation triggers (TriggerCard, #3791) ───────────────────
  "workflow.trigger.connections.empty": "No saved connections.",
  "workflow.trigger.onDisconnect.label": "On disconnect",
  "workflow.trigger.onDisconnect.connections": "Fire when a session ends for:",
  "workflow.trigger.onDisconnect.when": "Fire on",
  "workflow.trigger.onDisconnect.when.drop": "Unexpected drops only",
  "workflow.trigger.onDisconnect.when.userClose": "User closes only",
  "workflow.trigger.onDisconnect.when.any": "Any disconnect",
  "workflow.trigger.onDisconnect.hint":
    "Runs after the session has ended, so there is no terminal to type into: steps that send to the session fail. Use Run local process and Wait steps.",
  "workflow.trigger.onOutputMatch.label": "On output match",
  "workflow.trigger.onOutputMatch.connections": "Watch the output of:",
  "workflow.trigger.onOutputMatch.pattern": "Pattern",
  "workflow.trigger.onOutputMatch.patternPlaceholder": "e.g. Connection refused",
  "workflow.trigger.onOutputMatch.isRegex": "Regular expression",
  "workflow.trigger.onOutputMatch.cooldown": "Cooldown (seconds)",
  "workflow.trigger.onOutputMatch.cooldownHint": "Not again for this long. 1 to 86400.",
  "workflow.trigger.onOutputMatch.cooldownError": "Enter a cooldown from 1 to 86400 seconds.",
  "workflow.trigger.onOutputMatch.maxFires": "Runs at most",
  "workflow.trigger.onOutputMatch.maxFiresHint":
    "At most {count} times until the terminal disconnects. 1 to 100.",
  "workflow.trigger.onOutputMatch.maxFiresError": "Enter a whole number from 1 to 100.",
  "workflow.trigger.onOutputMatch.hint":
    "Matches the visible text (colors and other escape codes removed). Runs in the matching terminal, never while another automation is running.",
  "workflow.trigger.pattern.error.empty": "Enter the text to match.",
  "workflow.trigger.pattern.error.tooLong": "A pattern can be at most 256 characters long.",
  "workflow.trigger.pattern.error.invalidRegex": "This is not a valid regular expression.",
  "workflow.trigger.pattern.error.unsafeRegex":
    "Nested quantifiers such as (a+)+ and backreferences are not allowed, because they can make matching very slow.",

  // ── Scheduled runs: what to do with a closed connection (#3527, #6024) ──
  "schedule.closed.label": "If a connection is closed",
  "schedule.closed.connect": "Connect it",
  "schedule.closed.connectHint":
    "With saved credentials, without asking. Its tab closes afterwards.",
  "schedule.closed.skip": "Skip it",
  "schedule.closed.skipHint": "Runs only where a terminal is already open.",
  "schedule.closed.error": "Choose what to do with a closed connection.",
  "schedule.connect.help":
    "Connecting uses saved passwords, key files and the SSH agent, and only hosts whose key is already trusted. A connection that would need input (a password, a key passphrase, a one-time code, a new host key, or unlocking the credential store) is skipped, and the list says why. Tabs opened for the run close when it ends; tabs that were already open stay open.",
  "schedule.details.title": "How connecting works",

  // ── Schedules: what will run, when, where, and what happened (#6024) ────
  "connection.deleted": "Deleted connection",
  "connection.deletedNamed": "Deleted connection “{name}”",
  "connection.deletedRemove": "Remove",
  "connection.deletedRemoveLabel": "Remove {name}",
  "schedule.group.label": "Group “{name}”",
  "schedule.group.deleted": "Deleted broadcast group",
  "schedule.gone.connections": "its connections were deleted",
  "schedule.gone.group": "its broadcast group was deleted",
  "schedule.gone.groupMembers": "its broadcast group has no connection left",
  "schedule.gone.automation": "its automation was deleted",
  "schedule.gone.pick": "All chosen connections were deleted. Pick another one.",
  "schedule.blocked": "Will not run: {reason}.",
  "schedule.unattended.missing":
    "Will not run: it asks for “{name}”, which has no default value. Give it one in the automation.",
  "schedule.unattended.defaults": "Does not ask, it uses the default values: {list}.",
  "schedule.unattended.emptyValue": "(empty)",
  "schedule.unattended.password":
    "It types “{command}”. If that asks for a password, nobody is there to enter it and the run cannot finish.",
  "schedule.unattended.passwordWait":
    "It waits for a password question. Nobody is there to answer it, so the run cannot finish.",
  "schedule.unattended.waits":
    "Will not run: it stops to let you type in the terminal, and nobody is there on a schedule.",
  "schedule.skip.waits":
    "It stops to let you type in the terminal, and nobody is there on a schedule",
  "schedule.skip.noneOpen": "None of its connections was open",
  "schedule.skip.noneOpenSkip":
    "None of its connections was open, and the schedule is set to skip closed ones",
  "schedule.skip.missingValue":
    "It asks for “{name}”, which has no default value. Nobody is there to enter one",
  "schedule.onlyWhileOpen": "Runs only while termiHub is open on this computer.",
  "schedule.state.off": "Off",
  "schedule.state.neverOn": "Off until you switch it on",
  "schedule.state.on": "On",
  "schedule.state.running": "Running now",
  "schedule.state.paused": "Paused",
  "schedule.state.next": "Next run {when}",
  "schedule.state.none": "No next run",
  "schedule.row.what": "{action} on {targets}",
  "schedule.action.deleted": "Deleted automation",
  "schedule.last.completed": "Last run completed ({when})",
  "schedule.last.partly": "Last run left some out: {reason} ({when})",
  "schedule.last.failed": "Last run failed: {reason} ({when})",
  "schedule.last.canceled": "Last run was canceled ({when})",
  "schedule.last.skipped": "Last run skipped: {reason} ({when})",
  "schedule.last.missed": "Last run missed: {reason} (due {when})",
  "schedule.last.unknownReason": "no reason recorded",
  "schedule.outcome.completed": "Completed",
  "schedule.outcome.partly": "Completed, some left out",
  "schedule.outcome.failed": "Failed",
  "schedule.outcome.canceled": "Canceled",
  "schedule.outcome.skipped": "Skipped",
  "schedule.outcome.missed": "Missed",
  "schedule.marker.attention": "A schedule did not run as planned",
  "schedule.menu.label": "More actions for {name}",
  "schedule.menu.history": "Show in History",
  "schedule.toggle.on": "Switch on {name}",
  "schedule.toggle.off": "Switch off {name}",
  "schedule.summary.next": "Next run: {when} on {targets}.",
  "schedule.summary.nextAfter": "Next run: {when}, on {targets}.",
  "schedule.summary.afterMinute": "1 minute after you switch it on",
  "schedule.summary.afterMinutes": "{count} minutes after you switch it on",
  "schedule.summary.noTarget": "Next run: {when}, but no connection is chosen.",
  "schedule.summary.off": "Off until you switch it on in the list.",
  "schedule.summary.switchesOff":
    "Saving switches it off, because what it may do changes. Switch it on again in the list.",
  "schedule.summary.paused": "All schedules are paused.",
  "schedule.summary.skips": "Skipped where the connection is closed.",
  "schedule.saved.off": "Saved “{name}”, switched off",
  "schedule.saved.offHint": "Switch it on in the Schedules list.",
  "schedule.confirm.title": "Switch on “{name}”?",
  "schedule.confirm.message":
    "{rule}, termiHub runs {action} and types into every connected terminal of these connections, without asking:",
  "schedule.confirm.next": "First run: {when}.",
  "schedule.confirm.skips": "A connection that is closed at that time is skipped.",
  "schedule.confirm.gone": "Nothing will run: {reason}.",
  "schedule.confirm.foot":
    "It only runs while termiHub is open. You can switch it off, or pause all schedules, at any time.",
  "schedule.confirm.accept": "Switch on",
  "schedule.connect.confirm":
    "A connection that is closed is connected first, with saved credentials only and never asking. The tabs opened for the run close when it ends.",
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
  // The key's file name; the full path is the line's tooltip (#5838).
  "passwordPrompt.description.keyPassphraseWithPath":
    "Enter the passphrase for key {keyName}, used by {target}",
  // A telnet login (#5838): termiHub answers the server's login prompt, so the
  // user does not type the password again in the terminal.
  "passwordPrompt.description.telnet":
    "Enter the password for {target}. termiHub answers the server's login prompt for you.",
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

  // ── Status-bar SSH, local-shell and lock chips (#5839) ───────────────────
  // The SSH chip names its trust and encryption and opens a details popover.
  "statusBar.ssh.trust.trusted": "host key trusted",
  "statusBar.ssh.trust.once": "host key trusted once",
  "statusBar.ssh.trust.pending": "host key not checked yet",
  "statusBar.ssh.ariaLabel": "SSH: {label}, encrypted, {trust}. Show connection security",
  "statusBar.ssh.encrypted": "Encrypted (SSH)",
  "statusBar.ssh.down": "Not connected",
  "statusBar.ssh.hostKey.pending": "Not checked yet (still connecting)",
  "statusBar.ssh.row.endpoint": "Host",
  "statusBar.ssh.row.encryption": "Encryption",
  "statusBar.ssh.row.integrity": "Integrity",
  "statusBar.ssh.row.keyExchange": "Key exchange",
  "statusBar.ssh.row.hostKeyAlgorithm": "Host key algorithm",
  "statusBar.ssh.row.auth": "Signed in with",
  "statusBar.ssh.row.hostKey": "Host key",
  "statusBar.ssh.title": "Connection security",
  "statusBar.ssh.manageTrust": "Manage trusted host keys",
  "statusBar.local.tooltip": "Local shell: {shell}",
  "statusBar.local.startDir": "Starts in {dir}",
  "statusBar.local.unknownShell": "Local shell",
  "statusBar.lock.locked": "Locked",
  "statusBar.lock.unlocked": "Unlocked",
  "statusBar.lock.lockNow": "Unlocked, lock the credential store now",
  "statusBar.lock.unlock": "Locked, unlock the credential store",

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
  // The conditions moved out of the toggle's hint into the note (#5876).
  "biometricUnlock.note.conditions":
    "Your master password keeps working. You need it again after you change it or your " +
    "{method} enrollment changes.",

  // ── Tunnels whose SSH connection was deleted (#2850) ────────────────────
  "tunnel.missingConnection.status": "SSH connection deleted",
  "tunnel.missingConnection.detail": "SSH connection deleted — choose another",
  "tunnel.missingConnection.choose": "Choose connection",
  "tunnel.editor.missingConnection":
    "The SSH connection this tunnel used was deleted. Choose another SSH connection.",
  "tunnel.editor.chooseSshConnection": "Choose an SSH connection",

  // ── SSH tunnel types in plain words (#6027) ─────────────────────────────
  // Read through `src/utils/tunnelTypeHelp.ts`. `{machine}` is the machine that
  // hosts the tunnel ("this computer" or "agent build-box"), the same name the
  // editor's endpoint lines use; the `.agent` variants replace "here".
  "tunnel.type.local.label": "Local",
  "tunnel.type.local.summary": "Reach something on the SSH server's side",
  "tunnel.type.local.lead": "Use something on the SSH server's side as if it ran here.",
  "tunnel.type.local.lead.agent":
    "Use something on the SSH server's side as if it ran on {machine}.",
  "tunnel.type.local.how":
    "Opens a port on {machine} and sends its traffic through SSH to a host and port the SSH server can reach.",
  "tunnel.type.local.example":
    "Example: a database only the SSH server can reach, at localhost:5432 on {machine}.",
  "tunnel.type.remote.label": "Remote",
  "tunnel.type.remote.summary": "Let the SSH server reach something here",
  "tunnel.type.remote.summary.agent": "Let the SSH server reach something on the agent's side",
  "tunnel.type.remote.lead": "Let the SSH server use something here.",
  "tunnel.type.remote.lead.agent": "Let the SSH server use something on {machine}'s side.",
  "tunnel.type.remote.how":
    "Opens a port on the SSH server and sends its traffic back through SSH to a host and port {machine} can reach.",
  "tunnel.type.remote.example":
    "Example: show a web app running on {machine} to someone logged in on the SSH server.",
  "tunnel.type.dynamic.label": "Dynamic",
  "tunnel.type.dynamic.summary": "SOCKS5 proxy through the SSH server",
  "tunnel.type.dynamic.lead": "Use the SSH server as a proxy for many destinations.",
  "tunnel.type.dynamic.how":
    "Opens a SOCKS5 proxy on {machine}. Programs set to use it connect from the SSH server.",
  "tunnel.type.dynamic.example": "Example: browse an internal network through the SSH server.",
  "tunnel.type.dynamic.example.agent":
    "Example: programs on {machine} reach an internal network through the SSH server.",

  // ── Credential store switch (Settings ▸ Security, #2839 / #3323 / #5629 / #5837) ──
  // Plain words and the option cards' names, never the internal mode names:
  // "saved passwords", "the OS Keychain", "your master-password vault".
  "credentialSwitch.passwords.one": "{count} saved password",
  "credentialSwitch.passwords.other": "{count} saved passwords",
  "credentialSwitch.place.keychain": "the OS Keychain",
  "credentialSwitch.place.vault": "your master-password vault",

  // Result shown in place under the option cards. {passwords} is
  // "2 saved passwords"; {target} and {previous} are places ("the OS Keychain").
  "credentialSwitch.result.moved.toKeychain":
    "Moved {passwords} to the OS Keychain. Your master-password vault is kept.",
  "credentialSwitch.result.moved.toVault":
    "Moved {passwords} to your master-password vault. The copies in the OS Keychain are kept.",
  "credentialSwitch.result.using.keychain": "Passwords are now saved in the OS Keychain.",
  "credentialSwitch.result.using.vault": "Passwords are now saved in your master-password vault.",
  "credentialSwitch.result.moved.partial":
    "Moved {moved} of {total} saved passwords to {target}. {failed} could not be moved and stay in {previous}.",
  "credentialSwitch.result.moved.failed":
    "Nothing changed: none of your {passwords} could be moved to {target}. They stay in {previous}.",
  "credentialSwitch.result.stopped": "Stopped saving passwords.",
  "credentialSwitch.result.stopped.removed": "Stopped saving passwords. {passwords} removed.",
  "credentialSwitch.result.stopped.partial":
    "Stopped saving passwords. {removed} of {total} saved passwords removed; {failed} could not be removed from {previous}.",
  "credentialSwitch.result.stopped.failed":
    "Nothing changed: none of your {passwords} could be removed from {previous}, so termiHub keeps saving passwords there.",
  "credentialSwitch.result.remaining.title": "Still saved in {previous}:",

  // Progress shown on the confirm button and beside the cards while a switch
  // runs. {passwords} is "2 passwords".
  "credentialSwitch.progress.move": "Moving {passwords}…",
  "credentialSwitch.progress.moveUncounted": "Moving saved passwords…",
  "credentialSwitch.progress.delete": "Deleting {passwords}…",
  "credentialSwitch.progress.deleteUncounted": "Deleting saved passwords…",
  "credentialSwitch.progress.switch": "Switching…",
  "credentialSwitch.progress.count.one": "{count} password",
  "credentialSwitch.progress.count.other": "{count} passwords",

  // Confirmation before a switch that moves or deletes saved passwords. A
  // counted variant names how many; the uncounted one is used when the count
  // is unknown (a locked vault, or an OS Keychain item older than termiHub's
  // key index). A switch with nothing saved needs no confirmation (#5837).
  "credentialSwitch.confirm.toKeychain.move.title": "Move {passwords} to the OS Keychain?",
  "credentialSwitch.confirm.toKeychain.moveUncounted.title":
    "Move saved passwords to the OS Keychain?",
  "credentialSwitch.confirm.toKeychain.move.text":
    "termiHub copies them from your master-password vault into the OS Keychain and reads them from there. Your vault stays on this computer, locked and unchanged. Switching back to Master password opens it again with the same password.",
  "credentialSwitch.confirm.toKeychain.move.action": "Move to OS Keychain",
  "credentialSwitch.confirm.toKeychain.fresh.title": "Use OS Keychain?",
  "credentialSwitch.confirm.toKeychain.fresh.text":
    "Passwords you save from now on are stored in the OS Keychain. Nothing is saved yet, so nothing is moved.",
  "credentialSwitch.confirm.toKeychain.fresh.action": "Use OS Keychain",
  "credentialSwitch.confirm.toNone.title": "Stop saving passwords?",
  "credentialSwitch.confirm.toNone.text":
    "This permanently deletes the {passwords} in {source} and cannot be undone. You'll be asked for passwords each time you connect.",
  "credentialSwitch.confirm.toNone.textUncounted":
    "This permanently deletes every password termiHub saved in {source} and cannot be undone. You'll be asked for passwords each time you connect.",
  "credentialSwitch.confirm.toNone.action": "Delete saved passwords",
  "credentialSwitch.confirm.toMaster.move.title": "Move {passwords} to a master-password vault",
  "credentialSwitch.confirm.toMaster.moveUncounted.title":
    "Move saved passwords to a master-password vault",
  "credentialSwitch.confirm.toMaster.move.text":
    "Choose a strong password. termiHub copies your saved passwords from the OS Keychain into a vault encrypted with it. The copies in the OS Keychain are left in place.",
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
  // ── File manager integration (ShellIntegrationSettings, #5616, #5845) ──
  // One name for the feature everywhere: "Open in termiHub", the entry the user
  // sees in the right-click menu. `{place}` is the platform's file manager
  // (`fileManagerPlace`: Finder, File Explorer, your file manager), so the
  // status and its button say the same thing ("Not added to Finder" / "Add to
  // Finder"). The actions follow the registration state: nothing to update or
  // remove until the entry is added.
  "fileManagerIntegration.title": "Open in termiHub",
  "fileManagerIntegration.description":
    "Adds “Open in termiHub” to the right-click menu in {place}.",
  "fileManagerIntegration.status.registered": "Added to {place}",
  "fileManagerIntegration.status.notRegistered": "Not added to {place}",
  "fileManagerIntegration.action.install": "Add to {place}",
  "fileManagerIntegration.action.reinstall": "Update",
  "fileManagerIntegration.action.uninstall": "Remove from {place}",
  "fileManagerIntegration.toast.adding": "Adding “Open in termiHub” to {place}…",
  "fileManagerIntegration.toast.added": "Added “Open in termiHub” to {place}",
  "fileManagerIntegration.toast.addFailed": "Could not add it to {place}: {error}",
  "fileManagerIntegration.toast.removing": "Removing “Open in termiHub” from {place}…",
  "fileManagerIntegration.toast.removed": "Removed “Open in termiHub” from {place}",
  "fileManagerIntegration.toast.removeFailed": "Could not remove it from {place}: {error}",
  // The one-time offer (FileManagerOffer, #5753): the primary "Add to {place}"
  // sits next to "Not now"; after "Not now" a short note says where it lives.
  "fileManagerIntegration.offer.title": "Add “Open in termiHub” to {place}?",
  "fileManagerIntegration.offer.description":
    "Right-click any folder in {place} to open it in termiHub. You can also add it later in Settings ▸ Open in termiHub.",
  "fileManagerIntegration.offer.notNow": "Not now",
  "fileManagerIntegration.offer.later": "You can add it any time in Settings ▸ Open in termiHub.",
  "fileManagerIntegration.fallback.label": "When opening a folder",
  "fileManagerIntegration.fallback.hint": "Used when no quick-access entry matches the folder.",
  "fileManagerIntegration.fallback.picker": "Ask which session",
  "fileManagerIntegration.fallback.systemDefaultShell": "Open a new terminal",

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
  // The user ended the link: a tab or agent Disconnect (#5959).
  "drop.separator.user": "— disconnected by you {time} —",
  "drop.separator.remoteClosed": "— connection closed by server {time} —",
  "drop.separator.reconnected": "— reconnected {time} —",
  // After a reconnect the marker says what the new session lost (#5831, R-101).
  "drop.separator.reconnectedShell":
    "— reconnected {time} — new remote shell; running programs were lost",
  "drop.separator.reconnectedSession":
    "— reconnected {time} — new session; running programs were lost",
  // An agent tab that re-attached its own, still-running session (#5953).
  "drop.separator.resumed": "— reconnected {time} — session resumed —",
  // A local process is started again, not reconnected (#5955).
  "drop.separator.restarted": "— restarted {time} —",
  "drop.separator.reconnectedTelnet":
    "— reconnected {time} — new telnet session; the remote state was not restored",
  "drop.overlay.scrollbackKept": "Scrollback is kept.",
  // ── Why a session ended: one cause line everywhere (#5831) ──────────────
  "drop.cause.user": "You disconnected this session.",
  "drop.cause.ended": "The session ended normally.",
  "drop.cause.endedCode": "The session ended normally (exit code {code}).",
  "drop.cause.exited": "The process exited with code {code}.",
  "drop.cause.server": "The server closed the connection.",
  "drop.cause.timeout": "The connection timed out.",
  "drop.cause.network": "The network connection was lost.",
  "drop.cause.device": "The device {device} was disconnected.",
  "drop.cause.deviceUnknown": "The device was disconnected.",
  "drop.cause.lost": "The connection was lost.",
  // ── Session-end notice headings and actions (#5910) ────────────────────
  // A process that exits is not a lost connection: only a dropped link says
  // "disconnected", and a local process is restarted, not reconnected.
  "drop.end.exited": "Process exited (code {code})",
  "drop.end.exitedNoCode": "Process exited",
  "drop.end.ended": "Session ended",
  "drop.end.device": "Device disconnected",
  "drop.end.disconnected": "Session disconnected",
  "drop.end.restart": "Restart",
  "drop.end.reconnect": "Reconnect",
  // One Enter hint for the strip and the view-mode banner (#5955).
  "drop.end.enterReconnect": "Press Enter to reconnect.",
  "drop.end.enterRestart": "Press Enter to restart.",
  "drop.heading.server": "Server closed the connection — reconnecting…",
  "drop.heading.timeout": "Connection timed out — reconnecting…",
  "drop.autoReconnectOff":
    "Auto-reconnect is off for this connection. Turn it on with “Auto-reconnect” in the connection's settings.",
  "drop.autoReconnectOffTelnet":
    "Auto-reconnect is off for this connection: telnet connections start with it off. Turn it on with “Auto-reconnect” in the connection's settings.",
  "drop.retryNow": "Retry now",
  "drop.afterLastAttempt": "After attempt {max}, retrying stops and the tab offers Reconnect.",
  // ── Serial port scan prefixes (Settings ▸ Serial, #5712) ───────────────
  // The /dev prefix scan only runs on Linux; elsewhere the list is folded.
  "serialPrefixes.offLinux.note":
    "Prefix scanning only runs on Linux. This computer lists serial ports from the system.",
  // Where users looking for serial defaults should go instead (#5844).
  "serialPrefixes.offLinux.connectionSettings":
    "Baud rate, data bits, parity and flow control are set on each serial connection.",
  "serialPrefixes.offLinux.show": "Show Linux prefixes ({count})",
  "serialPrefixes.offLinux.hide": "Hide Linux prefixes",

  // ── Automation rows and run history (#5680, #5818) ──────────────────────
  // Sentence case; one empty-state wording for the run history (R-081).
  "automation.run.target": "Run in: {target}",
  "automation.run.noTarget": "Run… (no active terminal: choose where)",
  "automation.run.label": "Run {name}",
  "automation.run.labelPick": "Run {name} on…",
  "automation.stop.label": "Stop {name}",
  "automation.stop.allLabel": "Stop {name} on every terminal",
  "automation.stop.target": "Stop on {target}",
  "automation.armed.on": "Runs automatically: {triggers}",
  "automation.armed.off": "Trigger off, will not run automatically: {triggers}",
  "automation.armed.toggleOff": "Turn off the automatic trigger of {name}",
  "automation.armed.toggleOn": "Turn on the automatic trigger of {name}",
  "automation.marker.armed": "Armed",
  "automation.marker.off": "Off",
  "automation.marker.running": "Running",
  "automation.marker.runningCount": "Running {count}",
  "automation.marker.failed": "Failed",
  "automation.marker.failedLabel": "Last automatic run failed. Show recent runs of {name}",
  "automation.tooltip.lastRun": "Last run: {when}",
  "automation.tooltip.moreSteps": "{line} (+{count} more)",
  "automation.more.label": "More actions for {name}",
  "automation.empty.title": "No automations yet.",
  "automation.empty.description":
    "Record what you type in a terminal, or create one step by step. Run it with one click, on a trigger or on a schedule.",
  "automation.noResults": "No automations match “{query}”.",
  "runHistory.empty": "No runs yet.",

  // ── Automation history: one panel, unified origin labels (#5818) ────────
  "automationHistory.empty.filtered": "No runs of this automation yet.",
  "automationHistory.origin.you": "Run by you",
  "automationHistory.origin.hotkey": "Run by hotkey",
  "automationHistory.origin.trigger": "Run by trigger",
  "automationHistory.origin.schedule": "Run by schedule",
  "automationHistory.schedule": "Schedule",
  "automationHistory.due": "Due",
  "automationHistory.reason": "Reason",
  "automationHistory.origin.automation": "Run by another automation",
  "automationHistory.via.palette": "From the command palette",
  "automationHistory.via.onConnect": "When the connection opened",
  "automationHistory.via.onDisconnect": "When the connection closed",
  "automationHistory.via.onOutputMatch": "When the terminal output matched",
  "automationHistory.filter.all": "All automations",

  // ── List rows: names on the row, settings in the tooltip (#5757) ────────
  "row.tooltip.tags": "Tags: {tags}",
  "macro.tooltip.types": "Types:",
  "macro.tooltip.lastRun": "Last run: {when} on {target}",
  "schedule.marker.lastFailed": "Last run failed",
  // Tunnels, services, workspaces, agents and recent sessions (#5770).
  "tunnel.tooltip.forward": "{type} ({flag}) · {mapping}",
  "tunnel.tooltip.via": "Via {connection}",
  "tunnel.tooltip.hostLocal": "Hosted on this computer",
  "tunnel.tooltip.hostAgent": "Hosted on agent {agent}",
  "tunnel.tooltip.traffic": "↑ {up} · ↓ {down} · {active} / {total} connections",
  "tunnel.tooltip.bound": "Bound {address}: {reach}",
  "server.tooltip.listen": "{protocol} · {url}",
  "server.tooltip.root": "Serves {path}",
  "server.tooltip.readOnly": "Read only",
  "server.tooltip.agent": "Runs on agent {agent}",
  "server.editor.runOn": "Run on",
  "server.tooltip.traffic": "{active} connections · ↑ {up} · ↓ {down}",
  "workspace.tooltip.tab": "Opens {count} tab",
  "workspace.tooltip.tabs": "Opens {count} tabs",
  "workspace.tooltip.tabsInGroups": "Opens {count} tabs in {groups} groups",
  "agent.tooltip.address": "{user}@{host}:{port}",
  "agent.tooltip.version": "Agent version {version}",
  "recent.marker.pinned": "Pinned",
  "recent.tooltip.lastUsed": "Last used {when}",
  "recent.tooltip.uses": "Used {count} times",
  "recent.tooltip.saved": "Saved as a connection",
  // HTTP monitors and plugins (#5789).
  "monitor.tooltip.check": "{method} every {interval} · expects {status}",
  "monitor.tooltip.lastOk": "Last check: {status} in {latency} ms, {age}",
  "monitor.tooltip.lastDown": "Last check failed {age}",
  "monitor.tooltip.lastDownError": "Last check failed {age}: {error}",
  "monitor.marker.down": "Down",
  "monitor.marker.overdue": "Overdue",
  "monitor.marker.paused": "Paused",
  "monitor.marker.stopped": "Stopped",
  "plugin.tooltip.version": "Version {version}",
  "plugin.tooltip.author": "By {author}",
  "plugin.tooltip.id": "ID {id}",

  // ── Terminal toolbar (#5756) ────────────────────────────────────────────
  // Layout icons stay visible; session and automation actions live in the "…"
  // menu, and an active one shows as a chip beside the icons.
  "terminalToolbar.newTerminal": "New terminal",
  "terminalToolbar.splitRight": "Split terminal right",
  "terminalToolbar.splitDown": "Split terminal down",
  "terminalToolbar.closePanel": "Close panel",
  "terminalToolbar.toggleSidebar": "Toggle sidebar",
  "terminalToolbar.more": "More terminal actions",
  "terminalToolbar.broadcast.start": "Broadcast input…",
  "automation.wait.message": "Type what the terminal asks for",
  "automation.wait.password": "Type your password",
  "automation.wait.stepNote":
    "The run stops here until you press Continue above the terminal. It ends after 5 minutes without it. A schedule, On disconnect and On output match do not start an automation with this step.",
  "automation.wait.whenNote":
    "It waits for you. Schedules, On disconnect and On output match do not start it; a run On connect ends if nobody presses Continue within 5 minutes.",
  "automation.wait.title": "“{name}” waits for you in {tab}.",
  "automation.wait.then": "{message}, then Continue.",
  "automation.wait.until": "Stops at {time} if you do nothing.",
  "automation.wait.stillAsking":
    "The terminal still asks for a password. Type it and press Enter first, or the next keys go into the prompt.",
  "automation.wait.note": "Waiting for you",
  "automation.wait.unattended":
    "It stops to let you type in the terminal, and nobody is there when it starts by itself. Nothing was typed.",
  "automation.wait.toast": "“{name}” waits for you in {tab}",
  "terminalToolbar.broadcast.stop": "Stop broadcast",
  "terminalToolbar.logging.start": "Log session output",
  "terminalToolbar.logging.stop": "Stop logging output",
  "terminalToolbar.record.start": "Record automation",
  "terminalToolbar.record.stop": "Stop recording",
  "terminalToolbar.play.start": "Run automation…",
  "terminalToolbar.play.stop": "Stop automation ({played}/{total})",
  "terminalToolbar.chip.broadcast": "Broadcasting",
  "terminalToolbar.chip.logging": "Logging",
  "terminalToolbar.chip.recording": "Stop recording",
  "terminalToolbar.chip.recordingIn": "Stop recording in {tab}",
  "terminalToolbar.chip.recordingPrompt": "Stop recording (password kept apart)",
  "terminalToolbar.chip.recordingPromptTooltip":
    "Stop recording (password kept apart). You choose whether to store it when you save",
  "terminalToolbar.chip.recordingPaused": "Stop recording (not connected)",
  "terminalToolbar.chip.playback": "Stop “{name}” ({played} of {total})",
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
