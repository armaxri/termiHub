# termiHub — feature matrix (draft)

> **Draft for review (MKT-2).** A compact capability matrix grouped by area, one line each.
> Status is honest: **Stable** = generally available; **Beta** = shipped but rough edges
> expected in v0.1.0; **Experimental** = behind **Settings → General → Allow Experimental
> Features**. Grounded in the current `README.md` and shipped code.

## Connections

| Capability   | Description                                                                                | Status |
| ------------ | ------------------------------------------------------------------------------------------ | ------ |
| Local shells | Auto-detected zsh / bash / sh, and PowerShell / cmd / Git Bash on Windows                  | Stable |
| SSH          | Key & password auth, jump-host / `ProxyJump` chains, X11 forwarding, tunneling, SFTP       | Stable |
| Serial       | Direct serial-port access (baud/data/stop/parity/flow) for hardware, IoT, networking gear  | Stable |
| Telnet       | Classic telnet with IAC protocol support (unencrypted by design)                           | Stable |
| Docker       | Start a new container from an image and open a shell in it (run-new; attach not supported) | Beta   |
| WSL          | Windows Subsystem for Linux distribution sessions (Windows only)                           | Stable |
| Remote agent | Persistent sessions on headless servers via auto-deployed `termihub-agent`                 | Beta   |

## Files & transfer

| Capability           | Description                                                             | Status |
| -------------------- | ----------------------------------------------------------------------- | ------ |
| SFTP file browser    | Browse, upload, download, rename, delete remote files over SSH          | Stable |
| Local file browser   | Browse the local filesystem, following the active shell's cwd           | Stable |
| Built-in editor      | Monaco editor for local & remote files (syntax highlight, search, save) | Stable |
| FTP / FTPS           | File-transfer connections with browse, upload, download, edit           | Beta   |
| Transfer queue       | Managed queue: concurrency limit, pause/resume, cancel, auto-retry      | Beta   |
| Drag-and-drop upload | Drop OS files onto the SFTP browser to upload                           | Stable |

## Tunnels & forwarding

| Capability        | Description                                                          | Status |
| ----------------- | -------------------------------------------------------------------- | ------ |
| Local forwarding  | `-L`-style local port forwarding with session pooling                | Stable |
| Remote forwarding | `-R`-style remote port forwarding                                    | Stable |
| Dynamic (SOCKS5)  | Dynamic SOCKS5 proxy forwarding                                      | Stable |
| Jump hosts        | Connect through one or more bastion hosts (`ProxyJump`-style chains) | Stable |
| X11 forwarding    | Forward remote GUI apps to a local X server                          | Stable |

## Network tools

| Capability   | Description                                     | Status |
| ------------ | ----------------------------------------------- | ------ |
| Ping         | Live latency stats and chart                    | Stable |
| Traceroute   | Hop-by-hop path tracing                         | Stable |
| Port scanner | Scan a host/range for open TCP ports            | Stable |
| DNS lookup   | Resolve hostnames / records                     | Stable |
| HTTP monitor | Periodic HTTP checks with response-time history | Stable |
| Wake-on-LAN  | Send magic packets to wake saved hosts          | Stable |

## Embedded servers

| Capability  | Description                                                    | Status |
| ----------- | -------------------------------------------------------------- | ------ |
| HTTP server | Serve a local directory over HTTP with lifecycle management    | Stable |
| FTP server  | Local FTP server for quick file transfer / device provisioning | Stable |
| TFTP server | Local TFTP server for network-device provisioning              | Stable |

## Remote desktop

| Capability | Description                                                           | Status       |
| ---------- | --------------------------------------------------------------------- | ------------ |
| RDP        | Graphical RDP session via the bundled `termihub-rdp-helper` sidecar   | Experimental |
| VNC        | Graphical VNC session with shared framebuffer + clipboard integration | Experimental |

## Monitoring

| Capability          | Description                                                      | Status |
| ------------------- | ---------------------------------------------------------------- | ------ |
| Remote system stats | Real-time CPU, memory, disk, and network stats for SSH hosts     | Stable |
| Open Connections    | Central panel to inspect and kill sessions/tunnels/SFTP/monitors | Stable |

## UX & productivity

| Capability              | Description                                                         | Status       |
| ----------------------- | ------------------------------------------------------------------- | ------------ |
| Split views             | Nested horizontal/vertical splits, drag-to-split                    | Stable       |
| Drag-and-drop tabs      | Reorder and move tabs between panels; per-tab colors; CWD tracking  | Stable       |
| Multi-window            | Tear tabs out into separate native windows                          | Stable       |
| Workspaces / tab groups | Save and restore named layouts of connections and splits            | Stable       |
| Session auto-restore    | Reopen previous sessions on launch, with a Recent Sessions list     | Stable       |
| Broadcast input         | Type once, mirror input across a group of terminals                 | Stable       |
| Command palette         | Searchable command launcher (Cmd+P / Ctrl+Shift+P)                  | Stable       |
| Themes & layouts        | Dark / Light / System themes; Default / Focus / Zen layout presets  | Stable       |
| Connection management   | Folder hierarchies, search, import/export, external files, `${VAR}` | Stable       |
| Log viewer              | In-app filterable/searchable log tab + durable rotated log file     | Stable       |
| Macros                  | Record and replay terminal input sequences                          | Stable       |
| Plugin system           | Installable plugins, including signed native (cdylib) backends      | Beta         |
| Workflow automation     | Authored multi-step workflows with triggers                         | Experimental |

## Security

| Capability         | Description                                                           | Status |
| ------------------ | --------------------------------------------------------------------- | ------ |
| Credential storage | OS keychain, encrypted master-password vault, or prompt-only mode     | Stable |
| Auto-lock          | Configurable timeout for locking the credential store                 | Stable |
| Plugin trust model | Ed25519 signature / trust status for native plugins                   | Beta   |
| No telemetry       | No analytics; only an optional startup update-check (can be disabled) | Stable |
