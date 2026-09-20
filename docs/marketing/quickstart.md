# termiHub — quickstart (draft)

> **Draft for review (MKT-3).** Install → first local shell → first SSH connection, using
> the real UI flow and the real scripts (`scripts/setup.sh`, `scripts/dev.sh`). Steps are
> verified against the current repo. `TODO(maintainer)` marks where screenshots help.

## 1. Get termiHub

### Option A — download a release (recommended for users)

Download the build for your platform from the
[GitHub Releases page](https://github.com/armaxri/termiHub/releases). Assets follow the
pattern `termiHub-<version>-<platform>.<ext>` (for example,
`termiHub-0.1.0-macos-arm64.dmg`).

> **Beta note:** v0.1.0 binaries are **unsigned**. On macOS, right-click the app →
> **Open** → **Open** on first launch. On Windows, click **More info → Run anyway** if
> SmartScreen warns. See the README's Installation section for the full per-platform steps.

### Option B — run from source (for contributors)

```bash
git clone https://github.com/armaxri/termiHub.git
cd termiHub
./scripts/setup.sh     # install deps + initial build
./scripts/dev.sh       # start dev mode with hot-reload
```

`./scripts/setup.sh` installs all frontend and Rust dependencies and does an initial build;
`./scripts/dev.sh` launches the app in development mode. See the README's Development
section for prerequisites (Node.js 18+, pnpm, Rust, and the Tauri v2 platform packages).

> TODO(maintainer): screenshot of the freshly-launched empty window (activity bar +
> sidebar + empty terminal view).

## 2. Open your first local shell

The fastest way to confirm everything works is a local terminal:

1. Open termiHub. You land in the VS Code-inspired three-column layout: **Activity Bar**
   (far left) → **Sidebar** → **Terminal View**.
2. Press the new-terminal shortcut — **Ctrl+Shift+`** (Win/Linux) or **Cmd+Shift+`**
   (macOS) — or click **New Terminal** in the toolbar.
3. A local shell opens as a tab, using your auto-detected shell (zsh/bash on macOS/Linux;
   PowerShell/cmd/Git Bash on Windows). Type a command such as `echo hello` to confirm.

You now have a working terminal. To save it as a reusable connection, use the flow below.

## 3. Create your first SSH connection

1. Click **Connections** in the Activity Bar, then the **+** button to add a connection.
2. Fill in the form:
   - **Name** — a label, e.g. `my-server`
   - **Type** — **SSH**
   - **Host** and **Port** (default `22`)
   - **Username**
   - **Auth Method** — **Password** (prompted at connect) or **SSH Key** (set **Key Path**,
     e.g. `~/.ssh/id_ed25519`)
3. Click **Save**.
4. **Double-click** the connection (or right-click → **Connect**) to open a session. With
   password auth, termiHub prompts for the password; it is not written to the config file.

> **Tip:** if you don't have an SSH key yet:
>
> ```bash
> ssh-keygen -t ed25519 -C "your_email@example.com"
> ssh-copy-id -i ~/.ssh/id_ed25519.pub user@hostname
> ```
>
> Then set **Auth Method → SSH Key** and **Key Path → `~/.ssh/id_ed25519`**. See the
> README's SSH Configuration section for platform-specific agent/keychain setup.

## 4. Browse remote files

Click on your open SSH tab — the sidebar file browser **auto-connects via SFTP** to that
host. From there you can browse, upload, download, create, rename, and delete files, and
double-click a file to edit it in the built-in Monaco editor (changes save back over SFTP).

> TODO(maintainer): screenshot of the SFTP browser + an open editor tab.

## 5. Go further

- **Split the view** — click **Split** in the toolbar, or drag a tab to a panel edge, to
  run sessions side by side.
- **Organize connections** — create folders and drag connections into them; color-code
  tabs to distinguish prod / staging / dev.
- **Open the command palette** — **Cmd+P** (macOS) / **Ctrl+Shift+P** (Win/Linux) to search
  and run any command.
- **Try a tunnel or a network tool** — set up local/remote/dynamic SSH forwarding, or run
  ping / traceroute / port scan / DNS / HTTP monitor / Wake-on-LAN from the Network Tools
  sidebar.

For the full usage guide, SSH options, serial setup, and troubleshooting, see the main
[README](../../README.md).
