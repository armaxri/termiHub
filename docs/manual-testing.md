# Manual Test Plan

This document describes manual test procedures for features that cannot be effectively automated. Run these tests before releases and after major changes.

## Test Environment Setup

- Build the app with `pnpm tauri dev` (development) or `pnpm tauri build` (release)
- For serial port tests, set up virtual serial ports with `socat` (see `examples/` and `docs/serial-setup.md`)
- For SSH/Telnet tests, use the Docker targets in `examples/` or real remote hosts
- For cross-platform tests, run on each target OS

---

## 1. Local Shell

| ID | Test | Prerequisites | Steps | Expected Result |
|---|---|---|---|---|
| LOCAL-01 | Platform shells detected | None | Open connection editor, select Local type | Shell dropdown shows shells available on current OS (zsh/bash/sh on macOS/Linux; PowerShell/cmd on Windows) |
| LOCAL-02 | Shell spawns correctly | None | Create and connect a local shell connection | Terminal opens, shell prompt appears, commands execute |
| LOCAL-03 | Terminal resize | Running local shell | Resize the app window or drag a split divider | Terminal re-renders correctly, no garbled output, `tput cols`/`tput lines` reports new size |
| LOCAL-04 | Process exit detection | Running local shell | Type `exit` in the shell | Terminal shows "[Process exited with code 0]" |
| LOCAL-05 | Initial command | None | Create a local connection with initial command "echo hello" | Terminal opens, shell starts, "hello" is printed automatically |
| LOCAL-06 | Home directory start | None | Create and connect a new local shell | `pwd` shows user home directory, not system root |

## 2. SSH

| ID | Test | Prerequisites | Steps | Expected Result |
|---|---|---|---|---|
| SSH-01 | Password auth | SSH server (e.g. Docker example) | Create SSH connection with password auth, connect | Password prompt appears, connection succeeds after entering password |
| SSH-02 | Key auth | SSH server + key pair | Create SSH connection with key auth, set key path, connect | Connection succeeds without password prompt |
| SSH-03 | Connection failure | None | Create SSH connection to non-existent host, connect | Error message displayed in terminal within reasonable timeout |
| SSH-04 | Terminal resize | Connected SSH session | Resize the app window | Remote shell reports updated dimensions |
| SSH-05 | Session output | Connected SSH session | Run commands that produce output (e.g. `ls -la`, `top`) | Output renders correctly in terminal |
| SSH-06 | Disconnect handling | Connected SSH session | Kill the SSH server or disconnect network | Terminal shows disconnection message |
| SSH-07 | X11 forwarding | SSH server with X11, local X server | Enable X11 forwarding, connect, run `xeyes` or `xclock` | GUI application window appears on local machine |

## 3. Serial

| ID | Test | Prerequisites | Steps | Expected Result |
|---|---|---|---|---|
| SERIAL-01 | Port enumeration | Serial port or virtual port via socat | Open connection editor, select Serial type | Port dropdown lists available serial ports |
| SERIAL-02 | Connect at common baud rates | Serial device or virtual port | Create serial connection at 9600/115200, connect | Connection opens, data exchange works |
| SERIAL-03 | Send and receive | Connected serial session | Type characters in terminal | Characters sent to device and echoed back (if device echoes) |
| SERIAL-04 | Disconnect handling | Connected serial session | Disconnect the serial device | Terminal shows error/disconnect message |
| SERIAL-05 | Config parameters | Serial device | Set non-default data bits, stop bits, parity, flow control | Connection works with configured parameters |

## 4. Telnet

| ID | Test | Prerequisites | Steps | Expected Result |
|---|---|---|---|---|
| TELNET-01 | Connect | Telnet server (e.g. Docker example) | Create Telnet connection, connect | Connection established, server banner displayed |
| TELNET-02 | Send and receive | Connected Telnet session | Type commands | Commands execute and output displays |
| TELNET-03 | Connection failure | None | Create Telnet connection to non-existent host | Error message displayed within reasonable timeout |

## 5. Tab Management

| ID | Test | Prerequisites | Steps | Expected Result |
|---|---|---|---|---|
| TAB-01 | Create tabs | None | Click New Terminal multiple times | Multiple tabs appear in tab bar, most recent is active |
| TAB-02 | Close tab | Multiple tabs open | Click X on a tab or use Ctrl+W | Tab removed, adjacent tab becomes active |
| TAB-03 | Drag reorder | Multiple tabs open | Drag a tab to a new position in the tab bar | Tab moves to new position, order persists |
| TAB-04 | Switch tabs | Multiple tabs open | Click different tabs, use Ctrl+Tab / Ctrl+Shift+Tab | Correct terminal displayed for each tab |
| TAB-05 | Context menu | Tab open | Right-click a tab | Context menu with Close, Copy, Save, Clear options |
| TAB-06 | Close last tab | Single tab in a split panel | Close the tab | Panel removed (if other panels exist) or empty panel remains |

