# termiHub User Guide

This guide covers the termiHub interface, features, and day-to-day usage.

---

## Interface Overview

termiHub uses a VS Code-inspired three-column layout:

```
┌──────────┬────────────────┬──────────────────────────────────────────┐
│ Activity │    Sidebar     │           Terminal View                  │
│   Bar    │                │  ┌──────┬──────┬──────┐                 │
│          │  Connections   │  │ Tab1 │ Tab2 │ Tab3 │                 │
│  [Con]   │  File Browser  │  ├──────┴──────┴──────┤                 │
│  [File]  │  Settings      │  │                    │                 │
│          │                │  │  Terminal Content   │                 │
│          │                │  │                    │                 │
│          │                │  │                    │                 │
│          │                │  └────────────────────┘                 │
│  [Gear]  │                │  Status Bar                             │
└──────────┴────────────────┴──────────────────────────────────────────┘
```

### Activity Bar

The narrow left-most column with icon buttons:

| Icon | View | Description |
|------|------|-------------|
| Network | Connections | Manage and open terminal connections |
| Folder | File Browser | Browse local and remote files |
| Gear (bottom) | Settings menu | Import/export connections, open settings |

Click an active icon to toggle (collapse/expand) the sidebar.

The **gear icon** at the bottom opens a dropdown menu with:
- **Settings** — Open the Settings tab
- **Import Connections** — Load connections from a JSON file
- **Export Connections** — Save all connections to a JSON file

### Sidebar

The middle column shows the view selected in the Activity Bar. It can be collapsed by clicking the active Activity Bar icon again.

### Terminal View

The main area on the right. Contains:
- **Tab Bar** — Tabs for open terminals, editors, and settings
- **Terminal Content** — The active terminal, editor, or settings panel
- **Terminal Toolbar** — New Terminal (+), Split, and Close Panel buttons
- **Status Bar** — Shows information about the active tab at the bottom

---

## Managing Connections

### Creating a Connection

1. Click the **Connections** icon in the Activity Bar
2. Click the **+** (New Connection) button in the sidebar toolbar
3. Fill in the connection details:
   - **Name** — Display name for the connection
   - **Folder** — Parent folder (or root)
   - **Type** — Local Shell, SSH, Serial, or Telnet
   - Type-specific settings (see below)
4. Click **Save**

### Editing and Deleting

- **Right-click** a connection to open the context menu:
  - **Connect** — Open in a new terminal tab
  - **Ping Host** — Ping the remote host (SSH and Telnet only)
  - **Edit** — Open the connection editor
  - **Duplicate** — Create a copy ("Copy of &lt;name&gt;")
  - **Delete** — Remove the connection

### Connecting

- **Double-click** a connection to connect immediately
- Or right-click and select **Connect**

### Organizing with Folders

- Click the **folder+** icon in the toolbar to create a root-level folder
- Right-click a folder to create subfolders or connections inside it
- **Drag and drop** connections between folders to reorganize
- Deleting a folder moves its children to the parent folder

### Import and Export

Export your connections to share them or back them up:

1. Click the **gear icon** in the Activity Bar
2. Select **Export Connections** to save to a JSON file
3. Select **Import Connections** to load from a JSON file

### External Connection Files

Load shared connection configs from external JSON files (e.g., from a git repository):

1. Open **Settings** from the gear menu
2. In the **External Connection Files** section:
   - Click **Add File** to select an existing JSON file
   - Click **Create File** to create a new external connection file
3. Toggle files on/off with the switch next to each file
4. External connections appear in the connection list with a special git-folder icon

External connections are read-only in the connection list — edit the JSON files directly.

### Environment Variable Placeholders

Use `${env:VAR}` syntax in any connection field to substitute environment variables at connect time. For example:

- Host: `${env:MY_SERVER_HOST}`
- Username: `${env:USER}`
- Key path: `${env:HOME}/.ssh/id_rsa`

