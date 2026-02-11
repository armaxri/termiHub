# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- VS Code-inspired dark theme with three-column layout (Activity Bar, Sidebar, Terminal View)
- Activity Bar with icon navigation for Connections, File Browser, and Settings views
- Sidebar with collapsible panel and view switching
- Connection List tree view with expandable folders and type-specific icons
- Connection Editor with forms for Local Shell, SSH, Serial, and Telnet connections
- File Browser with virtualized list, directory navigation, and file size display
- Terminal component with xterm.js integration and local echo demo mode
- Tab Bar with drag-and-drop reordering via dnd-kit
- Split View with resizable panels using react-resizable-panels
- Terminal toolbar with New Terminal, Split, and Close Panel actions
- Context menus on connections (Connect, Edit, Delete)
- Keyboard shortcuts: Ctrl+Shift+` (new terminal), Ctrl+W (close tab), Ctrl+Tab / Ctrl+Shift+Tab (switch tabs)
- Zustand-based state management for sidebar, panels, tabs, connections, and files
- Type definitions for terminals, connections, and events
- Real local shell terminals using PTY (zsh, bash, sh on Unix; PowerShell, cmd, Git Bash on Windows)
- Serial port connections with configurable baud rate, data bits, stop bits, parity, and flow control
- SSH connections with password and key-based authentication
- Telnet connections with basic IAC protocol handling
- Backend terminal management with session lifecycle, input/output streaming, and resize support
- Auto-detection of available shells on the current platform
- Auto-detection of available serial ports in the connection editor
- Terminal output streaming via Tauri events
- Process exit detection with "[Process exited]" indicator
- Error display in terminal when connection fails
- Connection persistence: saved connections and folders survive app restarts
- Connection import/export as JSON files
- Folder deletion with automatic reparenting of child connections and subfolders
- Context menu on folders with delete option
- SSH file browser with SFTP: browse, upload, download, rename, and delete remote files
- SFTP connection picker to connect to any saved SSH connection
- Directory creation via the file browser toolbar
- File permissions display (rwx) for remote entries
- Context menus on files (Download, Rename, Delete) and directories (Open, Rename, Delete)

- Right-click context menus on connections (Connect, Edit, Duplicate, Delete) and folders (New Connection, New Subfolder, Delete)
- Duplicate connection via context menu (creates "Copy of <name>" in the same folder)
- Drag-and-drop connections between folders to reorganize them
- Double-click a connection to connect directly

### Changed
- Connection and folder context menus now open on right-click instead of left-click
- Shell type dropdown in connection editor now only shows shells available on the current platform
