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
  "workflow.trigger.onOutputMatch.cooldown": "Wait before it may start again (seconds)",
  "workflow.trigger.onOutputMatch.cooldownHint": "1 to 86400. Empty means 10.",
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
    "Will not run on a schedule: it asks for “{name}”, which has no default value. Give it one in the automation.",
  "schedule.unattended.defaults": "Does not ask, it uses the default values: {list}.",
  "schedule.unattended.emptyValue": "(empty)",
  "schedule.unattended.password":
    "It types “{command}”. If that asks for a password, nobody is there to enter it and the run cannot finish. Run it by hand instead.",
  "schedule.unattended.passwordWait":
    "It waits for a password question. Nobody is there to answer it, so the run cannot finish.",
  "schedule.unattended.waits":
    "Will not run on a schedule: step {step} waits for you. Choose another automation, or remove that step.",
  "schedule.skip.waits":
    "It stops to let you type in the terminal, and nobody is there on a schedule",
  "schedule.skip.noneOpen": "None of its connections was open",
  "schedule.skip.noneOpenSkip":
    "None of its connections was open, and the schedule is set to skip closed ones",
  "schedule.skip.missingValue":
    "It asks for “{name}”, which has no default value. Nobody is there to enter one",
  "schedule.onlyWhileOpen": "Runs only while termiHub is open and this computer is awake.",
  "schedule.missed.skip":
    "A run that is due while termiHub is closed or the computer sleeps is skipped.",
  "schedule.missed.once":
    "A run that is due while termiHub is closed or the computer sleeps is made up once, when both are back.",
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
  "schedule.last.canceled": "Last run was stopped ({when})",
  "schedule.last.skipped": "Last run skipped: {reason} ({when})",
  "schedule.last.missed": "Last run missed: {reason} (due {when})",
  "schedule.last.unknownReason": "no reason recorded",
  "schedule.outcome.completed": "Completed",
  "schedule.outcome.partly": "Completed, some left out",
  "schedule.outcome.failed": "Failed",
  "schedule.outcome.canceled": "Stopped",
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
  "schedule.summary.whenOn": "When switched on: next run {when} on {targets}.",
  "schedule.summary.onNext": "On. Next run: {when} on {targets}.",
  "schedule.summary.cannot": "Will not run on a schedule.",
  "schedule.summary.repair": "Choose a connection, or remove the schedule.",
  "schedule.summary.toSave": "To save: {list}.",
  "schedule.missing.name": "give it a name",
  "schedule.missing.automationId": "choose an automation",
  "schedule.missing.connectionIds": "choose a connection",
  "schedule.missing.groupId": "choose a broadcast group",
  "schedule.missing.ifClosed": "choose what happens if a connection is closed",
  "schedule.missing.days": "choose a day",
  "schedule.missing.when": "correct when it runs",
  "schedule.missing.description": "shorten the description",
  "schedule.missing.targets": "choose a connection that still exists",
  "schedule.missing.pick": "choose an automation that may run here",
  "schedule.save.andSwitchOn": "Save and switch on…",
  "schedule.switchOn": "Switch on…",
  "schedule.repair": "Choose a connection",
  "schedule.editAutomation": "Edit the automation",
  "schedule.confirm.does": "What it types there ({steps}):",
  "schedule.short.localProcess": "it needs experimental features",
  "schedule.short.waits": "a step waits for you",
  "schedule.short.missing": "it asks for a value",
  "schedule.next.missed":
    "Keep termiHub open and the computer awake at that time, or set “If a run is missed” to run it later.",
  "schedule.next.closed":
    "Open the connection before that time, or set “If a connection is closed” to connect it.",
  "schedule.summary.off": "Off until you switch it on in the list.",
  "schedule.summary.switchesOff":
    "Saving switches it off, because what it may do changes. Switch it on again in the list.",
  "schedule.summary.paused": "All schedules are paused.",
  "schedule.summary.skips": "Skipped where the connection is closed.",
  "schedule.saved.off": "Saved “{name}”, switched off",
  "schedule.saved.offHint": "Switch it on in the Schedules list.",
  "schedule.confirm.title": "Switch on “{name}”?",
  "schedule.confirm.message":
    "{rule}, termiHub runs “{action}” and types into every connected terminal of these connections, without asking:",
  "schedule.confirm.next": "First run: {when}.",
  "schedule.confirm.skips": "A connection that is closed at that time is skipped.",
  "schedule.confirm.gone": "Nothing will run: {reason}.",
  "schedule.confirm.foot": "You can switch it off, or pause all schedules, at any time.",
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

  // ── The question before a local program runs (#1857, #6019) ─────────────
  "localProcess.title": "Run a local program?",
  "localProcess.imported.title": "Run a local program of an imported automation?",
  "localProcess.imported.lead":
    "“{name}” came from a file or a backup, or was changed outside termiHub. It wants to run this command on this computer. Allow it only if you know what it does.",
  "localProcess.imported.leadOther":
    "“{name}” wants to run this command on this computer. {imported} is part of it and came from a file or a backup, or was changed outside termiHub. Allow it only if you know what it does.",
  "localProcess.imported.leadOthers":
    "“{name}” wants to run this command on this computer. {imported} are part of it and came from a file or a backup, or were changed outside termiHub. Allow it only if you know what it does.",
  "localProcess.emptyArg": "(empty)",
  "localProcess.once": "Allow once",
  "localProcess.always": "Always allow",
  "localProcess.alwaysCommand": "Allow this command",
  "localProcess.alwaysAnyway": "Always allow anyway",
  "localProcess.back": "Back",
  "localProcess.note.program":
    "“Always allow” remembers this file, with any arguments, for every automation you made here; manage or revoke it later under Settings → Security.",
  "localProcess.note.command":
    "“Allow this command” remembers exactly this command for this automation. It asks again when the program, its file or an argument changes.",
  "localProcess.note.nothing":
    "This command belongs to no saved automation, so it can only be allowed this time.",
  "localProcess.interpreter.title": "“{program}” runs whatever it is told to.",
  "localProcess.interpreter.text":
    "If you always allow {path}, every automation you made here may run any command on this computer through it, without asking. “Allow once” allows only this command, now.",

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
  "tunnel.editor.missingConnection":
    "The SSH connection this tunnel used was deleted. Choose another SSH connection.",
  "tunnel.editor.type": "What it is for",
  "tunnel.editor.target.local": "What to reach",
  "tunnel.editor.target.remote": "What runs here",
  "tunnel.editor.target.remote.there": "What runs there",
  "tunnel.editor.target.port": "Its port",
  "tunnel.editor.target.port.placeholder": "e.g. 5432",
  "tunnel.editor.target.missing": "Enter what to reach, for example db.internal.",
  "tunnel.sentence.local.open": "It reaches what you enter above, through {server}.",
  "tunnel.name.remote": "Port {port} for {server}",
  "tunnel.name.dynamic": "Browse through {server}",
  "tunnel.editor.name.placeholder.remote": "e.g. My web app",
  "tunnel.editor.name.placeholder.dynamic": "e.g. Office network",
  "tunnel.editor.server": "Through",
  "tunnel.editor.noServer": "No SSH connections available",
  "tunnel.editor.runOn": "Run on",
  "tunnel.editor.runsOn": "Runs on",
  "tunnel.editor.port.here": "Open it here on port",
  "tunnel.editor.port.there": "Open it there on port",
  "tunnel.editor.port.server": "Open it on the server on port",
  "tunnel.editor.name.placeholder": "e.g. Dev database",
  "tunnel.editor.description.placeholder": "One short line for the sidebar",
  "tunnel.editor.who.server": "Only {server} itself",
  "tunnel.editor.who.anyoneServer": "Anyone who reaches {server}",
  "tunnel.editor.who.oneServer": "Anyone who reaches one address of {server}",
  "tunnel.editor.letOthers": "Let others reach it",
  "tunnel.editor.bringHere": "Bring it to this computer",
  "tunnel.editor.broughtHere": "Its part on this computer",
  "tunnel.editor.bringHere.offline": "Agent {agent} is offline. Connect it first.",
  "tunnel.editor.showPath": "Show path",
  "tunnel.editor.hidePath": "Hide path",
  "tunnel.editor.autoStart": "Start when termiHub starts",
  "tunnel.editor.startWithConnection": "Start when a session to {server} opens",
  "tunnel.editor.reconnect": "Reconnect when the connection drops",
  "tunnel.editor.start": "Start",
  "tunnel.editor.missing.host": "a host",
  "tunnel.editor.missing.server": "an SSH connection",
  "tunnel.warn.local": "{whom} can reach {target} with it. Nobody is asked for a password.",
  "tunnel.warn.remote":
    "{whom} can reach {target} from {machine}, if the SSH server allows it (OpenSSH: GatewayPorts).",
  "tunnel.warn.dynamic":
    "{whom} can browse through {server} with it. Nobody is asked for a password.",
  "tunnel.sentence.local": "It reaches {target} through {server}.",
  "tunnel.sentence.remote": "It reaches {target} from {machine}.",
  "tunnel.sentence.dynamic":
    "Set your browser's or system's proxy to SOCKS5, host {host}, port {port}. It then browses through {server}.",
  "tunnel.reach.serverOnly": "reachable only from the SSH server itself",
  "tunnel.reach.serverDecides":
    "the SSH server decides who reaches it (OpenSSH needs GatewayPorts for others)",
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
  "automation.run.target": "Run in {target} ({keys})",
  "automation.run.noTarget": "Run… (no active terminal: choose where)",
  "automation.run.label": "Run {name}",
  "automation.run.labelPick": "Run {name} on…",
  "automation.stop.label": "Stop {name}",
  "automation.stop.allLabel": "Stop {name} on every terminal",
  "automation.stop.all": "Stop all {count}",
  "automation.stop.target": "Stop on {target}",
  "automation.triggers.on": "Triggers on: {triggers}",
  "automation.triggers.off": "Triggers off: {triggers} does not start it. You can still run it.",
  "automation.triggers.onState": "Triggers on",
  "automation.triggers.offState": "Triggers off",
  "automation.triggers.editorOn":
    "The triggers below, hotkeys included, can start it. Schedules have their own switch.",
  "automation.triggers.editorOff":
    "Nothing below starts it. You can still run it, and schedules have their own switch.",
  "automation.triggers.toggleOff": "Turn off the triggers of {name}",
  "automation.triggers.toggleOn": "Turn on the triggers of {name}",
  "automation.triggers.toggleFailed": "The triggers of “{name}” could not be changed",
  "automation.importedInPart":
    "Imported in part: left out {parts}, which this version does not know.",
  "automation.importedCheck": "Check it",
  "automation.importedNote":
    "Imported in part, without {parts}, which this version does not know. Check what it does, then save it.",
  "automation.blockedShort.unknown": "needs a newer termiHub",
  "automation.blockedShort.local": "needs experimental features",
  "automation.replace.title": "Run “{name}”?",
  "automation.replace.message": "{running}. Running this stops that there; it is not resumed.",
  "automation.replace.one": "“{name}” is running in {where}, {progress}",
  "automation.replace.accept": "Stop it and run",
  "automation.triggerHint.hotkey": "When you press keys in a terminal",
  "automation.triggerHint.onConnect": "When a connection opens",
  "automation.triggerHint.onDisconnect": "When a connection closes",
  "automation.triggerHint.onOutputMatch": "When a terminal shows a text",
  "automation.triggerHint.schedule": "At a time, again and again",
  "automation.triggers.offMany": "Triggers off: {triggers} do not start it. You can still run it.",
  "automation.deletedConnection": "a deleted connection",
  "automation.program.refused": "You did not allow “{program}”. Nothing of it was started.",
  "automation.program.stops": "Don't allow: the step fails and the run stops.",
  "automation.program.goesOn": "Don't allow: the step fails and the run goes on.",
  "automation.startBlocked.waits": "step {step} waits for you",
  "automation.startBlocked.missing": "it asks for “{name}”, which has no default value",
  "automation.startBlocked.gone": "its connection was deleted",
  "automation.startBlocked.goneAll": "its connections were deleted",
  "automation.startBlocked.menu": "Cannot start this: {reason}",
  "automation.startBlocked.card": "Will not start it: {reason}.",
  "automation.startBlocked.one": "The trigger {trigger} will not work: {reason}.",
  "automation.startBlocked.row": "{trigger} will not start it: {reason}.",
  "automation.triggers.none": "No trigger can start it: {reason}.",
  "automation.triggers.cannotRun": "it cannot run",
  "automation.triggers.noneState": "No trigger can start it",
  "automation.trigger.hotkey": "hotkey {keys}",
  "automation.trigger.onConnect": "connecting to {connections}",
  "automation.trigger.onDisconnect": "disconnecting from {connections}",
  "automation.trigger.onOutputMatch": "matching output in {connections}",
  "automation.schedule.next": "Next run {when}",
  "automation.schedule.nextOf": "Next run {when} ({count} schedules)",
  "automation.schedule.still": "Schedule still on: next run {when}",
  "automation.schedule.blocked": "Schedule will not run: {reason}",
  "automation.schedule.paused": "Schedules paused",
  "automation.schedule.on": "Schedule on",
  "automation.blocked.unknownStep":
    "Step {step} ({kind}) is from a newer termiHub. Update termiHub or delete the step.",
  "automation.blocked.unknownStepIn":
    "Step {step} runs “{name}”, which has a step ({kind}) from a newer termiHub. Update termiHub or delete the step.",
  "automation.blocked.localProcess":
    "It starts a program on this computer, which is experimental. Turn on {path}.",
  "automation.blocked.label": "Cannot run. Edit {name}",
  "automation.marker.blocked": "Cannot run",
  "automation.marker.waiting": "Waiting for you",
  "automation.running.step": "in {tab}, step {step} of {total}",
  "automation.running.typed": "in {tab}, {percent} % typed",
  "automation.running.waiting": "in {tab}, step {step} of {total} waits for you",
  "automation.running.show": "Show {tab}",
  "automation.marker.running": "Running",
  "automation.marker.runningCount": "Running {count}",
  "automation.marker.failed": "Failed",
  "automation.marker.failedLabel": "Last run failed. Show recent runs of {name}",
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
  "automationHistory.origin.you": "You",
  "automationHistory.origin.hotkey": "Hotkey",
  "automationHistory.origin.trigger": "Trigger",
  "automationHistory.origin.schedule": "Schedule",
  "automationHistory.origin.scheduleNamed": "Schedule “{name}”",
  "automationHistory.schedule": "Schedule",
  "automationHistory.due": "Due",
  "automationHistory.reason": "Why",
  "automationHistory.origin.automation": "Another automation",
  "automationHistory.deleted": "The automation was deleted.",
  "automationHistory.next.continue":
    "Run it again and press Continue once you have typed what the terminal asks for.",
  "automationHistory.next.attended":
    "Run it yourself, or take the Wait for you step out to let it start by itself.",
  "automationHistory.next.reconnect": "Connect the terminal again, then run it again.",
  "automationHistory.next.pattern":
    "Check in the terminal what was printed, then correct the pattern or give it more time.",
  "automationHistory.next.allow":
    "Allow the program under Settings ▸ Security, or run the automation yourself and allow it when asked.",
  "automationHistory.next.program": "The program itself failed. Run it by hand to see why",
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
  "tunnel.tooltip.hostLocal": "Runs on this computer",
  "tunnel.tooltip.hostAgent": "Runs on agent {agent}",
  "tunnel.tooltip.socks":
    "Set your browser's or system's proxy to SOCKS5, host {host}, port {port}.",
  "service.tooltip.traffic": "{active} now, {total} in all · sent {up} · received {down}",
  "service.tooltip.connection": "1 connection",
  "service.tooltip.connections": "{count} connections",
  "tunnel.tooltip.bound": "Bound {address}: {reach}",
  "server.tooltip.listen": "{protocol} · {url}",
  "server.tooltip.root": "Serves {path}",
  "server.tooltip.readOnly": "Download only",
  "server.tooltip.here": "Runs on this computer",
  "server.tooltip.agent": "Runs on agent {agent}",
  "server.tooltip.agentRemoved": "Runs on an agent that was removed",
  // The states of a service (#6028), tunnels and file servers alike.
  "service.state.stopped": "Stopped",
  "service.state.waiting": "Waiting",
  "service.state.starting": "Starting",
  "service.state.running": "Running",
  "service.state.reconnecting": "Reconnecting",
  "service.state.stopping": "Stopping",
  "service.state.error": "Error",
  "service.state.needsConnection": "Needs a connection",
  "service.state.notReachable": "Not reachable",
  // A stop that waits for its agent; "Stopping" is the moment in which it closes.
  "service.state.stopPending": "Stop pending",
  // What a file server is for (#6028, #6036), in the same words everywhere.
  "share.type.label": "What it is for",
  "share.type.http.label": "Web server",
  "share.type.http.summary": "Open a folder in a browser",
  "share.type.http.fact": "Anyone with a browser; nothing to install",
  "share.type.http.lead": "Share a folder that others open in a web browser.",
  "share.type.http.how":
    "Runs a web server on {machine}. Others can list and download files, not upload. A sign-in is optional.",
  "share.type.http.example": "Example: hand a build to a colleague on the same network.",
  "share.type.ftp.label": "FTP server",
  "share.type.ftp.summary": "Upload and download files",
  "share.type.ftp.fact": "Needs an FTP program; others can upload if you allow it",
  "share.type.ftp.lead": "Share a folder with programs and devices that speak FTP.",
  "share.type.ftp.how":
    "Runs an FTP server on {machine}. Others get files, and put files unless it is only for download. They sign in, or not when you allow it.",
  "share.type.ftp.example": "Example: a scanner or a camera that stores its files by FTP.",
  "share.type.tftp.label": "TFTP server",
  "share.type.tftp.summary": "Give files to a device",
  "share.type.tftp.fact": "For switches, routers, phones; no password",
  "share.type.tftp.lead": "Give files to devices that only speak TFTP.",
  "share.type.tftp.how":
    "Runs a TFTP server on {machine}. There is no sign-in: whoever reaches it gets files, and puts files unless it is only for download.",
  "share.type.tftp.example": "Example: firmware or network boot for a router or a phone.",
  // What a service row says and offers (#6028).
  "service.what.local": "Reach {target} through {server}",
  "service.what.local.server": "Reach something on {server}",
  "service.what.remote": "Let {server} reach this computer",
  "service.what.remote.target": "Let {server} reach {target}",
  "service.what.remote.there": "Let {server} reach that machine",
  "service.what.dynamic": "Browse through {server} (SOCKS5)",
  "service.what.unknownServer": "the SSH server",
  "service.what.http": "Open a folder in a browser",
  "service.what.ftp.readOnly": "Download only",
  "service.what.ftp.write": "Download and upload",
  "service.what.tftp.readOnly": "Give files to a device",
  "service.what.tftp.write": "Give and receive files",
  "service.risk.upload.here": "Anyone on your network can upload",
  "service.risk.upload.there": "Anyone who reaches that machine can upload",
  // Who reaches a running service, beside its address (#6063).
  "service.reach.here": "only this computer",
  "service.reach.noDevice": "Only this computer, no device can reach it.",
  "service.reach.noDeviceThere": "Only that machine, no device can reach it.",
  "service.reach.network": "anyone on your network",
  "service.reach.network.password": "anyone on your network with the password",
  "service.reach.networkUnknown":
    "Open to your network. This computer has no network address now; it appears here once you are connected. Port {port}.",
  "service.reach.onlyThere": "only on that machine",
  "service.reach.anyoneThere": "anyone who reaches that machine",
  "service.reach.anyoneThere.password": "anyone who reaches that machine, with the password",
  "service.reach.thereUnknown":
    "Open to that machine's network. Its address is not known. Port {port}.",
  "service.reach.onlyOn": "only on {machine}",
  "service.reach.anyoneOn.ifAllowed": "anyone who reaches {machine}, if its SSH server allows it",
  "service.reach.anyoneOn": "anyone who reaches {machine}",
  "service.reach.onUnknown": "Open to {machine}'s network. Its address is not known. Port {port}.",
  // The part of a chained tunnel that runs on this computer.
  "service.chain.hopName": "On this computer",
  "service.chain.hopWhat": "Brings it to this computer",
  "service.chain.notHere": "Does not work on this computer, see below.",
  // How many of a list run.
  "service.counts.running": "{running} of {total} running",
  "service.counts.error": "{count} errors",
  "service.counts.error.one": "1 error",
  "service.counts.needsConnection": "{count} need a connection",
  "service.counts.needsConnection.one": "1 needs a connection",
  "service.counts.notKnown": "{count} not known",
  "service.counts.reconnecting": "{count} reconnecting",
  "service.counts.waiting": "{count} waiting",
  "service.counts.label": "Show only",
  "service.counts.shown": "{shown} of {total} shown",
  "service.only.running": "Only running services.",
  "service.only.error": "Only errors.",
  "service.only.notKnown": "Only what is not known.",
  "service.only.reconnecting": "Only what reconnects.",
  "service.only.waiting": "Only what waits.",
  "service.only.all": "Show all",
  "service.where.here": "this computer",
  "service.where.agent": "agent {agent}",
  "service.where.agentRemoved": "a removed agent",
  "service.where.agentUnknown": "an agent",
  "service.where.unknown": "an unknown machine",
  "service.addressCopied": "Copied the address",
  "service.addressCopied.onlyOn": "Copied. Works only on {machine}",
  "service.more": "More",
  "service.menu": "Service actions",
  "service.moreActions": "More actions for {name}",
  "service.next.chooseConnection": "Choose connection",
  "service.next.usePort": "Use {port}",
  "service.next.edit": "Edit",
  "service.next.connectAgent": "Connect agent",
  "service.next.keepRunning": "Keep running",
  "service.next.letReach": "Let devices reach it",
  "service.next.checkAgain": "Check again",
  "service.next.chooseMachine": "Choose machine",
  "service.next.unlock": "Unlock",
  "service.next.editConnection": "Edit connection",
  "service.next.retryNow": "Retry now",
  "service.reason.portHeld": 'Port {port} is used by "{name}".',
  "service.reason.agentRemoved": "Its agent was removed from termiHub. It may still run there.",
  "service.reason.needsConnection": "Its SSH connection was deleted.",
  "service.action.start": "Start",
  "service.action.stop": "Stop",
  "service.action.cancelStart": "Cancel start",
  "service.action.cancel": "Cancel",
  "service.action.stopWaiting": "Cancel waiting",
  "service.action.retry": "Retry",
  "service.action.copyAddress": "Copy address",
  "service.action.openInBrowser": "Open in browser",
  "service.action.activity": "Activity",
  "service.action.edit": "Edit",
  "service.action.restart": "Restart",
  "service.action.duplicate": "Duplicate",
  "service.action.delete": "Delete",
  // Where a service runs (#6028): a stored host this build does not know.
  "service.host.unreadable": "termiHub cannot read where it runs",
  "service.host.moveHint":
    "It is running. Saving stops it; start it again to run it on the machine you chose.",
  // Stop, restart and delete, for both kinds (#6068).
  "service.confirm.stop.title": 'Stop "{name}"?',
  "service.confirm.restart.title": 'Restart "{name}"?',
  "service.confirm.stopAll.title": "Stop all services?",
  "service.stopAll": "Stop all services",
  "service.stopAll.failed": "Not every service could be stopped",
  "service.confirm.drops.one": "1 connection is open now. It will be dropped.",
  "service.confirm.drops": "{count} connections are open now. They will be dropped.",
  "service.delete.title": 'Delete "{name}"?',
  "service.delete.running": "It is running. Deleting stops it.",
  "service.delete.running.one": "It is running. Deleting stops it and breaks 1 open connection.",
  "service.delete.running.more":
    "It is running. Deleting stops it and breaks {count} open connections.",
  "service.delete.idle": "It is not running.",
  "service.delete.notReachable":
    "It may still run on its agent, which is offline. It will be stopped when the agent is back.",
  "service.delete.hop":
    "It is the part of a chained tunnel on this computer. Without it localhost no longer reaches the port; the part on the agent stays.",
  "service.delete.parent": 'Its part on this computer, "{name}", is deleted, too.',
  "service.delete.folder": "The folder and its files stay.",
  "service.delete.undo": "You can undo it right after.",
  // The Services sidebar (#6028).
  "service.palette.show": "Show services",
  "service.palette.new": "New service: {what} · {technical}",
  "service.new": "New service",
  "service.actions": "Service actions",
  "service.list": "Services",
  "service.unnamed": "this service",
  "service.search": "Search services",
  "service.search.clear": "Clear search",
  "service.search.none":
    'No service matches "{query}". Search finds names, types, machines, folders and ports.',
  "service.group.tunnels": "SSH tunnels",
  "service.group.fileServers": "File servers",
  "service.agent.stopping": "Offline. {services} will be stopped when it is back.",
  "service.agent.keepAll": "Keep all running",
  "service.agent.keepFailed": "Failed to keep them running",
  "service.agent.offline": "Offline. {services} run there or may; termiHub cannot tell.",
  "service.agent.tunnel": "1 tunnel",
  "service.agent.tunnels": "{count} tunnels",
  "service.agent.server": "1 file server",
  "service.agent.servers": "{count} file servers",
  "service.agent.both": "{tunnels} and {servers}",
  "service.empty.title": "No services yet.",
  "service.empty.text":
    "A service lets you use something through an SSH server, or gives a folder to others.",
  "service.empty.noConnection": "Connecting through SSH needs a saved SSH connection.",
  "service.empty.newConnection": "New connection",
  "service.new.group.ssh": "Connect through SSH",
  "service.new.local": "Reach something through a server",
  "service.new.local.technical": "SSH tunnel, local (ssh -L)",
  "service.new.local.example": "Such as a database.",
  "service.new.remote": "Let a server reach something here",
  "service.new.remote.technical": "SSH tunnel, remote (ssh -R)",
  "service.new.remote.example": "Such as a web app.",
  "service.new.dynamic": "Browse through a server",
  "service.new.dynamic.technical": "SOCKS5 proxy, dynamic (ssh -D)",
  "service.new.dynamic.example": "As if you were there.",
  "service.new.group.share": "Share a folder",
  "service.new.http": "Open it in a browser",
  "service.new.http.technical": "Web server (HTTP)",
  "service.new.ftp": "Upload and download files",
  "service.new.ftp.technical": "FTP server",
  "service.new.tftp": "Give files to a device",
  "service.new.tftp.technical": "TFTP server, firmware and network boot",
  // A file server's Activity panel (#6063).
  "server.activity.close": "Close activity",
  "server.activity.nobody": "Nobody has connected yet.",
  "server.activity.nobody.hint": "Requests and connected devices appear here.",
  "server.activity.now": "Now",
  "server.activity.transfer": "{client} · {amount} so far",
  "server.activity.someone": "Unknown device",
  "server.activity.copy": "Copy",
  "server.activity.copy.label": "Copy requests",
  "server.activity.clear": "Clear",
  "server.activity.clear.label": "Clear requests",
  "server.activity.unavailable": "Activity is not available.",
  "server.activity.noAnswer": "The server runs. Its activity could not be read.",
  "server.activity.oldAgent": "Update agent {agent} to see who uses the server.",
  "server.activity.notYet": "Nothing yet.",
  "server.activity.appearsWhenRun":
    "Requests and connected devices appear here once the server runs.",
  "server.editor.copyHint":
    "A copy does not get the password. Enter it here, or the copy cannot start.",
  "server.editor.runOn": "Run on",
  // The file server dialog (#6063).
  "service.editor.new": "New service · {technical}",
  "service.editor.changeType": "Change what it is for",
  "service.editor.afterRestart": "Changes apply when it restarts.",
  "service.editor.portTaken": 'Port {port} is used by "{name}".',
  "service.editor.save": "Save",
  "service.editor.saveAndStart": "Save and start",
  "service.editor.saveAndRestart": "Save and restart",
  "server.editor.folder": "Folder to share",
  "server.editor.folder.there": "A folder on that machine, as a full path.",
  "server.editor.folder.choose": "Choose…",
  "server.editor.name.placeholder": "The folder's name",
  "server.editor.who": "Who can open it",
  "server.editor.listing": "Show the list of files",
  "server.editor.askPassword": "Ask for a password",
  "server.editor.who.here": "Only this computer",
  "server.editor.who.network": "Anyone on your network",
  "server.editor.who.there": "Only that machine",
  "server.editor.who.anyoneThere": "Anyone who reaches that machine",
  "server.editor.missing": "Still needed: {fields}",
  "server.editor.copyName": "Copy of {name}",
  "server.editor.saveFailed": "Failed to save the file server",
  "server.editor.startFailed": "Failed to start {name}",
  "server.editor.port": "Port",
  "server.editor.tftp.other":
    "Devices usually ask on port 69. Set the device to port {port}, or use 69 here.",
  "server.editor.tftp.69.free": "Devices ask on this port by default.",
  "server.editor.tftp.69.linux":
    "Devices ask on this port by default. On Linux, only an administrator may open it: start termiHub so, or allow it (CAP_NET_BIND_SERVICE).",
  "server.editor.tftp.69.agent":
    "Devices ask on this port by default. On Linux, the agent may open it only as an administrator or with CAP_NET_BIND_SERVICE.",
  "server.editor.who.devices": "Devices and anyone else on your network",
  "server.editor.who.one.here": "Anyone who reaches one address of this computer",
  "server.editor.who.one.there": "Anyone who reaches one address of that machine",
  "server.editor.who.address": "Address",
  "server.editor.who.address.placeholder": "10.0.0.5",
  "server.editor.address": "Address:",
  "server.editor.can": "What they can do",
  "server.editor.can.download": "Download only",
  "server.editor.can.upload": "Download and upload",
  "server.editor.username": "User name",
  "server.editor.password": "Password",
  "server.editor.password.saved": "Saved, leave blank to keep",
  "server.editor.name": "Name",
  "server.editor.description": "Description (optional)",
  "server.editor.description.placeholder": "One short line for the sidebar",
  "server.editor.autoStart": "Start when termiHub starts",
  "server.editor.error.folder": "Choose the folder to share.",
  "server.editor.error.name": "Name is required.",
  "server.editor.error.who": "Choose who can open it.",
  "server.editor.error.port": "Port is required.",
  "server.editor.error.username": "User name is required.",
  "server.editor.error.password": "Password is required.",
  "server.editor.missing.username": "a user name",
  "server.editor.missing.password": "a password",
  "server.warn.whom.network": "Anyone on your network",
  "server.warn.whom.there": "Anyone who reaches that machine",
  "server.warn.whom.address": "Anyone who reaches {addr}",
  "server.warn.download": "{whom} can get these files.",
  "server.warn.upload": "{whom} can get these files, change them and put files there.",
  "server.warn.password": "They need the password. Nothing is encrypted, the password neither.",
  "server.warn.noPassword": "Nobody is asked for a password, and nothing is encrypted.",
  "server.warn.tftp": "TFTP has no password, and nothing is encrypted.",
  "server.editor.missing.folder": "the folder",
  "server.editor.missing.who": "who can open it",
  "server.editor.missing.name": "a name",
  "server.editor.missing.port": "the port",
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
    "The run pauses here until you press Continue above the terminal. It ends if you do not press it within 5 minutes. Cannot be started by a schedule, by a closing connection or by matching output.",
  "automation.wait.whenNote":
    "Step {step} waits for you. Started on connect, it ends after 5 minutes without Continue. It cannot be started by a schedule, on disconnect or on output match.",
  "automation.wait.title": "“{name}” waits for you in {tab}.",
  "automation.wait.then": "{message}, then Continue.",
  "automation.wait.passwordThen":
    "Type your password and press Enter in the terminal, then Continue.",
  "automation.wait.messageThen":
    "Type what the terminal asks for and press Enter there, then Continue.",
  "automation.wait.passwordHidden": "Show it, type your password and press Enter.",
  "automation.wait.messageHidden": "Show it and type what it asks for.",
  "automation.wait.hidden": "Show it first: {message}.",
  "automation.wait.show": "Show {tab}",
  "automation.wait.answered": "No password prompt any more. Press Continue to go on.",
  "automation.wait.until": "Stops at {time} if you do nothing.",
  "automation.wait.stillAsking":
    "The terminal still asks for a password. Type it and press Enter first, or the next keys go into the prompt.",
  "automation.wait.checking": "Looking at what the terminal prints…",
  "automation.wait.unchecked":
    "It cannot be told yet whether the terminal asks for a password: it still prints. Look at it first, or the next keys may go into a prompt.",
  "automation.wait.elsewhere":
    "Another window or computer controls this terminal. Take it back first, then press Continue.",
  "automation.wait.note": "Waiting for you",
  "automation.wait.unattended":
    "It stops to let you type in the terminal, and nobody is there when it starts by itself. Nothing was typed.",
  "terminalToolbar.broadcast.stop": "Stop broadcast",
  "terminalToolbar.logging.start": "Log session output",
  "terminalToolbar.logging.stop": "Stop logging output",
  "terminalToolbar.record.start": "Record automation",
  "terminalToolbar.record.stop": "Stop recording",
  "terminalToolbar.play.start": "Run automation…",
  "terminalToolbar.play.stop": "Stop automation ({percent} % typed)",
  "terminalToolbar.chip.broadcast": "Broadcasting",
  "terminalToolbar.chip.logging": "Logging",
  "terminalToolbar.chip.recording": "Stop recording",
  "terminalToolbar.chip.recordingIn": "Stop recording in {tab}",
  "recording.leaveOut":
    "Leave it out. The run pauses here until you typed it and pressed Continue. Cannot be started by a schedule, by a closing connection or by matching output.",
  "recording.noEnter": "It ends without Enter: the last line is typed but not sent.",
  "recording.secretUnknown":
    "Some of what you typed may be a password: the terminal was still printing.",
  "recording.secretAt": "You typed at a password prompt ({prompts}).",
  "recording.secretStored": "An automation stores what it types unencrypted.",
  "recording.promptNote":
    "Password prompt: what you type now is kept out of the recording. When saving you decide whether to store it.",
  "terminalToolbar.chip.recordingPaused": "Stop recording (not connected)",
  "terminalToolbar.chip.playback": "Stop “{name}” ({percent} % typed)",
  "terminalToolbar.chip.playbackSeveral": "Stop “{name}” in {count} terminals",
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
