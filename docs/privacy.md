# Privacy

termiHub collects no data about you. It has no telemetry, no analytics, no crash reporting
service and no account. It does not send us your connections, your passwords, your terminal
output or how you use the app.

This page lists every connection termiHub makes and everything it keeps on your computer, so
you can check that claim. It covers the desktop app and the remote agent (`termihub-agent`)
that termiHub can install on servers you connect to. It follows the transparency rules of the
EU General Data Protection Regulation (GDPR) and similar laws.

> **Who is responsible:** termiHub is a free, open-source project maintained at
> [github.com/armaxri/termiHub](https://github.com/armaxri/termiHub). Questions about this notice
> or your data: `<maintainer: add a privacy contact>`. Please don't send privacy requests as
> GitHub issues: issues are public.

## In short

- termiHub has no server of its own. Apart from the connections you open yourself, it talks
  only to GitHub: to check for termiHub updates (you can turn this off), to download an update
  or an agent binary when you ask for one, and to read the plugin index when you open it.
- Everything else stays on your computer: your settings, connections, history, logs and crash
  reports.
- Saved passwords and passphrases go to an encrypted vault or to your system's credential
  store, never into a plain file. By default termiHub saves none.

## Connections termiHub makes on its own

Each connection below goes from your computer straight to the server named. We never see this
traffic. Like any server, the one you connect to sees your IP address and the time of the
request; what else it learns is listed for each. All requests use HTTPS. GitHub handles this
data under the
[GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement);
we see only how often each release file was downloaded, not by whom.

### Update check

By default termiHub checks for a new version 5 seconds after it starts, then every 24 hours
while it runs, and never more than once an hour. It only reports what it found; it never
installs anything on its own.

- **Where:** `api.github.com`.
  - Release builds read the latest termiHub release
    (`api.github.com/repos/armaxri/termiHub/releases/latest`).
  - Development builds of the `develop` branch read the rolling `dev-develop-latest`
    pre-release (`api.github.com/repos/armaxri/termiHub/releases/tags/dev-develop-latest`)
    instead. Other development builds don't check at all.
- **What GitHub sees:** your IP address, the time, and a `User-Agent` header with the version
  you run (`termiHub/<version>`). The request carries no token, cookie or anything about your
  connections.
- **Turning it off:** set **Settings → Updates → Auto-check for updates** to **Never**. termiHub
  then checks only when you click **Check now** there.

### Downloading an update

Only when you click **Download and install** (release builds of the Windows installer, the
macOS app and the Linux AppImage), termiHub reads the signed update manifest
`github.com/armaxri/termiHub/releases/latest/download/latest.json` and downloads the update
from GitHub's release files (`github.com`, which hands the download to
`release-assets.githubusercontent.com`). It checks the update's signature before it keeps it,
and installs it only when you click **Restart to update**. Other installs (`.deb`, `.rpm`,
portable copies, development builds) open the release page in your browser instead.

### Agent binaries

When you install or update the remote agent on a server, termiHub needs the agent program for
that server's system. It uses a copy from its download cache or one bundled with the app. Only
when neither exists does it download the binary, with its `.sha256` checksum and `.sig`
signature files, from the termiHub releases on GitHub
(`github.com/armaxri/termiHub/releases/download/…`, served from
`release-assets.githubusercontent.com`). It verifies both before the binary is used, then
copies it to your server over the SSH connection you opened.

### Plugin index and plugin updates

- **Browsing plugins:** only when you click **Load plugin index** under
  **Settings → Plugins → Browse plugins**, termiHub downloads the plugin index and its
  signature. By default that is
  `raw.githubusercontent.com/armaxri/termiHub/main/plugins/index.json`; you can enter another
  index address there. Installing a listed plugin downloads its package from the address the
  index names, which can be any HTTPS server chosen by the plugin's author.
- **Plugin update checks:** off by default. If you turn on **Check for plugin updates
  automatically**, termiHub checks once a day, while at least one plugin is installed, the
  update address each installed plugin publishes and the plugin index. It downloads nothing
  until you choose to update.
- **What those servers see:** your IP address, the time and a `User-Agent` header with your
  termiHub version (`termiHub/<version>`). These requests never send cookies, credentials or
  tokens.
- **Plugins themselves:** a plugin that asks for the `network` permission can make its own
  connections. The install dialog lists every permission before you agree. Native plugins are
  off by default and run in a separate, sandboxed process.

### Guided installs and links you open

- **Guided installs:** when termiHub offers to install a missing helper (XQuartz through
  Homebrew on macOS, VcXsrv or Git for Windows through `winget` on Windows), it runs or opens
  the package manager's command only after you confirm. The package manager then downloads
  from its own sources.
