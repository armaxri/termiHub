# Manual Tests Input

Collected manual test steps from PRs. These serve as a living checklist for regression testing and as candidates for future automated system tests.

Each section groups related tests by feature area. Individual test items reference the PR they originated from for traceability.

---

## Local Shell

### Default shell detection and labeling (PR #140)

- [x] Open connection editor for a local shell — the shell dropdown should show e.g. "Zsh (default)"
- [x] New terminals default to the correct system shell

### Configurable starting directory (PR #148)

- [ ] Create a local shell with no starting directory — verify it opens in home directory
- [ ] Create a local shell with starting directory set to `/tmp` — verify it opens in `/tmp`
- [ ] Create a local shell with `~/work` — verify tilde expansion works
- [ ] Create a local shell with `${env:HOME}/Desktop` — verify env var expansion works
- [ ] Edit an existing connection, add a starting directory, save and connect — verify it uses the new directory

### New tabs open in home directory (PR #66)

- [ ] Open the app and create a new local shell tab — verify it starts in `~`
- [ ] Verify the file browser shows the home directory after the first prompt
- [ ] Test on macOS/Linux (uses `$HOME`) and Windows (uses `%USERPROFILE%`) if possible

### macOS key repeat fix (PR #48)

- [ ] Launch TermiHub on macOS — open a local shell terminal
- [ ] Hold any letter key (e.g., `k`) — verify key repeats continuously
- [ ] Verify accent picker no longer appears when holding letter keys
- [ ] Verify system-wide setting is unchanged: `defaults read -g ApplePressAndHoldEnabled`
- [ ] Verify the app still builds on non-macOS (the code is `cfg`-gated)

### Doubled terminal text fix on macOS (PR #108)

- [ ] `pnpm tauri dev` — open terminal — verify prompt appears once, typing shows single characters, command output is not duplicated
- [ ] Open multiple terminals / split views — each terminal shows single output

### WSL shell detection on Windows (PR #139)

- [ ] Open connection editor — shell dropdown shows WSL distros (if WSL is installed)
- [ ] Select a WSL distro — WSL shell launches correctly in a new tab

### Windows shell WSL interception fix (PR #129)

- [ ] Create new local shell connection — verify shell dropdown defaults to PowerShell on Windows
- [ ] Open saved PowerShell connection — verify it launches PowerShell (not WSL)
- [ ] Open saved Git Bash connection — verify it launches Git Bash
- [ ] Press Ctrl+Shift+`` ` `` for new terminal — verify platform default shell opens

### WSL file browser follows CWD with OSC 7 injection (PR #154)

- [ ] Open WSL Ubuntu tab — file browser shows `//wsl$/Ubuntu/home/<user>`
- [ ] `cd /tmp` — file browser follows to `//wsl$/Ubuntu/tmp`
- [ ] `cd /mnt/c/Users` — file browser shows `C:/Users`
- [ ] Open WSL Fedora tab — no `clear: command not found`

---

## SSH

### SSH key authentication on Windows (PR #160)

- [ ] SSH key auth with Ed25519 key on Windows connects successfully
- [ ] SSH key auth with RSA key still works
- [ ] SSH password auth still works
- [ ] SSH agent auth still works

### OpenSSH-format private keys / Ed25519 (PR #134)

- [ ] SSH connect with Ed25519 key in OpenSSH format
- [ ] SSH connect with passphrase-protected key
- [ ] Legacy PEM-format key still works (no regression)

### SSH agent setup guidance (PR #133)

- [ ] Open connection editor, select SSH + Agent auth — warning appears if agent is stopped, normal hint if running
- [ ] Click "Setup SSH Agent" button — local PowerShell tab opens with elevation command
- [ ] SSH connect with agent auth when agent is stopped — helpful error in terminal

### Password prompt at connect (PR #38)

- [ ] Create an SSH connection with password auth — no password field in editor, hint text shown instead
- [ ] Right-click — Connect on a password-auth SSH connection — password dialog appears
- [ ] Enter password and click Connect — SSH terminal opens normally
- [ ] Click Cancel in password dialog — no tab is created
- [ ] SSH key-auth connections — no password dialog, connects directly
- [ ] SFTP connect to password-auth SSH — password dialog appears
- [ ] Inspect `connections.json` — no `password` field present for any SSH connection
- [ ] Export connections — no passwords in exported JSON
- [ ] Existing connections with stored passwords — passwords stripped on app startup

### X11 forwarding (PR #69)