This is useful for shared connection files where values differ per user.

---

## Connection Types

### Local Shell

Opens a local terminal using a shell installed on your system. termiHub auto-detects available shells:

- **macOS/Linux**: zsh, bash, sh
- **Windows**: PowerShell, cmd, Git Bash

Select the shell in the connection editor's **Shell** dropdown, which only shows shells available on your platform.

### SSH

Connects to a remote server via SSH. See [SSH Configuration](ssh-configuration.md) for detailed setup instructions.

**Settings:**
- **Host** — Hostname or IP address
- **Port** — SSH port (default: 22)
- **Username** — Remote username
- **Auth Method** — Password (prompted each time) or SSH Key (specify key path)
- **Enable X11 Forwarding** — Forward remote GUI applications to your local display

### Telnet

Connects to a remote server via the Telnet protocol.

**Settings:**
- **Host** — Hostname or IP address
- **Port** — Telnet port (default: 23)

### Serial

Connects to a serial device (USB-to-serial adapters, IoT devices, networking equipment, etc.). See [Serial Setup](serial-setup.md) for platform-specific instructions.

**Settings:**
- **Port** — Serial port path (auto-detected or manual entry)
- **Baud Rate** — 9600, 19200, 38400, 57600, 115200, 230400, 460800, or 921600
- **Data Bits** — 5, 6, 7, or 8
- **Stop Bits** — 1 or 2
- **Parity** — None, Odd, or Even
- **Flow Control** — None, Hardware (RTS/CTS), or Software (XON/XOFF)

---

## Terminal Options

Each connection has additional terminal options in the editor:

- **Enable horizontal scrolling** — Adds a horizontal scrollbar for wide terminal output
- **Tab Color** — Assign a color to the tab for visual identification

Both options can also be changed at runtime via the tab's right-click context menu.

---

## Terminal Tabs

### Tab Bar

Open terminals appear as tabs at the top of the terminal view. Each tab shows:
- A type-specific icon (terminal, wifi, cable, globe)
- The connection name
- An optional colored left border (if a tab color is set)
- A red dot indicator for unsaved editor files

### Tab Actions

- **Click** a tab to switch to it
- **Drag** tabs to reorder within the same panel
- **Drag** a tab to another panel to move it there
- **Drag** a tab to the edge of a panel to create a new split

### Tab Context Menu

Right-click a terminal tab for these options:
- **Save to File** — Export the terminal buffer to a text file
- **Copy to Clipboard** — Copy the entire terminal buffer
- **Clear Terminal** — Clear the terminal screen
- **Horizontal Scrolling** — Toggle horizontal scrollbar
- **Set Color...** — Open a color picker to set the tab color

---

## Split Views

termiHub supports splitting the terminal area into multiple panels arranged horizontally and vertically.

### Creating Splits

- Click the **Split** button (columns icon) in the terminal toolbar
- Or **drag a tab** to the top, bottom, left, or right edge of an existing panel

### Managing Splits

- **Drag the divider** between panels to resize them
- **Close Panel** (X button) removes a panel — its tabs move to an adjacent panel
- Splits can be nested: split horizontally within a vertical split, and vice versa

### Cross-Panel Tab Movement

Drag any tab from one panel and drop it:
- **On the tab bar** of another panel to move it there
- **On the edge** of another panel to create a new split with that tab