- **Links:** the GitHub, license and privacy links under **Settings → About**, release pages,
  download pages for helpers, and links you click in a terminal open in your web browser. Your
  browser then connects to that site, as with any link.

### Nothing else

The app's window can't load anything from the internet: its content security policy allows
only termiHub's own files, so it uses no web fonts, scripts, images or style sheets from other
servers. The editor, fonts and icons ship inside the app.

## Connections to servers you choose

Everything else termiHub connects to is a server or device you configured, and only when you
open the connection or start the tool:

- **Terminal connections:** SSH (including jump hosts, port forwarding, X11 forwarding, SFTP and
  remote monitoring), telnet, FTP/FTPS, RDP and VNC go to the host and port you entered. Serial
  ports, local shells, Docker and WSL stay on your computer.
  Signing in to RDP with a domain account (NLA) can also contact that domain's Kerberos server.
- **Remote agent:** termiHub reaches the agent through the SSH connection you set up. Agent
  self-update is off by default and not offered in the connection editor. Only an agent started
  with it (the `allowSelfUpdate` connection setting or the agent's `--allow-self-update` flag)
  asks `api.github.com/repos/armaxri/termiHub/releases/latest` once a day from the server it runs
  on, and downloads a newer agent from the GitHub releases.
- **Network tools** (ping, traceroute, port scan, DNS lookup, HTTP monitor, Wake-on-LAN) contact
  the addresses you enter. An HTTP monitor polls its address at the interval you set until you
  stop it.
- **Embedded servers** (HTTP, FTP, TFTP) accept connections on the address and port you choose,
  while you run them.

What these servers learn is what the protocol sends: for example your user name, the commands
you type and the files you transfer. The server's owner handles that data under their own terms.

## Data kept on your computer

None of this leaves your computer unless you export or share it, and we can't see it. The
folders named below are listed per system under [Deleting it all](#deleting-it-all).

| What                                                                                                                                                                                                                 | Where                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings, connections, workspaces and the last open layout, macros, workflows, schedules, tunnels, bookmarks, Wake-on-LAN devices, HTTP monitors, embedded server definitions, the transfer queue, installed plugins | JSON files and the `plugins` folder in the config folder (`settings.json`, `connections.json`, `workspaces.json`, `last-session.json`, …)                                                                                                                                                                                                                                                                                           |
| History: recent sessions (host, port, user and connection type; never passwords), macro and workflow runs, network tool runs, HTTP monitor results                                                                   | `session-history.json`, `macro-runs.json`, `runs.json`, `network-tool-history.json`, `http-monitor-history.json` in the config folder                                                                                                                                                                                                                                                                                               |
| Host keys and certificates you trusted                                                                                                                                                                               | `ssh_known_hosts.json` and `rdp_known_hosts.json` in the config folder. termiHub also reads, but does not change, your OpenSSH `~/.ssh/known_hosts`                                                                                                                                                                                                                                                                                 |
| Saved passwords and passphrases, if you turn on credential storage (**Settings → Security → Credential storage**; off by default)                                                                                    | **Master password:** the encrypted vault `credentials.enc` in the config folder. **OS keychain:** your system's credential store (Keychain on macOS, Credential Manager on Windows, the Secret Service such as GNOME Keyring or KWallet on Linux) under the service name `termiHub`, with a list of the entry names (no secrets) in `keychain-index.json`. A backup restore can briefly add entries under `termiHub-backup-restore` |
| Unlock with Touch ID or Windows Hello, if you turn it on                                                                                                                                                             | A protected key named `termiHub-biometric-unlock-v2` (macOS Keychain or Windows Hello) and the wrapped vault key in `biometric-unlock.json`                                                                                                                                                                                                                                                                                         |
| The app log: errors, warnings and notes, which can contain host names, user names and file paths, but never passwords, keys or terminal content; at most about 15 MB                                                 | `termihub.log` and up to two older copies in the log folder                                                                                                                                                                                                                                                                                                                                                                         |
| Crash reports: what went wrong and where in termiHub's code, with passwords, host names, addresses, user names and paths masked; at most 10, each kept for 30 days                                                   | `crash-reports` in the log folder. They are never sent anywhere; termiHub offers to show them on the next start                                                                                                                                                                                                                                                                                                                     |
| Session transcripts, only for a session you start logging                                                                                                                                                            | `sessions` in the log folder, or the file you chose                                                                                                                                                                                                                                                                                                                                                                                 |
| Downloaded agent binaries                                                                                                                                                                                            | `termihub/agent-binaries` in your user cache folder                                                                                                                                                                                                                                                                                                                                                                                 |
| Downloaded plugin packages, files you drag out of the file browser on their way to your desktop                                                                                                                      | `plugin-downloads`, `plugin-updates` and `drag-out` in termiHub's cache folder                                                                                                                                                                                                                                                                                                                                                      |
| Terminal scrollback                                                                                                                                                                                                  | Memory only, while the session is open                                                                                                                                                                                                                                                                                                                                                                                              |

The window's web view keeps its own small cache in termiHub's folders. termiHub stores no data
in web storage.

**Diagnostics bundle.** **Export diagnostics…** (gear menu at the bottom of the Activity Bar)
saves a zip of the recent logs and crash reports, with your app version and system, wherever you
choose. It masks passwords, tokens, keys, host names, addresses, user names and paths, and never
includes transcripts, terminal content, connection settings or the credential store. Nothing is
uploaded; you decide whether to share it.

**Portable mode.** When termiHub runs in portable mode (a `portable.marker` file or `data/`
folder next to the program), everything termiHub writes on its own stays in that `data/` folder:
the config files, the logs, crash reports and transcripts (`data/logs`), the caches (`data/cache`),
the web view's data on Windows and Linux (`data/webview`) and temporary files such as files opened
in VS Code (`data/tmp`, emptied when termiHub starts and quits). On macOS the web view's data
folder cannot be moved, so a portable copy keeps web view data in memory only; macOS itself may
still keep its own per-app state, such as saved window state, under `~/Library`. Saved passwords
in the system keychain and system integrations you add yourself (such as the shell integration)
are stored where the system keeps them.

### On servers running the agent

When you install the remote agent, termiHub copies the agent program to the server
(`~/.local/bin/termihub-agent` by default; `%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe` on
Windows). The agent keeps its state, logs (at most about 20 MB) and crash reports in its config
folder on that server (`~/.config/termihub-agent` on Linux). If you chose to install it as a
service, the setup adds `/etc/systemd/system/termihub-agent.service`. To remove it, stop the
agent and delete these files on the server.

## Deleting it all

You can clear history from the app: **Settings → Sessions → Clear all history**, and
**Clear history** in the macro, workflow and network tool views. To remove everything, quit and
uninstall termiHub, then delete what you want to remove:

1. **Saved passwords:** before you uninstall, set **Settings → Security → Credential storage**
   to **None**. termiHub then removes the saved credentials from the vault or keychain. Or
   delete the entries named `termiHub` (and `termiHub-backup-restore`,
   `termiHub-biometric-unlock-v2`) in your system's credential store.
2. **Settings, connections, history and plugins:** the config folder.
3. **Logs, crash reports and transcripts:** the log folder.
4. **Caches and web view data:** the cache and data folders.

| System  | Config folder                                    | Log folder                             | Cache and data folders                                                                                |
| ------- | ------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/com.termihub.app` | `~/Library/Logs/com.termihub.app`      | `~/Library/Caches/com.termihub.app`, `~/Library/Caches/termihub`, `~/Library/WebKit/com.termihub.app` |
| Windows | `%APPDATA%\com.termihub.app`                     | `%LOCALAPPDATA%\com.termihub.app\logs` | `%LOCALAPPDATA%\com.termihub.app`, `%LOCALAPPDATA%\termihub`                                          |
| Linux   | `~/.config/com.termihub.app`                     | `~/.local/share/com.termihub.app/logs` | `~/.cache/com.termihub.app`, `~/.cache/termihub`, `~/.local/share/com.termihub.app`                   |

If you set `TERMIHUB_CONFIG_DIR` or `TERMIHUB_LOG_DIR`, look there instead. On Linux, if you
set `XDG_CONFIG_HOME`, `XDG_DATA_HOME` or `XDG_CACHE_HOME`, look there instead of `~/.config`,
`~/.local/share` and `~/.cache`. In portable mode, delete the `data/` folder next to the program.

## Transfers outside the EU

GitHub (owned by Microsoft) may process the update, agent and plugin index requests in the US.
These transfers rely on the EU-US Data Privacy Framework and standard contractual clauses, under
GitHub's own terms.

## Your rights

termiHub collects no personal data, so the app gives us nothing about you to copy, correct or
delete. You control everything termiHub keeps on your computer, and the steps above remove it.
For data held by GitHub, a plugin's server or the servers you connect to, contact that
provider: they decide how it is processed. For any question about this notice, write to
`<maintainer: add a privacy contact>`. You can also complain to the data protection authority
where you live.

## Changes to this notice

This notice changes when termiHub's behaviour does. The
[changelog](https://github.com/armaxri/termiHub/blob/main/CHANGELOG.md) records each change.
A check in the project's CI (`scripts/internal/check-privacy-notice.mjs`) fails when a link in
the notice breaks or when the code names an update, agent or plugin server this page doesn't
list.

_Last updated: November 2026._