- [ ] Connect via "Docker SSH + X11" example connection
- [ ] Run `xclock` or `xeyes` — window appears on local display
- [ ] Verify `echo $DISPLAY` shows `localhost:N.0` on remote
- [ ] Connect without X11 enabled — SSH works normally
- [ ] Enable X11 without local X server — SSH connects with graceful degradation
- [ ] Existing saved connections without the new field load correctly

### Auto-connect monitoring on SSH tab switch (PR #163)

- [ ] Open an SSH terminal tab — monitoring stats appear automatically in the status bar
- [ ] Switch between two SSH tabs connected to different hosts — monitoring switches hosts
- [ ] Manual "Monitor" dropdown still works as a fallback

### SSH monitoring in status bar (PR #114, #115)

- [ ] Status bar left section shows "Monitor" button with Activity icon
- [ ] Clicking "Monitor" opens dropdown listing all saved SSH connections
- [ ] Selecting a connection connects monitoring, shows inline stats
- [ ] Stats auto-refresh every 5 seconds
- [ ] Refresh and disconnect icon buttons work
- [ ] High values show warning (yellow >= 70%) and critical (red >= 90%) colors
- [ ] Activity bar no longer shows monitoring icon
- [ ] Sidebar no longer has monitoring view
- [ ] Save & Connect button saves and opens terminal in one action
- [ ] After connecting, status bar displays: hostname, CPU%, Mem%, Disk%
- [ ] Clicking hostname opens detail dropdown with system info, refresh, and disconnect
- [ ] Disconnecting returns to the "Monitor" button state

### Ping host context menu (PR #37)

- [x] Right-click an SSH connection with a host configured — "Ping Host" appears between "Connect" and "Edit"
- [x] Right-click a Telnet connection — "Ping Host" appears
- [x] Right-click a Local or Serial connection — no "Ping Host" item
- [x] Click "Ping Host" — new terminal tab opens titled "Ping <host>" running `ping <host>`
- [x] Existing "Connect" action still works as before

### Environment variable expansion in connections (PR #68)

- [ ] Create an SSH connection with username `${env:USER}` — connect — resolves to actual username
- [ ] Create a local shell with initial command `echo ${env:HOME}` — prints home directory
- [ ] Use an undefined variable `${env:NONEXISTENT}` — left as-is, no crash
- [ ] Verify saved connection JSON still contains literal `${env:USER}` (not expanded)

---

## Serial

### Nerd Font / Powerline glyph support (PR #131)

- [ ] SSH to a host running zsh with the agnoster theme — Powerline glyphs render correctly instead of boxes
- [ ] Verify on a clean Windows machine without any Nerd Font installed locally

---

## Telnet

### Docker Telnet connection (PR #40)

- [x] Connect to Docker Telnet (port 2323) — login prompt works with `testuser`/`testpass`

---

## Tab Management

### Rename terminal tab (PR #156)

- [ ] Right-click terminal tab — "Rename" appears — renaming works
- [ ] Right-click inside terminal area — full context menu appears with same options

### Tab coloring with color picker (PR #67)

- [ ] Right-click a terminal tab — "Set Color..." — pick a color — verify tab shows colored left border and terminal has colored frame
- [ ] Clear the color — verify indicators are removed
- [ ] Edit a connection — set a color — connect — verify tab starts with that color
- [ ] Close and reopen a colored connection — verify color persists
- [ ] Override a persisted color via context menu — verify runtime color takes effect

### Clear terminal via context menu (PR #34)

- [ ] Right-click a terminal tab — context menu with "Clear Terminal" appears
- [ ] Click "Clear Terminal" — terminal scrollback is cleared
- [ ] Right-click the Settings tab — no context menu appears
- [ ] Drag-and-drop tabs still works correctly

### Save terminal content to file (PR #35)

- [ ] Right-click a terminal tab — context menu shows "Save to File" above "Clear Terminal"
- [ ] Click "Save to File" — native save dialog opens with default filename `terminal-output.txt`
- [ ] Choose a location — file is written with the terminal's text content
- [ ] Cancel the dialog — nothing happens
- [ ] Settings tab still has no context menu

### Copy terminal content to clipboard (PR #36)

- [ ] Right-click a terminal tab — context menu shows "Save to File", "Copy to Clipboard", "Clear Terminal" in that order
- [ ] Click "Copy to Clipboard" — paste elsewhere to verify terminal content is on the clipboard
- [ ] "Save to File" still works as before (regression check)
- [ ] Settings tab has no context menu (unchanged behavior)

### Suppress browser default context menu (PR #150)

