# termiHub — value proposition / positioning (draft)

> **Draft for review (MKT-1).** Proposed as the top-of-`README.md` positioning block.
> Every claim is grounded in shipped capability. The tagline reuses the existing
> one-liner as a placeholder — final brand identity / tagline is a maintainer sign-off.
> `TODO(maintainer)` marks where screenshots or GIFs belong.

## One-liner (placeholder tagline)

**termiHub — one workspace for every connection you SSH, serial, or shell into.**

## Short positioning paragraph

termiHub is a modern, cross-platform terminal hub that brings all of your connections —
local shells, SSH, serial, telnet, Docker, and WSL — into a single VS Code-inspired
workspace. Instead of juggling a terminal emulator, a separate SSH client, an SFTP tool,
a serial monitor, and a bag of network utilities, you organize every connection in one
place, open them as split-view tabs, browse and edit remote files inline, and reach for
built-in tunnels, file transfer, and network diagnostics without leaving the app. A shared
Rust core powers both the desktop app and an optional remote agent, so sessions on headless
servers can survive disconnects.

> TODO(maintainer): hero screenshot of the main window (activity bar + connection tree +
> split terminal view) goes here.

## Who it's for

- **Developers and SREs** who keep many SSH targets and local shells open at once and want
  them organized in folders, workspaces, and split panes rather than scattered across
  windows.
- **Embedded / hardware and network engineers** who need serial console access, telnet to
  legacy gear, Wake-on-LAN, and quick port/DNS checks alongside their shells.
- **Homelab and infrastructure tinkerers** who want SFTP browsing, SSH tunnels, embedded
  file servers, and remote-desktop sessions in one tool.

## Why termiHub instead of a plain terminal

A plain terminal emulator gives you tabs and a shell. termiHub adds the connection- and
workflow-level layer around them:

- **Every connection type in one app.** Local shells, SSH (with jump-host / `ProxyJump`
  chains, X11 forwarding, and SFTP), serial, telnet, Docker (run-new), and WSL — configured
  once, reconnectable with a double-click.
- **Saved, organized connections.** Folder hierarchies, search, import/export, external
  connection files (share a connection list via git), and `${VAR}` environment-variable
  placeholders so shared configs work across machines.
- **Files where the shell is.** A built-in SFTP/local file browser and a Monaco-powered
  editor let you browse, upload, download, and edit remote files inline — no second tool.
- **Built-in tunnels and diagnostics.** Local / remote / dynamic (SOCKS5) SSH port
  forwarding, plus ping, traceroute, port scanner, DNS lookup, HTTP monitor, and
  Wake-on-LAN — without shelling out.
- **Layout that scales.** Horizontal/vertical splits, drag-and-drop tabs between panels,
  tear-out windows, saved workspaces, session auto-restore, and broadcast input across a
  group of terminals.

## Why termiHub instead of another terminal manager

- **Truly cross-platform, one codebase.** Windows, Linux, and macOS from a shared Rust core
  and a Tauri desktop shell — the same feature set everywhere, not a platform-specific fork.
- **Persistent sessions on headless servers.** An optional, auto-deployed `termihub-agent`
  keeps sessions alive across desktop disconnects — closer to a tmux-backed workflow than a
  stateless SSH client, but managed from the GUI.
- **Local-first and quiet by default.** No telemetry or analytics. The only network call
  termiHub makes on its own is an optional startup check of the GitHub Releases API to
  notify you of new versions — and that can be turned off.
- **Extensible.** A plugin system (including signed native backends) lets you add
  connection types and tools; connection forms are schema-driven, so new types render their
  own settings UI automatically.

> TODO(maintainer): a short GIF (open a connection → split → browse files) would strengthen
> this section.

## Honesty notes (keep in the public copy)

These are stated plainly in the current README and should stay in any public positioning:

- **Beta, unsigned binaries.** v0.1.0 binaries are unsigned; macOS Gatekeeper and Windows
  SmartScreen warn on first launch (documented workarounds exist). No auto-update.
- **Docker is run-new only.** termiHub starts a new container from an image and opens a
  shell; attaching to an already-running container is not yet supported.
- **Remote desktop (RDP / VNC) and workflow automation are experimental**, hidden behind
  **Settings → General → Allow Experimental Features**.
- **Telnet is unencrypted** by protocol design.