Drop zones are highlighted as you drag.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+`` (`` ` ``) | New local terminal |
| `Ctrl+W` / `Cmd+W` | Close active tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| `Ctrl+S` / `Cmd+S` | Save file (in editor) |

On macOS, `Cmd` can be used in place of `Ctrl` for the modifier shortcuts.

---

## File Browser

The file browser in the sidebar lets you browse local and remote filesystems.

### Modes

The file browser operates in three modes depending on the active terminal tab:

| Active Tab | Mode | Description |
|-----------|------|-------------|
| Local shell | Local | Browses the local filesystem |
| SSH | SFTP | Browses the remote server via SFTP |
| Serial / Telnet | None | File browser unavailable |
| Editor / Settings | Previous | Retains the last active mode |

When you switch to an SSH terminal tab, the SFTP connection is established automatically.

### Navigation

- Click a directory to open it
- Click the **Up** arrow to go to the parent directory
- The browser automatically follows the active terminal's working directory

### Toolbar

| Button | Description |
|--------|-------------|
| Up arrow | Navigate to parent directory |
| Refresh | Reload the current directory |
| Upload | Upload a file (SFTP mode only) |
| New File | Create an empty file |
| New Folder | Create a new directory |
| Disconnect | Disconnect SFTP session (SFTP only) |

### File and Directory Context Menu

Right-click a file or directory for options:

**Files:**
- **Edit** — Open in the built-in editor
- **Open in VS Code** — Open in external VS Code (downloads first if remote)
- **Download** — Download to local machine (SFTP mode only)
- **Rename** — Rename the file
- **Delete** — Delete the file

**Directories:**
- **Open** — Navigate into the directory
- **Rename** — Rename the directory
- **Delete** — Delete the directory

### Drag-and-Drop Upload

In SFTP mode, drag files from your operating system's file manager onto the file browser to upload them to the remote server.

### File Information

Each entry shows:
- File or directory name
- File size (formatted as B, KB, MB)
- File permissions in `rwx` notation (SFTP mode)

---

## Built-in File Editor

termiHub includes a built-in file editor powered by Monaco (the same engine as VS Code).

### Opening Files

- Double-click a file in the file browser
- Or right-click a file and select **Edit**

Files open in a new tab in the terminal view.

### Features

- **Syntax highlighting** — Automatic language detection from file extension
- **Search and replace** — Standard Ctrl+F / Ctrl+H
- **Word wrap** — Enabled by default
- **Dark theme** — Matches the termiHub dark theme

### Saving

- Press **Ctrl+S** (or **Cmd+S** on macOS) to save
- Or click the **Save** button in the editor toolbar
- Unsaved changes are indicated by a red dot on the tab
- Closing a tab with unsaved changes will prompt for confirmation

### Status Bar

When an editor tab is active, the status bar at the bottom shows:

| Item | Description |
|------|-------------|
| Ln / Col | Current cursor line and column |
| Language | Detected language mode |
| EOL | Line ending type (LF or CRLF) — click to toggle |
| Tab Size | Current tab size — click to cycle between 2 and 4 |
| Encoding | File encoding (UTF-8) |

### Open in VS Code

If VS Code is installed, you can right-click a file in the file browser and select **Open in VS Code**. For remote (SFTP) files, termiHub downloads the file to a temporary location first.

---

## Settings

### Opening Settings

Click the **gear icon** at the bottom of the Activity Bar, then select **Settings**. Settings open in a dedicated tab.

### Configuration Directory

termiHub stores its configuration (connections, folders, settings) in a platform-specific directory. Override this by setting the `TERMIHUB_CONFIG_DIR` environment variable before launching the app:

```bash
# Example: use a project-specific config directory
TERMIHUB_CONFIG_DIR=./my-project/termihub-config pnpm tauri dev
```

### External Connection Files

See [Managing Connections > External Connection Files](#external-connection-files) above for details on loading shared connection configs from external JSON files.

---

## Tips and Tricks

- **Quick connect**: Double-click any connection to open it immediately
- **Organize by project**: Use folders to group connections by project or environment
- **Color-code tabs**: Assign colors to distinguish between production, staging, and development connections
- **Share configs**: Use external connection files in a git repository so the whole team has the same connection list
- **Env var placeholders**: Use `${env:VAR}` in connection fields so shared configs work across different machines
- **Split for comparison**: Split the terminal view to compare output from two sessions side by side
- **Auto-SFTP**: The file browser automatically connects to the SFTP server when you click an SSH terminal tab — no manual connection needed
