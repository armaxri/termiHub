# termiHub — feature matrix (draft)

> **Draft for review (MKT-2).** A compact capability matrix grouped by area, one line each.
> Status is honest: **Stable** = generally available; **Beta** = shipped but rough edges
> expected in v0.1.0; **Experimental** = behind **Settings → General → Allow Experimental
> Features**. Grounded in the current `README.md` and shipped code.
>
> Last verified against `develop` at `652dff95f` (2026-10-24).

## Connections

| Capability   | Description                                                                                                                                         | Status |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Local shells | Auto-detected zsh / bash / sh, and PowerShell / cmd / Git Bash on Windows                                                                           | Stable |
| SSH          | Key, password, SSH agent & keyboard-interactive (OTP / 2FA) auth, agent forwarding, jump-host / `ProxyJump` chains, X11 forwarding, tunneling, SFTP | Stable |
| Serial       | Direct serial-port access (baud/data/stop/parity/flow) for hardware, IoT, networking gear                                                           | Stable |
| Telnet       | Classic telnet with window-size and terminal-type negotiation, optional auto-login (unencrypted by design)                                          | Stable |
| Docker       | Start a new container from an image, open a shell in an already-running container, or target a Compose service (`project/service`)                  | Beta   |
| WSL          | Windows Subsystem for Linux distribution sessions (Windows only)                                                                                    | Stable |
| Remote agent | Persistent sessions on headless servers via auto-deployed `termihub-agent`                                                                          | Beta   |

## Files & transfer

| Capability           | Description                                                              | Status |
| -------------------- | ------------------------------------------------------------------------ | ------ |
| SFTP file browser    | Browse, upload, download, rename, delete remote files over SSH           | Stable |
| Local file browser   | Browse the local filesystem, following the active shell's cwd            | Stable |
| Other file browsers  | Browse Docker containers, WSL distributions, FTP servers and agent hosts | Stable |
| Built-in editor      | Monaco editor for local & remote files (syntax highlight, search, save)  | Stable |
| FTP / FTPS           | File-transfer connections with browse, upload, download, edit            | Beta   |
| Transfer queue       | Managed queue: concurrency limit, pause/resume, cancel, auto-retry       | Beta   |
| Drag-and-drop upload | Drop OS files or folders onto the SFTP browser to upload                 | Stable |
| Drag-to-move files   | Drag rows onto folders/breadcrumbs to move (Alt/Option copies); Move to… | Beta   |

## Tunnels & forwarding

| Capability        | Description                                                                                | Status       |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------ |
| Local forwarding  | `-L`-style local port forwarding with session pooling, set up in the SSH connection editor | Stable       |
| Remote forwarding | `-R`-style remote port forwarding, set up in the SSH connection editor                     | Stable       |
| Dynamic (SOCKS)   | Dynamic SOCKS5 / SOCKS4 / SOCKS4a proxy forwarding, set up in the SSH connection editor    | Stable       |
| SSH Tunnels view  | Separate sidebar for managing tunnels                                                      | Experimental |
| Jump hosts        | Connect through one or more bastion hosts (`ProxyJump`-style chains)                       | Stable       |
| X11 forwarding    | Forward remote GUI apps to a local X server                                                | Stable       |

## Network tools

The Network Tools view is experimental.

| Capability   | Description                                     | Status       |
| ------------ | ----------------------------------------------- | ------------ |
| Ping         | Live latency stats and chart                    | Experimental |
| Traceroute   | Hop-by-hop path tracing                         | Experimental |
| Port scanner | Scan a host/range for open TCP ports            | Experimental |
| DNS lookup   | Resolve hostnames / records                     | Experimental |
| HTTP monitor | Periodic HTTP checks with response-time history | Experimental |
| Wake-on-LAN  | Send magic packets to wake saved hosts          | Experimental |

## Embedded servers

Managed from the Services view, which is experimental.

| Capability  | Description                                                    | Status       |
| ----------- | -------------------------------------------------------------- | ------------ |
| HTTP server | Serve a local directory over HTTP with lifecycle management    | Experimental |
| FTP server  | Local FTP server for quick file transfer / device provisioning | Experimental |
| TFTP server | Local TFTP server for network-device provisioning              | Experimental |

## Remote desktop

| Capability        | Description                                                                                                         | Status       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | ------------ |
| RDP               | Graphical RDP session via the bundled `termihub-rdp-helper` sidecar, with audio redirection                         | Experimental |
| VNC               | Graphical VNC session with shared framebuffer + clipboard integration (no audio: RFB has no standard audio channel) | Experimental |
| VNC file transfer | Upload and browse files over the connection's SSH tunnel, agent, or a linked SSH connection                         | Experimental |

## Monitoring

| Capability          | Description                                                      | Status |
| ------------------- | ---------------------------------------------------------------- | ------ |
| Remote system stats | Real-time CPU, memory, disk, and network stats for SSH hosts     | Stable |
| Open Connections    | Central panel to inspect and kill sessions/tunnels/SFTP/monitors | Stable |

## UX & productivity

| Capability              | Description                                                                                                                                | Status       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| Split views             | Nested horizontal/vertical splits, drag-to-split                                                                                           | Stable       |
| Drag-and-drop tabs      | Reorder and move tabs between panels; per-tab colors; CWD tracking                                                                         | Stable       |
| Multi-window            | Tear tabs out into separate native windows                                                                                                 | Stable       |
| Workspaces / tab groups | Save and restore named layouts of connections and splits                                                                                   | Stable       |
| Session auto-restore    | Reopen previous sessions on launch, with a Recent Sessions list                                                                            | Stable       |
| Broadcast input         | Type once, mirror input across a group of terminals                                                                                        | Stable       |
| Command palette         | Searchable command launcher (Cmd+P or Cmd+Shift+P / Ctrl+Shift+P)                                                                          | Stable       |
| Find in terminal        | Search terminal output (Cmd+F / Ctrl+Shift+F)                                                                                              | Stable       |
| Prompt navigation       | Shell integration (OSC 133): jump between prompts, exit-status marks, copy last output                                                     | Stable       |
| Inline images           | SIXEL and iTerm2 inline images in the terminal                                                                                             | Stable       |
| Themes & layouts        | Dark / Light / Solarized / System themes, custom themes (Theme Editor, import/export), plugin themes; Default / Focus / Zen layout presets | Stable       |
| Connection management   | Folder hierarchies, search, import/export, external files, `${VAR}`                                                                        | Stable       |
| Log viewer              | In-app filterable/searchable log tab + durable rotated log file                                                                            | Stable       |
| Macros                  | Record, hand-author and replay terminal input sequences                                                                                    | Stable       |
| Plugin system           | Installable plugins, including signed native (cdylib) backends                                                                             | Beta         |
| Workflow automation     | Authored multi-step workflows with triggers                                                                                                | Experimental |

## Security

| Capability         | Description                                                                                                   | Status |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ------ |
| Credential storage | OS keychain, encrypted master-password vault, or prompt-only mode                                             | Stable |
| Auto-lock          | Configurable timeout for locking the credential store                                                         | Stable |
| Plugin trust model | Ed25519 signature / trust status for native plugins                                                           | Beta   |
| Plugin sandbox     | Native plugins are off by default; each runs in its own OS-sandboxed process                                  | Beta   |
| Backup & restore   | All app data, optionally the credential vault, in one passphrase-protected file                               | Stable |
| Biometric unlock   | Unlock the master-password vault with Touch ID / Windows Hello                                                | Stable |
| No telemetry       | No analytics; only an optional startup update-check (can be disabled) and an opt-in daily plugin update check | Stable |