## 6. Split Views

| ID | Test | Prerequisites | Steps | Expected Result |
|---|---|---|---|---|
| SPLIT-01 | Split horizontal | Terminal open | Click split button or use toolbar | Panel splits horizontally, new empty panel appears |
| SPLIT-02 | Split vertical | Terminal open | Hold Shift + click split (or toolbar option) | Panel splits vertically |
| SPLIT-03 | Close panel | Multiple panels | Close all tabs in a panel | Panel removed, remaining panels resize |
| SPLIT-04 | Resize divider | Split panels | Drag the divider between panels | Panels resize, terminals re-fit |
| SPLIT-05 | Drag-to-split | Tab and multiple panels | Drag tab to edge of another panel | New split created, tab moves to new panel |
| SPLIT-06 | Nested splits | Multiple panels | Create horizontal split, then split one panel vertically | Both horizontal and vertical splits coexist |

## 7. Connection Management

| ID | Test | Prerequisites | Steps | Expected Result |
|---|---|---|---|---|
| CONN-01 | Create connection | None | Click + in connection list, fill form, save | Connection appears in list |
| CONN-02 | Edit connection | Existing connection | Right-click > Edit, modify fields, save | Changes persisted, visible on next app restart |
| CONN-03 | Delete connection | Existing connection | Right-click > Delete | Connection removed from list |
| CONN-04 | Create folder | None | Right-click > New Subfolder (or toolbar) | Folder appears in connection tree |
| CONN-05 | Drag between folders | Connections and folders | Drag a connection to a different folder | Connection moves to target folder |
| CONN-06 | Import/Export | Existing connections | Export via Settings dropdown, import to fresh app | All connections and folders restored |
| CONN-07 | External files | JSON connection file | Add external file in Settings, enable it | External connections appear in tree under folder |
| CONN-08 | Env var placeholders | None | Create SSH connection with `${env:USER}` in username field | Placeholder expanded when connecting |
| CONN-09 | Password not stored | SSH connection with password auth | Connect, enter password, close app, check config file | Config file contains no password field for SSH connections |
| CONN-10 | Duplicate connection | Existing connection | Right-click > Duplicate | "Copy of <name>" appears in same folder |

## 8. File Browser

| ID | Test | Prerequisites | Steps | Expected Result |
|---|---|---|---|---|
| FILE-01 | Local browse | None | Switch to Files view, select Local mode | Local filesystem tree displayed |
| FILE-02 | SFTP browse | SSH connection | Connect SFTP via picker | Remote filesystem tree displayed |
| FILE-03 | Upload file | SFTP connected | Right-click > Upload or drag file from OS | File appears in remote listing |
| FILE-04 | Download file | SFTP connected | Right-click remote file > Download | File saved to local filesystem |
| FILE-05 | Create/Rename/Delete | SFTP or local browse | Create directory, rename file, delete file | Operations succeed, listing refreshes |
| FILE-06 | Auto-connect SFTP | SSH terminal tab open | Switch to Files view | SFTP auto-connects to the SSH host |
| FILE-07 | Open in editor | File visible in browser | Double-click a text file | File opens in built-in editor tab |
| FILE-08 | Open in VS Code | VS Code installed, file visible | Right-click > Open in VS Code | File opens in VS Code |

## 9. Cross-Platform

| ID | Test | Prerequisites | Steps | Expected Result |
|---|---|---|---|---|
| XPLAT-01 | Platform shells | Target OS | Check available shells in connection editor | Correct shells listed (zsh/bash/sh on Unix, PowerShell/cmd/Git Bash on Windows) |
| XPLAT-02 | Serial port paths | Serial port on target OS | Open serial port dropdown | Correct port naming convention (/dev/tty* on Unix, COM* on Windows) |
| XPLAT-03 | X11 forwarding | macOS or Linux with X server | Enable X11 forwarding on SSH connection | X11 forwarding works (not available on Windows) |

## 10. Settings & Editor

| ID | Test | Prerequisites | Steps | Expected Result |
|---|---|---|---|---|
| SET-01 | Settings tab | None | Click gear icon in activity bar | Settings tab opens (or existing one activates) |
| SET-02 | Editor save | File open in editor | Modify content, press Ctrl+S | File saved, dirty indicator clears |
| SET-03 | Editor status bar | File open in editor | Move cursor around | Status bar shows line, column, language, EOL, tab size |
| SET-04 | Tab coloring | Connection with color set | Connect to a colored connection | Tab shows assigned color |
| SET-05 | Horizontal scrolling | Connection with horizontal scrolling enabled | Connect, produce wide output | Terminal scrolls horizontally instead of wrapping |