- [ ] Right-click on empty areas (sidebar whitespace, terminal, activity bar) — no menu appears
- [ ] Right-click on a connection — custom context menu still works
- [ ] Right-click on a tab — custom context menu still works

### Per-connection horizontal scrolling (PR #45)

- [ ] Create connection with horizontal scrolling enabled — connect — run `echo $(python3 -c "print('A'*300)")` — line should not wrap, horizontal scrollbar appears
- [ ] Create connection without horizontal scrolling — same command — line wraps normally
- [ ] Right-click tab — "Horizontal Scrolling" toggle — behavior switches dynamically
- [ ] Hold a key down — key repeat works normally in horizontal scroll mode
- [ ] Close and reopen app — connection setting persists
- [ ] Resize window/panels — scroll area adjusts correctly

### Dynamic horizontal scroll width update (PR #49)

- [ ] `pnpm build` — no TypeScript errors
- [ ] Open terminal — enable horizontal scrolling — run a command producing wide output (e.g. `ls -la /usr/bin`) — scrollbar should expand automatically after output settles
- [ ] Hold a key (e.g. `k`) — key should repeat without interruption
- [ ] Run `clear` — scroll width should shrink back to viewport width
- [ ] Toggle horizontal scrolling off/on — still works as before

---

## Connection Management

### Connection editor as tab (PR #109)

- [ ] Click "New Connection" in sidebar — editor opens as a tab in the panel area
- [ ] Right-click a connection — Edit — editor tab opens with "Edit: <name>" title
- [ ] Save a connection — tab closes and connection is persisted
- [ ] Cancel — tab closes without saving
- [ ] Open multiple editor tabs simultaneously for different connections
- [ ] Re-clicking Edit on an already-open connection activates the existing tab

### Remove folder selector from editor (PR #146)

- [ ] Open connection editor — verify no "Folder" dropdown is shown
- [ ] Right-click a folder — "New Connection" — save — verify connection is placed in that folder
- [ ] Drag a connection onto a folder in the sidebar — verify it moves correctly
- [ ] Edit an existing connection in a folder — save — verify it stays in the same folder

### Shell-specific icons and icon picker (PR #157)

- [ ] Open a PowerShell tab — verify biceps icon appears in tab bar and drag overlay
- [ ] Open a Git Bash tab — verify git branch icon appears
- [ ] Open a WSL tab — verify penguin icon appears
- [ ] Edit a saved connection — click "Set Icon" — search for an icon — apply — verify icon shows in sidebar and tab
- [ ] Search "arm" in the icon picker — verify BicepsFlexed appears
- [ ] Clear a custom icon — verify default icon is restored

### Save & Connect button (PR #112)

- [ ] Open New Connection — fill form — click "Save & Connect" — connection is saved AND a terminal tab opens
- [ ] Edit existing SSH connection — click "Save & Connect" — password prompt appears — connection opens after password entry
- [ ] Click "Save & Connect" with password auth, cancel password prompt — editor tab stays open (connect aborted, but save already completed)
- [ ] Existing "Save" and "Cancel" buttons still work as before

### Import/export in settings gear dropdown (PR #33)

- [ ] Click the Settings gear in the activity bar — dropdown menu appears with three items
- [ ] Click "Settings" — settings tab opens
- [ ] Click "Import Connections" — file open dialog, imports JSON, connection list refreshes
- [ ] Click "Export Connections" — file save dialog, saves JSON
- [ ] Connection list toolbar no longer has Import/Export buttons (only New Folder and New Connection remain)

### External connection file support (PR #50)

- [ ] Settings tab — "External Connection Files" section visible
- [ ] "Create File" — enter name — save dialog — empty JSON file created and auto-added to list
- [ ] "Add File" — native file picker — select JSON — path appears in list with toggle
- [ ] Connection list shows external source as collapsible group with `FolderGit2` icon
- [ ] External connections: create, edit, duplicate, delete via context menu
- [ ] External folders: create, delete via context menu and header buttons
- [ ] Drag-and-drop connections between local and external sources
- [ ] Toggle file disabled — connections disappear after reload
- [ ] Remove file — connections disappear
- [ ] Malformed/missing JSON — error indicator on source group header
- [ ] Local connections still fully editable/draggable/deletable (no regressions)
- [ ] Both "Connections" and external groups independently collapsible

---

## File Browser

### CWD-aware file browser (PR #39)

