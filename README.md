<p align="center">
  <img src="assets/icons/termihub-terminal-v2.svg" width="128" height="128" alt="TermiHub">
</p>

<h1 align="center">TermiHub</h1>

<p align="center">
A modern, cross-platform terminal hub for embedded development workflows.
</p>

---

TermiHub provides a VS Code-like interface for managing multiple terminal connections with support for split views, drag-and-drop tabs, and organized connection management. Built with Tauri, React, and Rust.

## Features

- **Multiple terminal types** — Local shells (zsh, bash, PowerShell, cmd, Git Bash), SSH, Telnet, and Serial
- **Split views** — Arrange terminals in horizontal and vertical splits with drag-and-drop
- **Connection management** — Organize connections in folder hierarchies with import/export
- **SSH file browser** — Browse, upload, download, and edit remote files via SFTP
- **X11 forwarding** — Forward remote GUI applications to your local X server
- **Built-in editor** — Edit local and remote files with syntax highlighting
- **Cross-platform** — Windows, Linux, and macOS

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

### Development

```bash
pnpm install
pnpm tauri dev
```

### Build

```bash
pnpm tauri build
```

## Documentation

See [CLAUDE.md](CLAUDE.md) for full architecture documentation, coding standards, and contribution guidelines.

## License

MIT
