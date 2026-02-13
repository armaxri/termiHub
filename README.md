<p align="center">
  <img src="assets/icons/termihub-terminal-v2.svg" width="128" height="128" alt="TermiHub">
</p>

<h1 align="center">TermiHub</h1>

<p align="center">
A modern, cross-platform terminal hub for embedded development workflows.
</p>

<p align="center">
  <a href="https://github.com/armaxri/termiHub/actions/workflows/code-quality.yml"><img src="https://github.com/armaxri/termiHub/actions/workflows/code-quality.yml/badge.svg" alt="Code Quality"></a>
  <a href="https://github.com/armaxri/termiHub/actions/workflows/build.yml"><img src="https://github.com/armaxri/termiHub/actions/workflows/build.yml/badge.svg" alt="Build"></a>
  <a href="https://github.com/armaxri/termiHub/actions/workflows/release.yml"><img src="https://github.com/armaxri/termiHub/actions/workflows/release.yml/badge.svg" alt="Release"></a>
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

## Documentation

- **[User Guide](docs/user-guide.md)** — Interface overview, connections, tabs, splits, keyboard shortcuts, file browser, editor
- **[Building](docs/building.md)** — Platform-specific build and development instructions
- **[Serial Setup](docs/serial-setup.md)** — Serial port configuration per platform
- **[SSH Configuration](docs/ssh-configuration.md)** — SSH keys, X11 forwarding, SFTP
- **[Contributing](docs/contributing.md)** — Development workflow, coding standards, architecture
- **[Raspberry Pi](docs/raspberry-pi.md)** — ARM64 deployment and remote agent setup
- **[Releasing](docs/releasing.md)** — Release process and version management

For the full internal architecture documentation, see [CLAUDE.md](CLAUDE.md).

## License

MIT