- [ ] Open a local zsh terminal — `cd /tmp` — sidebar file browser shows `/tmp` contents
- [ ] Open a second local shell tab — switch between tabs — file browser follows each tab's CWD
- [ ] Open an SSH terminal — file browser auto-connects SFTP (with password prompt) and shows remote CWD
- [ ] Open a serial terminal — file browser shows "no filesystem" placeholder
- [ ] Switch sidebar to connections view — switch tabs — switch back to files — correct CWD shown
- [ ] Right-click rename/delete on local files — operations work and list refreshes
- [ ] Create directory via toolbar button — works for both local and SFTP modes

### Local file explorer stuck at root fix (PR #110)

- [ ] Open a local terminal, click Files sidebar — file list shows home directory contents
- [ ] Test with bash (no OSC 7) — still loads home directory
- [ ] Navigate away and back — does not re-navigate if entries already loaded

### File browser stays active when editing (PR #57)

- [ ] Open a local file for editing — file browser shows the file's parent directory
- [ ] Open a remote (SFTP) file for editing — file browser shows the remote parent directory
- [ ] Switch between editor and terminal tabs — file browser updates correctly
- [ ] Settings tab still shows "No filesystem available" as before

### New File button (PR #58)

- [ ] Click "New File" button — inline input appears — type name — Enter — file created and list refreshes
- [ ] Press Escape in the input — cancels without creating
- [ ] Works in local file browser mode
- [ ] Works in SFTP file browser mode
- [ ] "New Folder" still works as before

### Right-click context menu (PR #59)

- [ ] Right-click a file — context menu appears with Edit, Open in VS Code, Rename, Delete
- [ ] Right-click a directory — context menu appears with Open, Rename, Delete
- [ ] Right-click in SFTP mode — Download option appears for files
- [ ] Three-dots menu still works as before
- [ ] Context menu actions (edit, rename, delete, etc.) all function correctly
- [ ] Menu styling matches connection list context menus

### Open in VS Code (PR #51)

- [ ] File browser (local mode) — right-click file — "Open in VS Code" visible — opens file in VS Code
- [ ] File browser (SFTP mode) — right-click file — "Open in VS Code" — file opens — edit and close tab — file re-uploaded (verify content changed on remote)
- [ ] VS Code not installed — "Open in VS Code" menu item does not appear
- [ ] SFTP session lost during edit — error event emitted, no crash

### Double-click file to open in editor (PR #61)

- [ ] Double-click a file in local file browser — opens in editor tab
- [ ] Double-click a file in SFTP file browser — opens in editor tab
- [ ] Double-click a directory — navigates into it (unchanged behavior)

---

## Editor

### Built-in file editor with Monaco (PR #54)

- [ ] Right-click a file in the local file browser — "Edit" — file opens in editor tab with syntax highlighting
- [ ] Edit content — tab shows dirty dot — Ctrl+S — saves — dirty dot clears
- [ ] Click Save button in toolbar — same behavior as Ctrl+S
- [ ] Close dirty tab — confirmation dialog appears — Cancel keeps tab open, OK closes it
- [ ] Close clean tab — no confirmation dialog
- [ ] Open same file twice — reuses existing editor tab instead of creating a new one
- [ ] SFTP file browser — right-click file — "Edit" — remote file loads with [Remote] badge — edit + save works
- [ ] Binary/non-UTF-8 file — graceful error message displayed
- [ ] Editor tab drag-and-drop between panels works correctly

### Editor status bar (PR #65)

- [ ] Open a `.ts` file — status bar shows: `Ln 1, Col 1  Spaces: 4  UTF-8  LF  typescript`
- [ ] Move cursor — Ln/Col updates in real-time
- [ ] Click "Spaces: 4" — changes to "Spaces: 2", editor indentation updates
- [ ] Click "LF" — changes to "CRLF"
- [ ] Switch to a terminal tab — status bar items disappear
- [ ] Switch back to editor tab — items reappear with correct values
- [ ] Close editor tab — status bar clears

### Indent selection in status bar (PR #111)

- [ ] Open a file in the editor, click the indent indicator in the status bar — dropdown appears with "Indent Using Spaces" (1/2/4/8) and "Indent Using Tabs" (1/2/4/8)
- [ ] Selecting an option updates the editor behavior and the status bar label
- [ ] Label correctly shows "Spaces: N" or "Tab Size: N"

### Language mode selector (PR #113)

- [ ] Open a file in the editor, click the language name in the status bar — dropdown appears with search input and all available languages
- [ ] Typing filters the list in real-time
- [ ] Selecting a language updates syntax highlighting and the status bar label
- [ ] Dropdown closes on selection or clicking outside

---

## UI / Layout

