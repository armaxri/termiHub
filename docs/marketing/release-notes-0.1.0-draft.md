# v0.1.0 release notes (draft)

> **Draft for review (MKT-4).** A curated [Keep a Changelog](https://keepachangelog.com/)
> summary for the first public beta, written at **net-change** altitude — it describes what
> the release _is_, not the development path. It is **not** a mechanical dump of the 1,100+
> per-branch fragments in `docs/changes/**`; consolidating and curating those into
> `CHANGELOG.md`'s `[0.1.0]` section remains a maintainer step at release time (see
> `docs/changes/README.md`). This file is a starting point for that curation, not a
> replacement for it. Do not edit `CHANGELOG.md` from here.
>
> Last verified against `develop` at `652dff95f` (2026-10-24).

## [0.1.0] — beta (unreleased)

First public beta of termiHub — a cross-platform terminal hub that unifies local shells,
SSH, serial, telnet, Docker, and WSL connections in one VS Code-inspired workspace, with
SFTP/FTP file transfer, SSH tunnels, and (experimental) network diagnostics, embedded
servers, and remote-desktop sessions.

### Added

- **Connection types** — local shells (auto-detected zsh/bash/sh, PowerShell/cmd/Git Bash),
  SSH, serial, telnet, Docker (a new container, an already-running container, or a Compose
  service), and WSL, all configured and organized in one place.
- **SSH** — key, password, SSH agent, and keyboard-interactive (OTP / 2FA) authentication,
  agent forwarding, jump-host / `ProxyJump` chains (including references to other saved
  connections), X11 forwarding, and SFTP.
- **Telnet** — window-size and terminal-type negotiation and optional prompt-driven
  auto-login.
- **Remote agent** — an optional, auto-deployed `termihub-agent` for persistent sessions on
  headless servers that survive desktop disconnects.
- **File browsing & editing** — SFTP, local, Docker, WSL, FTP, and agent file browsers with a
  built-in Monaco editor for local and remote files; drag-and-drop upload.
- **File transfer** — FTP/FTPS connections and a managed transfer queue (concurrency limit,
  pause/resume, cancel, and automatic retry with resume).
- **SSH tunnels** — local, remote, and dynamic (SOCKS5 / SOCKS4 / SOCKS4a) port forwarding
  with session pooling, set up in the SSH connection editor.
- **Remote system monitoring** — real-time CPU, memory, disk, and network stats for SSH
  hosts.
- **Workspace & layout** — nested split views, drag-and-drop tabs across panels, tear-out
  windows, saved workspaces / tab groups, session auto-restore, and broadcast input.
- **Productivity** — a searchable command palette, find in terminal, shell integration with
  prompt navigation and command exit-status marks, inline images (SIXEL / iTerm2), macros
  (record/replay), connection folders with search and import/export, external connection
  files, and `${VAR}` environment-variable placeholders.
- **Themes** — Dark, Light, Solarized Dark / Light, and System, plus custom themes (Theme
  Editor, import/export) and plugin themes.
- **Credential storage** — OS keychain, encrypted master-password vault, or prompt-only
  mode, with a configurable auto-lock and optional Touch ID / Windows Hello unlock.
- **Backup & restore** — all app data, optionally including the encrypted credential vault,
  in one passphrase-protected file.
- **Plugin system** — installable plugins, including signed native (cdylib) backends with an
  Ed25519 trust model. Native plugins are off by default and each runs in its own
  OS-sandboxed process.
- **Diagnostics** — an in-app log viewer plus a durable, rotated, size-capped log file that
  never records secrets or terminal contents.
- **Experimental** — hidden behind **Settings → General → Allow Experimental Features**:
  remote desktop (RDP / VNC, with VNC file transfer), authored multi-step workflow
  automation, network tools (ping, traceroute, port scanner, DNS lookup, HTTP monitor,
  Wake-on-LAN), embedded HTTP / FTP / TFTP servers, and the separate SSH Tunnels view.

### Security

- No telemetry or analytics. The only unsolicited network call is an optional startup
  update-check against the GitHub Releases API, which can be disabled. An automatic daily
  plugin update check (each installed plugin's update URL and the plugin index) runs only
  if you turn it on.
- Passwords and key material are never written to the config file or the log file.
- Plugin trust model: native plugins carry an Ed25519 signature / trust status; installing
  one is an explicit trust decision. Each runs in its own OS sandbox, which limits but does
  not remove that trust.

### Known limitations (beta)

- **Unsigned binaries** — macOS Gatekeeper and Windows SmartScreen warn on first launch;
  documented per-platform workarounds apply.
- **No auto-update** — new versions are downloaded manually; the app only _notifies_ of
  updates.
- **Telnet is unencrypted** by protocol design.
- **Serial** support requires platform-specific drivers.
- **Remote desktop, workflow automation, network tools, embedded servers and the SSH
  Tunnels view are experimental** and off by default.

---

### Curation notes for the maintainer (remove before publishing)

- The `[0.1.0]` heading is marked `unreleased` here because the repo treats everything as
  pre-v0.1.0; set the real date when the tag is cut.
- The existing `CHANGELOG.md` already carries a large, detailed `[0.1.0]` block. Decide
  whether to (a) replace it with this net-change summary, (b) keep the detailed block and
  prepend this summary, or (c) merge selectively. This draft assumes a user-facing summary
  is wanted alongside or instead of the fragment-level detail.
- Cross-check against `docs/changes/**` for any user-facing capability that shipped after
  this draft was written and is not reflected above.