### Status bar (PR #30)

- [ ] Run `npm run build` — no compile errors
- [ ] Launch the app and verify the status bar appears at the bottom spanning the full window width
- [ ] Verify existing layout (Activity Bar, Sidebar, Terminal View) is unaffected

### Settings as tab (PR #32)

- [ ] Click Settings — a "Settings" tab opens with content
- [ ] Click Settings again — reactivates existing settings tab (no duplicate)
- [ ] Close the settings tab — it's removed like any other tab
- [ ] Drag the settings tab between panels — works with correct Settings icon
- [ ] Connections and File Browser sidebar views still work normally

### Settings button at bottom of activity bar (PR #31)

- [ ] Settings gear icon appears at the bottom of the activity bar
- [ ] Connections and File Browser icons remain at the top
- [ ] Clicking the settings icon still toggles the sidebar settings view

### Black bar at bottom of terminal fix (PR #130)

- [ ] Terminal tabs no longer show a black bar at the bottom
- [ ] Resizing window/split panels — terminal fills correctly
- [ ] Settings tab unaffected

### Custom app icon (PR #70)

- [ ] `ls -la src-tauri/icons/` — all 16 PNGs + .icns + .ico present with reasonable sizes
- [ ] Open `public/termihub.svg` in browser — shows TermiHub icon
- [ ] `pnpm tauri dev` — app icon in dock/taskbar is the custom icon, favicon in browser tab is TermiHub
- [ ] `icon/` directory is gone
- [ ] README renders correctly on GitHub with centered icon

---

## Remote Agent

### Redesign remote agent as parent folder with child sessions (PR #164)

- [ ] Create a remote agent entry — connect — see available shells/ports in expanded folder
- [ ] Create a shell session under agent — terminal tab opens
- [ ] Disconnect agent — reconnect — persistent sessions re-attach
- [ ] Agent context menu actions all work (connect/disconnect/new session/edit/delete)

### Wire RemoteBackend into TerminalManager and UI (PR #106)

- [ ] Create a "Remote Agent" connection in the UI, verify settings form renders, verify connection attempt produces terminal output or error (not a crash)

### RemoteBackend and session reconnect (PR #87)

- [ ] Connect to Raspberry Pi running `termihub-agent --stdio`
- [ ] Verify terminal output appears for shell and serial sessions
- [ ] Kill SSH connection, verify "reconnecting" indicator and auto-reconnect
- [ ] Close tab, verify cleanup (no orphan threads)

### TCP listener mode and systemd (PR #116)

- [ ] `cargo run -- --listen` starts and listens on 127.0.0.1:7685
- [ ] Connect with `nc localhost 7685`, send initialize JSON-RPC, get response
- [ ] Disconnect and reconnect — sessions persist
- [ ] `kill -TERM <pid>` causes graceful shutdown
- [ ] `cargo run -- --stdio` still works as before

---

## Infrastructure

### Docker test environment and virtual serial (PR #40)

- [ ] `cargo build` — no compile errors
- [ ] `./examples/scripts/start-test-environment.sh` — Docker containers start, app launches with test config
- [ ] Connect to Docker SSH (port 2222) — prompted for password, connects with `testuser`/`testpass`
- [ ] `./examples/scripts/stop-test-environment.sh` — containers stop cleanly
- [ ] `./examples/scripts/setup-virtual-serial.sh` — creates `/tmp/termihub-serial-a` and `/tmp/termihub-serial-b`
- [ ] `TERMIHUB_CONFIG_DIR=/tmp/test-config pnpm tauri dev` — app uses override directory

---

## Performance

### Stress test for 40 concurrent terminals (PR #88)

- [ ] Run `pnpm test:e2e:perf` on Linux (requires `tauri-driver` and a built app via `pnpm tauri build`)
- [ ] Verify all 4 test cases pass and performance baselines are logged to console
- [ ] Verify `pnpm test:e2e` still runs existing tests without regression

---

## Documentation

### User and developer documentation (PR #72)

- [ ] Verify all internal cross-links between docs resolve correctly
- [ ] Verify keyboard shortcuts table matches `src/hooks/useKeyboardShortcuts.ts`
- [ ] Verify serial config options match `src/components/Settings/SerialSettings.tsx`
- [ ] Verify SSH settings match `src/components/Settings/SshSettings.tsx`
- [ ] Verify README renders correctly on GitHub

### E2E test suite setup (PR #82)

- [ ] `pnpm tauri build` then `pnpm test:e2e` against built app (requires `cargo install tauri-driver`)
